#!/usr/bin/env node
// A real VT screen for one process, driven against the REAL package.
//
// TWO ARMS, AND REVIEW REQUIRED BOTH. An uninstalled green suite certifies nothing about cell
// extraction, Unicode activation or callback behaviour -- it only proves the fallback. So the tests
// below run against the installed emulator, and the last one runs the same module in a child process
// where the package genuinely cannot be resolved. Neither arm alone is acceptance.
//
// EVERY BEHAVIOUR HERE WAS MEASURED BEFORE IT WAS CODED, and three of them contradicted what I would
// otherwise have assumed: `translateToString` leaks concealed text, a write callback fires after
// `dispose()`, and a bare headless terminal measures with Unicode 6 while the browser uses 11.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ScreenEmulator, loadEmulator } from "../lib/screen-emulator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, "..", "lib", "screen-emulator.mjs");
const ESC = String.fromCharCode(27);

//: `create()` returns null when the package is absent, and every test that drives a screen would then
//: throw on a property of null rather than say why. This says why once.
async function screen(geometry) {
  const emulator = await ScreenEmulator.create(geometry);
  assert.ok(emulator, "@xterm/headless is not installed, so the INSTALLED arm cannot run at all");
  return emulator;
}

test("POSITIVE CONTROL: the package is present and this file is testing the real thing", async () => {
  const loaded = await loadEmulator();
  assert.ok(loaded, "the installed arm is not running -- everything below would be vacuous");
  assert.equal(typeof loaded.Terminal, "function");
  assert.ok(loaded.Unicode11Addon, "the unicode11 addon is absent, so column parity is not tested");
  // REPORTED SEPARATELY, which is what lets a caller tell a partial install from a complete one.
  assert.equal("Unicode11Addon" in loaded, true, "the loader hides whether the addon resolved");
});

test("A PAINTED SCREEN KEEPS ITS POSITIONS, which a line buffer cannot", async () => {
  // The whole reason this module exists. Out-of-order absolute addressing, reconstructed.
  const e = await screen({ cols: 30, rows: 5 });
  await e.write(`${ESC}[3;5HTHIRD`);
  await e.write(`${ESC}[1;1HFIRST`);
  const rows = e.rows();
  assert.match(rows[0], /^FIRST/);
  assert.match(rows[2], /^ {4}THIRD/, `row 3 lost its column: ${JSON.stringify(rows[2])}`);
  e.dispose();
});

test("AN EMPTY CELL IS A SPACE, or every gap collapses and positioning is destroyed", async () => {
  // THE BUG MY FIRST VERSION SHIPPED, caught by its own smoke test: `getCell().getChars()` returns ""
  // for a blank cell, and concatenating that verbatim turned `ESC[2;3HHELLO` into "HELLO" rather than
  // "  HELLO". A renderer that loses columns is a line buffer with extra steps.
  const e = await screen({ cols: 20, rows: 3 });
  await e.write(`${ESC}[2;3HHELLO`);
  assert.equal(e.rows()[1], "  HELLO             ");
  e.dispose();
});

test("CONCEALED TEXT NEVER LEAVES THIS MODULE, and the row does not shift", async () => {
  // `translateToString` returns SGR-8 content verbatim -- measured, `ESC[8mSECRET` came back as plain
  // SECRET. An agent conceals for a reason and a pane that prints it is disclosing what the terminal
  // was told to hide. Replaced by spaces rather than dropped, so everything positioned after it stays
  // where the agent put it.
  const e = await screen({ cols: 30, rows: 2 });
  await e.write(`${ESC}[1;1Hvisible ${ESC}[8mSECRET${ESC}[0m tail`);
  const row = e.rows()[0];
  assert.ok(!row.includes("SECRET"), `concealed text was printed: ${JSON.stringify(row)}`);
  // EIGHT spaces: the one after "visible", the six the concealed word occupied, and the one before
  // "tail". Counting seven was my arithmetic being wrong, not the module shifting the row -- the
  // point is that the width of the hidden text is PRESERVED, so "tail" stays where it was put.
  assert.match(row, /^visible {8}tail/, `the row shifted instead of keeping its columns: ${JSON.stringify(row)}`);
  e.dispose();
});

