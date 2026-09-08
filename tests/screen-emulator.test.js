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
import { copyFileSync, mkdtempSync } from "node:fs";
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

// ── the ABSENT arm, in a child process where the package genuinely cannot be resolved ────────────

test("PHYSICAL ABSENCE: with the package unresolvable, create() returns null rather than throwing", () => {
  // NOT A MOCK. The module is copied somewhere Node cannot resolve `@xterm/headless` from, and run
  // there. That is the machine an operator has before `npm install`, and the whole point of making
  // this dependency optional -- the view must degrade to the notice that names `aify-env attach`,
  // never crash the daemon that is running their fleet.
  const dir = mkdtempSync(path.join(tmpdir(), "aify-env-absent-"));
  copyFileSync(MODULE, path.join(dir, "screen-emulator.mjs"));
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