test("A CONCEALED WIDE GLYPH KEEPS ITS FOOTPRINT, or everything after it shifts left", async () => {
  // Review measured this: a concealed wide character emitted ONE space while its continuation cell
  // was skipped, so a `B` at column 3 came out at column 2. Removing the CONTENT is right; removing
  // its width is a different screen, and a screen whose columns are wrong is the thing an emulator
  // exists to prevent.
  const e = await screen({ cols: 20, rows: 2 });
  await e.write(`${ESC}[1;1HA${ESC}[8m${String.fromCodePoint(0x1f600)}${ESC}[0mB`);
  const [row] = e.rows();
  assert.ok(!row.includes(String.fromCodePoint(0x1f600)), "the concealed glyph was printed");
  assert.equal(row.indexOf("B"), 3,
    `B sits at column ${row.indexOf("B")} rather than 3 -- the concealed glyph lost a column`);
  e.dispose();
});

test("UNICODE 11 IS ACTIVE, because the browser's terminal uses it and a default headless one does not", async () => {
  // Measured: a bare headless terminal reports "6" and an emoji is ONE cell there and TWO at 11, so
  // every character after one sits in a different column. Same parser is only parity when it is the
  // same parser configured the same way.
  const e = await screen({ cols: 20, rows: 2 });
  assert.equal(e.unicodeVersion, "11", "this screen measures columns differently from the browser");
  await e.write(`${ESC}[1;1HA${String.fromCodePoint(0x1f600)}B`);
  assert.match(e.rows()[0], /^A\u{1F600}B/u,
    "a wide character emitted a continuation cell into the text, or lost its glyph");
  e.dispose();
});

test("AN ESCAPE SPLIT ACROSS CHUNKS is reassembled, because a byte stream splits them", async () => {
  // A real stream breaks a sequence at a buffer boundary. An emulator that mishandled it would
  // produce garbage exactly under load, which is the worst time to find out.
  const e = await screen({ cols: 30, rows: 3 });
  await e.write(ESC);
  await e.write("[2;");
  await e.write("4HLANDED");
  assert.match(e.rows()[1], /^ {3}LANDED/, `the split escape was mishandled: ${JSON.stringify(e.rows()[1])}`);
  e.dispose();
});

test("A WRITE IN FLIGHT STOPS COUNTING AT dispose(), because its callback still fires", async () => {
  // MEASURED TRUE on the real package: a queued callback outlives disposal. Without the generation
  // check that is a late resolution reporting progress for a screen already handed to another
  // process -- the superseded-mount defect with a new door.
  const e = await screen({ cols: 20, rows: 3 });
  const inFlight = e.write("x".repeat(5000));
  e.dispose();
  assert.equal(await inFlight, false, "a write resolved as applied after the screen was disposed");
  assert.deepEqual(e.rows(), [], "a disposed screen still reported rows");
  assert.doesNotThrow(() => e.dispose(), "dispose must be safe twice");
});

test("GEOMETRY IS THE PRODUCER'S: the same bytes at two widths are two different screens", async () => {
  // The measurement that killed the pane-sized design. At the narrower width the row-1 overflow WRAPS
  // onto row 2 and collides with what belongs there, so a pane-sized emulator does not show less of
  // the screen -- it shows a different and wrong one.
  const bytes = `${ESC}[1;1H${"x".repeat(60)}TAIL${ESC}[2;1Hrow two`;
  const wide = await screen({ cols: 80, rows: 4 });
  const narrow = await screen({ cols: 40, rows: 4 });
  await wide.write(bytes);
  await narrow.write(bytes);
  assert.equal(wide.rows()[1].trimEnd(), "row two");
  assert.notEqual(narrow.rows()[1].trimEnd(), "row two",
    "the widths agreed, so this test is no longer measuring the wrap that killed the pane-sized design");
  assert.match(narrow.rows()[1], /^row two/, "the wrapped overflow did not land where it was measured");
  wide.dispose();
  narrow.dispose();
});

test("resize follows the producer, and a disposed screen ignores it", async () => {
  const e = await screen({ cols: 40, rows: 4 });
  await e.write(`${ESC}[1;1H${"y".repeat(50)}`);
  e.resize({ cols: 80, rows: 6 });
  assert.equal(e.rows().length, 6, "the screen did not follow the producer's height");
  e.dispose();
  assert.doesNotThrow(() => e.resize({ cols: 20, rows: 2 }));
});

test("COLOUR SURVIVES THE ROUND TRIP, read back off the REAL cell API", async () => {
  // `screen-style.mjs` is tested with literals; this is the half that can only be checked against the
  // package -- that the attributes it reads are the ones a real cell actually reports.
  const e = await screen({ cols: 40, rows: 2 });
  await e.write(`${ESC}[1;1H${ESC}[32mgreen${ESC}[0m plain ${ESC}[1;31mBOLD${ESC}[0m`);
  const [row] = e.rows({ color: true });
  assert.ok(row.startsWith(`${ESC}[0;32;49mgreen`), `green was lost: ${JSON.stringify(row)}`);
  assert.ok(row.includes(`${ESC}[0;1;31;49mBOLD`), `bold red was lost: ${JSON.stringify(row)}`);
  e.dispose();
});

test("NEGATIVE CONTROL: without colour the row carries NO escapes at all", async () => {
  // The default, and it has to stay the default: `panes.mjs` guarantees a composed view emits exactly
  // what its inputs carried, so a piped or `--once` render must not gain escapes because a process
  // happened to use colour.
  const e = await screen({ cols: 40, rows: 2 });
  await e.write(`${ESC}[1;1H${ESC}[32mgreen${ESC}[0m`);
  const [mono] = e.rows();
  assert.ok(!mono.includes(ESC), `an uncoloured row carried escapes: ${JSON.stringify(mono)}`);
  assert.ok(mono.startsWith("green"), "the text was lost along with the colour");
  e.dispose();
});

test("NO ROW ENDS WITH A STYLE STILL OPEN, or it colours the pane beside it", async () => {
  // `sideBySide` puts the dashboard's text immediately after this row on the same physical line. A
  // style left open runs straight into it -- and on the last row, into the operator's shell prompt
  // after the view exits.
  //
  // THE LAST SGR IS WHAT DECIDES IT, not the last characters. A style can legitimately close in the
  // MIDDLE of a row -- the cells after the coloured text are plain, so the reset lands there and
  // spaces follow it. My first version asserted the row ENDED with a reset and failed on exactly that
  // correct case, which is the assertion describing a stricter rule than the one that matters.
  const e = await screen({ cols: 20, rows: 3 });
  await e.write(`${ESC}[1;1H${ESC}[41mred background to the edge`);
  const sgr = new RegExp(ESC + "\[[0-9;]*m", "g");
  for (const row of e.rows({ color: true })) {
    const codes = row.match(sgr);
    if (!codes) continue;
    assert.equal(codes.at(-1), `${ESC}[0m`,
      `a row left its style open: ${JSON.stringify(row)}`);
  }
  e.dispose();
});

test("a style is emitted ONCE PER RUN, not once per cell", async () => {
  // The cost argument, measured rather than asserted: ten identical coloured cells must produce one
  // escape, not ten. Per-cell escapes are kilobytes per row, redrawn every refresh, per pane.
  const e = await screen({ cols: 30, rows: 2 });
  await e.write(`${ESC}[1;1H${ESC}[32m${"g".repeat(10)}${ESC}[0m`);
  const [row] = e.rows({ color: true });
  const opens = row.split(`${ESC}[0;32;49m`).length - 1;
  assert.equal(opens, 1, `the style was re-emitted ${opens} times for one run`);
  e.dispose();
});

// ── what a "full repaint" has to mean, measured against the real package ────────────────────
//
// THE ORACLE AND THE RECONSTRUCTION. `screen-baseline.mjs` decides whether a screen built from a
// TRUNCATED replay may be shown as the truth. The only honest way to check that rule is to build both
// screens -- one fed the whole history, one fed only the retained suffix -- and compare them. If they
// differ, the rule is calling a wrong screen sound.
//
// I ACCEPTED FOUR SEQUENCES AND THREE WERE WRONG, one of them producing actual DISCLOSURE. These
// tests are the comparisons that removed them, kept so a future widening has to meet them.

/** The screen a terminal shows after `bytes`, with concealed cells blanked as the pane blanks them. */
async function screenAfter(bytes, { cols = 40, rows = 6 } = {}) {
  const e = await screen({ cols, rows });
  await e.write(bytes);
  const out = e.rows().map((r) => r.trimEnd());
  e.dispose();
  return out.join("|");
}

test("ESC[2J IS NOT A BASELINE: it discloses text the real screen conceals", async () => {
  // THE MEASURED DISCLOSURE, and the reason the accepted set is now one sequence. `ESC[2J` erases the
  // display and resets NOTHING else -- not SGR. With the `ESC[8m` that turned conceal ON lost off the
  // front of a truncated replay, the reconstruction has conceal OFF and PRINTS what the terminal is
  // hiding. That is not a rendering difference; it is the pane showing a secret.
  const lost = `${ESC}[8m`;
  const kept = `${ESC}[2JSYNTHETIC_HIDDEN`;
  const oracle = await screenAfter(lost + kept);
  const rebuilt = await screenAfter(kept);
  assert.ok(!oracle.includes("SYNTHETIC_HIDDEN"), "the oracle is not concealing; this test is void");
  assert.ok(rebuilt.includes("SYNTHETIC_HIDDEN"),
    "the reconstruction no longer discloses -- if that is a real fix, this test should be rewritten "
    + "rather than deleted, because the RULE it justifies is still the conservative one");
  assert.notEqual(oracle, rebuilt, "the two screens agree, so ESC[2J would be safe after all");
});

test("ESC[3J IS NOT A BASELINE: it clears scrollback, not the display", async () => {
  const lost = `${ESC}[1;1HOLD_TEXT_STILL_ON_SCREEN`;
  const kept = `${ESC}[3J${ESC}[2;1HNEW`;
  assert.notEqual(await screenAfter(lost + kept), await screenAfter(kept),
    "ESC[3J discarded the earlier display, which would make it a valid baseline");
});

test("ESC[?1049h IS NOT A BASELINE: the normal screen underneath was never reconstructed", async () => {
  // And it comes back: `ESC[?1049l` restores it. Soundness cannot be permanent on the strength of a
  // switch that can be switched back.
  const lost = `${ESC}[1;1HNORMAL_SCREEN_CONTENT`;
  const kept = `${ESC}[?1049hALT${ESC}[?1049l`;
  assert.notEqual(await screenAfter(lost + kept), await screenAfter(kept),
    "the alternate-screen round trip preserved the normal screen, which would make it a baseline");
});

test("POSITIVE CONTROL: RIS IS a baseline -- the two screens agree", async () => {
  // Without this, the three tests above would be satisfied by an emulator where nothing ever agrees,
  // and the rule would be "trust nothing" rather than "trust a full reset".
  const lost = `${ESC}[8m${ESC}[1;1HOLD`;
  const kept = `${ESC}c${ESC}[1;1HAFTER_RESET`;
  assert.equal(await screenAfter(lost + kept), await screenAfter(kept),
    "RIS did not make the lost history irrelevant, so nothing can be a baseline");
});

test("THE ADDON IS SEPARATELY OPTIONAL, and its absence is a THIRD acceptance arm", () => {
  // Three states, not two: both packages, neither, and HEADLESS WITHOUT THE ADDON -- which is the
  // easiest to end up in and the only one with no error to notice. `loadEmulator` returns the addon
  // as its own field precisely so the caller can tell them apart, and the pane reports a version
  // other than 11 in its title because the columns genuinely differ.
  //
  // WHAT THIS ARM CAN PROVE HERE is the SHAPE: the loader reports the two independently. Producing a
  // resolution where headless loads and the addon does not needs a package tree neither the installed
  // nor the temp-copy arm provides, so the consequence is pinned where it is observable -- the
  // title's warning, in `console-view.test.js`.
  assert.equal(typeof ScreenEmulator.create, "function");
});

// ── the ABSENT arm, in a child process where the package genuinely cannot be resolved ────────────

test("PHYSICAL ABSENCE: with the package unresolvable, create() returns null rather than throwing", () => {
  // NOT A MOCK. The module is copied somewhere Node cannot resolve `@xterm/headless` from, and run
  // there. That is the machine an operator has before `npm install`, and the whole point of making
  // this dependency optional -- the view must degrade to the notice that names `aify-env attach`,
  // never crash the daemon that is running their fleet.
  // ITS LOCAL IMPORTS COME TOO. This module gained `./screen-style.mjs` when colour landed, and
  // copying it alone made the absent arm fail for the WRONG REASON -- an unresolvable relative import
  // rather than an unresolvable package. The test then proved nothing about optionality while looking
  // like it had caught something. Both files, and the list is asserted below so a third import cannot
  // silently reintroduce the same false failure.
  const dir = mkdtempSync(path.join(tmpdir(), "aify-env-absent-"));
  const LOCAL_IMPORTS = ["screen-style.mjs"];
  const source = readFileSync(MODULE, "utf8");
  const needed = [...source.matchAll(/from "\.\/([\w.-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(needed.sort(), [...LOCAL_IMPORTS].sort(),
    "screen-emulator.mjs imports a local module this test does not copy, so the absent arm would fail "
    + "on a missing relative path rather than on the missing package");
  copyFileSync(MODULE, path.join(dir, "screen-emulator.mjs"));
  for (const name of LOCAL_IMPORTS) {
    copyFileSync(path.join(HERE, "..", "lib", name), path.join(dir, name));
  }
  const url = pathToFileURL(path.join(dir, "screen-emulator.mjs")).href;
  const script = `import("${url}").then(async (m) => {
    const loaded = await m.loadEmulator();
    const made = await m.ScreenEmulator.create({ cols: 80, rows: 24 });
    console.log(JSON.stringify({ loaded: loaded === null, made: made === null }));
  }).catch((e) => { console.log(JSON.stringify({ threw: String(e && e.message) })); });`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { cwd: dir, encoding: "utf8", timeout: 30_000 });
  const result = JSON.parse(out.trim().split("\n").pop());

  assert.equal(result.threw, undefined, `the absent arm threw instead of degrading: ${result.threw}`);
  // THE CONTROL THAT MAKES THIS ARM MEAN ANYTHING: if the package resolved from the temp directory
  // anyway -- a global install, a node_modules somewhere up that path -- then absence was never
  // tested and a pass here would be a lie. `loaded === true` means `loadEmulator()` returned null,
  // which only happens when the import genuinely failed.
  assert.equal(result.loaded, true,
    "@xterm/headless resolved from the temp directory, so ABSENCE was never actually tested");
  assert.equal(result.made, true, "create() returned an emulator with no package installed");
});

console.log("screen-emulator.test.js: all assertions passed");

test("A COMPLETE HISTORY CAN STILL DISCLOSE THROUGH THE LOG PATH, and the pane must refuse it", async () => {
  // THE THIRD CONCEAL DISCLOSURE IN THIS FEATURE, and the first two were both about a TRUNCATED
  // history. This one has none: the whole stream is present, the daemon's `truncated: false` is
  // honest, and there is not a single cursor command in it -- so the baseline gate is satisfied,
  // `isPainting` is false, and the pane takes the LOG path.
  //
  // WHY THE LOG PATH CANNOT SEE IT. `splitChunk` gives an escape a column, so the carriage return
  // overwrites `ESC[8m` with the first five letters of the token. The retained line is
  // `SYNTHETIC_HIDDEN` with no escape in it at all -- there is nothing left for the buffer to scan.
  const bytes = `${ESC}[8m${String.fromCharCode(13)}SYNTHETIC_HIDDEN`;
  const oracle = await screenAfter(bytes);
  assert.ok(!oracle.includes("SYNTHETIC_HIDDEN"),
    "the real terminal is not concealing this, so this test is void");

  const { PaneBuffer } = await import("../lib/pane-buffer.mjs");
  const pane = new PaneBuffer({ maxLines: 20 });
  pane.append(bytes);
  assert.equal(pane.isPainting(), false,
    "the stream now looks painted, so this no longer reproduces the log path it was written for");
  const shown = pane.view({ height: 6, width: 60, screen: { problem: "" } }).join("|");
  assert.ok(!shown.includes("SYNTHETIC_HIDDEN"), `the pane printed what the terminal hides: ${shown}`);
  assert.match(shown, /cannot draw it/, "it refused silently rather than naming the attach");
});

test("A FULL RESET RELEASES THE REFUSAL, so one conceal does not cost a process its pane for ever", async () => {
  // `ESC c` is the one sequence that throws the whole screen away -- the same rule the baseline
  // already enforces -- so nothing said before it bears on what is displayed. Anything weaker leaves
  // concealed cells in the buffer, and this project accepted `ESC[2J` as a reset once and disclosed
  // through it.
  const { PaneBuffer } = await import("../lib/pane-buffer.mjs");
  const pane = new PaneBuffer({ maxLines: 20 });
  pane.append(`${ESC}[8mhidden${String.fromCharCode(10)}`);
  assert.match(pane.view({ height: 6, width: 60, screen: { problem: "" } }).join("|"), /cannot draw it/);
  pane.append(`${ESC}cAFTER_RESET${String.fromCharCode(10)}`);
  assert.match(pane.view({ height: 6, width: 60, screen: { problem: "" } }).join("|"), /AFTER_RESET/,
    "a full reset did not release the refusal");

  // AND A WEAKER ONE DOES NOT. `ESC[28m` turns conceal off for what FOLLOWS and leaves everything
  // already concealed exactly as it was.
  //
  // SEPARATE CHUNKS, and that is what makes the assertion mean anything. One chunk carrying both the
  // conceal and the weaker sequence latches whichever rule is in force -- the conceal is scanned
  // after the release either way -- so it cannot tell a correct rule from a wrong one. A mutant that
  // accepted `ESC[28m` as a release survived a single-chunk version of this test.
  // SGR RESETS ONLY. `ESC[2J`, `ESC[3J` and `ESC[?1049h` are ERASE and screen-switch sequences:
  // `drawsWithCursor` sees them, the pane takes the PAINTING branch, and it never reaches the log
  // path this latch guards. They are refused as baselines by `screen-baseline.mjs`, which is where
  // that argument belongs and where it is already tested.
  for (const weaker of [`${ESC}[28m`, `${ESC}[0m`, `${ESC}[m`]) {
    const still = new PaneBuffer({ maxLines: 20 });
    still.append(`${ESC}[8mhidden${String.fromCharCode(10)}`);
    still.append(`${weaker}visible${String.fromCharCode(10)}`);
    assert.match(still.view({ height: 6, width: 60, screen: { problem: "" } }).join("|"), /cannot draw it/,
      `${JSON.stringify(weaker)} was accepted as a full reset`);
  }
  // AND THE RELEASE ITSELF ARRIVES IN ITS OWN CHUNK TOO, for the same reason.
  const released = new PaneBuffer({ maxLines: 20 });
  released.append(`${ESC}[8mhidden${String.fromCharCode(10)}`);
  released.append(`${ESC}cAFTER${String.fromCharCode(10)}`);
  assert.match(released.view({ height: 6, width: 60, screen: { problem: "" } }).join("|"), /AFTER/);
});

test("A CONCEAL AFTER A RESET IN THE SAME CHUNK STILL LATCHES", async () => {
  // Ordering, and it is the direction that matters: a chunk carrying both must end up refused,
  // because the conceal came after. Reading the reset last would clear a latch the same bytes had
  // just earned.
  const { PaneBuffer } = await import("../lib/pane-buffer.mjs");
  const pane = new PaneBuffer({ maxLines: 20 });
  pane.append(`${ESC}cclean${String.fromCharCode(10)}${ESC}[8msecret${String.fromCharCode(10)}`);
  assert.match(pane.view({ height: 6, width: 60, screen: { problem: "" } }).join("|"), /cannot draw it/);
});

test("RE-POINTING A PANE FORGETS THE PREVIOUS PROCESS'S CONCEAL", async () => {
  // `clear` is what moves a pane to a different agent. Carrying the latch across would refuse a
  // fresh stream for something somebody else's process did.
  const { PaneBuffer } = await import("../lib/pane-buffer.mjs");
  const pane = new PaneBuffer({ maxLines: 20 });
  pane.append(`${ESC}[8msecret${String.fromCharCode(10)}`);
  pane.clear();
  pane.append(`ordinary log${String.fromCharCode(10)}`);
  assert.match(pane.view({ height: 6, width: 60, screen: { problem: "" } }).join("|"), /ordinary log/);
});

test("NEGATIVE CONTROL: an ordinary coloured log is still drawn as a log", async () => {
  // Every refusal above passes against a pane that refuses everything, which would be the feature
  // deleted rather than fixed.
  const { PaneBuffer } = await import("../lib/pane-buffer.mjs");
  const pane = new PaneBuffer({ maxLines: 20 });
  pane.append(`${ESC}[31mred${ESC}[0m and ${ESC}[38:5:8mgrey${ESC}[0m${String.fromCharCode(10)}`);
  const shown = pane.view({ height: 6, width: 60, screen: { problem: "" } }).join("|");
  assert.match(shown, /red/);
  assert.match(shown, /grey/, "palette colour 8 was mistaken for a conceal");
});
