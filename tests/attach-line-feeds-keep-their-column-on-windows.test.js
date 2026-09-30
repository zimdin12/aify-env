#!/usr/bin/env node
// On Windows `aify-env attach` writes the stream's line feeds as Index, so a row stays in its column.
//
// THE DEFECT (2026-09-30), the scrambled herdr pane. ConPTY moves the cursor down with a bare LF,
// meaning "same column". Written by a program to a Windows console, LF becomes CR+LF, so the row
// went back to column 1 and the cells it did not cover kept the old text ("bot-" for "both").
//
// MEASURED THROUGH A REAL CONPTY, the path the bytes take in a herdr pane: a child writes through
// `passthrough` inside node-pty, and a real emulator reads what the console made of it. The control
// runs the same bytes untranslated and must show the shift, so this test can see the defect.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConsoleLineFeeds, vt500TableEntry } from "../lib/console-line-feeds.mjs";
import { ScreenEmulator } from "../lib/screen-emulator.mjs";

const ESC = String.fromCharCode(27);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREEN = pathToFileURL(path.join(HERE, "..", "lib", "attach-screen.mjs")).href;
//: A row positioned at column 3, then a LF mid-screen and a LF on the bottom row, which must scroll.
const CHUNK = `${ESC}[2;3Hab\ncd${ESC}[6;1Hbottom\nnext`;

/** The screen a console shows after a child writes CHUNK through `passthrough` as `platform`. */
async function throughConsole(platform) {
  // THE CHILD STAYS ALIVE AND IS KILLED, the way the other pty tests end one: awaiting a ConPTY child's
  // own exit leaves node-pty's output socket open, and this file never finished (measured). The window
  // title is the signal that CHUNK was written, since ConPTY forwards titles in order with the screen.
  const script = `
    import { passthrough } from ${JSON.stringify(SCREEN)};
    const out = passthrough((text) => process.stdout.write(text), { platform: ${JSON.stringify(platform)} });
    out.append(${JSON.stringify(CHUNK)});
    setTimeout(() => process.stdout.write("\\x1b]0;written\\x07"), 300);
    setInterval(() => {}, 1000);
  `;
  const pty = createRequire(import.meta.url)("node-pty");
  const child = pty.spawn(process.execPath, ["--input-type=module", "-e", script], { name: "xterm-256color", cols: 40, rows: 6 });
  let output = "";
  child.onData((data) => { output += data; });
  const until = Date.now() + 15000;
  while (!output.includes("written") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
  child.kill();
  assert.ok(output.includes("written"), "the child never said it had written, so there is no screen to read");
  const screen = await ScreenEmulator.create({ cols: 40, rows: 6 });
  assert.ok(screen, "@xterm/headless is absent, so nothing here is measured");
  await screen.write(output);
  const rows = screen.rows().map((row) => row.trimEnd());
  screen.dispose();
  return rows;
}

const onWindows = { skip: process.platform !== "win32" && "a Windows console is what converts LF" };

test("A LINE FEED KEEPS ITS COLUMN, AND ONE ON THE BOTTOM ROW STILL SCROLLS", onWindows, async () => {
  const rows = await throughConsole("win32");
  assert.deepEqual(rows, ["  ab", "    cd", "", "", "bottom", "      next"]);
});

test("CONTROL: the same bytes untranslated land at column 1 on this console", onWindows, async () => {
  const rows = await throughConsole("linux");
  assert.equal(rows[1], "cd", "the console did not convert LF, so the first test proves nothing here");
  assert.equal(rows[5], "next");
});

// PARITY (reviews of e880d48 and 0557d21). Two properties, over every input whole and split:
//   parser   an emulator ends in the same state -- rows, cursor, titles, replies -- reading the stream
//            or the translated stream. A blanket replace broke LF inside a CSI and inside an OSC.
//   console  the translated stream read by an emulator that turns LF into CR+LF, as a Windows console
//            does, ends where the original does in a VT parser: every LF a parser executes was
//            translated. Only the over-limit sequence is exempt, by its stated boundary.
const BEL = "\x07";
const CAN = "\x18";
const SUB = "\x1a";
const ST = `${ESC}\\`;
const C1_CSI = "\x9b";
const C1_OSC = "\x9d";
const C1_ST = "\x9c";
const PARITY = {
  "LF at ground, and on the bottom row": CHUNK,
  "LF inside a CSI before its final byte": `${ESC}[1;\n5HX`,
  "LF and CR inside a CSI": `${ESC}[3;\r\n9HY`,
  "LF inside an escape with an intermediate": `${ESC}(\nBZ`,
  "LF inside an OSC ended by BEL": `${ESC}]0;BEFORE\nAFTER${BEL}X`,
  "LF inside an OSC ended by ST": `${ESC}]0;ONE\nTWO${ST}X\nY`,
  "LF inside a DCS": `${ESC}Pq\n#0${ST}A\nB`,
  "BEL does not end a DCS": `${ESC}PqDATA${BEL}\nTAIL${ST}X`,
  "BEL does not end an SOS": `${ESC}XDATA${BEL}\nTAIL${ST}X`,
  "BEL does not end a PM": `${ESC}^DATA${BEL}\nTAIL${ST}X`,
  "BEL does not end an APC": `${ESC}_DATA${BEL}\nTAIL${ST}X`,
  "a CSI aborted by CAN, then LF": `${ESC}[12${CAN}Q\nR`,
  "an OSC cancelled by CAN, then LF": `${ESC}[1;5H${ESC}]0;DATA${CAN}\nX`,
  "an OSC cancelled by SUB, then LF": `${ESC}[1;5H${ESC}]0;DATA${SUB}\nX`,
  "a DCS cancelled by CAN, then LF": `${ESC}[1;5H${ESC}PqDATA${CAN}\nX`,
  "a DCS cancelled by SUB, then LF": `${ESC}[1;5H${ESC}PqDATA${SUB}\nX`,
  "an ESC restarting a CSI with an LF inside": `${ESC}[5${ESC}[2;\n4HW`,
  "a C1 CSI with an LF inside": `${C1_CSI}1;\n5HX`,
  "a C1 OSC ended by C1 ST, then LF": `${ESC}[1;5H${C1_OSC}0;T\nI${C1_ST}\nX`,
  "a CSI longer than the hold, with an LF inside": `${ESC}[${"0".repeat(5000)}1;\n5HX`,
  // Review of bfacc7a: after an escape intermediate, `[` and the string introducers are FINALS.
  "ESC ( then [ is a final, not a CSI": `${ESC}[1;5H${ESC}([5\nHX`,
  "ESC ( then ] is a final, not an OSC": `${ESC}[1;5H${ESC}(]A\nB`,
  "ESC ( then P is a final, not a DCS": `${ESC}[1;5H${ESC}(PA\nB`,
  "ESC ( then X is a final, not an SOS": `${ESC}[1;5H${ESC}(XA\nB`,
  "ESC ( then ^ is a final, not a PM": `${ESC}[1;5H${ESC}(^A\nB`,
  "ESC ( then _ is a final, not an APC": `${ESC}[1;5H${ESC}(_A\nB`,
  "ESC with two intermediates": `${ESC}[1;5H${ESC}( !\nB5X`,
  "a CSI broken by U+0080, then printable and LF": `${ESC}[1;5H${ESC}[1\u00805\nHX`,
  "a CSI broken by U+00E9, then printable and LF": `${ESC}[1;5H${ESC}[1é5\nHX`,
  "a CSI with an intermediate then a parameter (ignored)": `${ESC}[1;5H${ESC}[ 1\n5HX`,
  "a private CSI with an LF inside": `${ESC}[?25\nlX`,
  // The ESC that ends a string starts an escape (xterm's parse loop, not its table), so an LF right
  // after it is executed inside that escape.
  "an LF right after the ESC that ends an OSC": `${ESC}[1;5H${ESC}]0;T${ESC}\n(BZ`,
  "an LF right after the ESC that ends a DCS": `${ESC}[1;5H${ESC}PqD${ESC}\n(BZ`,
};
//: Past the hold an LF inside that one sequence passes as it came: parser parity, not console parity.
const CONSOLE_EXEMPT = new Set(["a CSI longer than the hold, with an LF inside"]);

async function parserState(chunks, { lineFeedReturns = false } = {}) {
  const screen = await ScreenEmulator.create({ cols: 40, rows: 6 });
  assert.ok(screen, "@xterm/headless is absent, so nothing here is measured");
  screen.term.options.convertEol = lineFeedReturns;
  const titles = [];
  const replies = [];
  screen.term.onTitleChange((title) => titles.push(title));
  screen.term.onData((data) => replies.push(data));
  for (const chunk of chunks) await screen.write(chunk);
  const buffer = screen.term.buffer.active;
  const state = { rows: screen.rows(), cursor: [buffer.cursorX, buffer.cursorY], titles, replies };
  screen.dispose();
  return state;
}

function translated(chunks) {
  const lineFeeds = new ConsoleLineFeeds();
  return chunks.map((chunk) => lineFeeds.translate(chunk));
}

/** Every two-chunk split of a short input; a long one is cut at about forty points, ends included. */
function splits(text) {
  const step = Math.max(1, Math.floor(text.length / 40));
  const cuts = new Set([text.length, text.length - 1, text.length - 4, text.length - 5]);
  for (let cut = 0; cut <= text.length; cut += step) cuts.add(cut);
  return [...cuts].filter((cut) => cut >= 0).sort((a, b) => a - b).map((cut) => [text.slice(0, cut), text.slice(cut)]);
}

test("THE TRANSLATION LEAVES AN EMULATOR IN THE SAME STATE, whole and split", async () => {
  for (const [name, text] of Object.entries(PARITY)) {
    const expected = await parserState([text]);
    for (const chunks of splits(text)) {
      const out = translated(chunks);
      const at = `${name}, split at ${chunks[0].length}`;
      assert.deepEqual(await parserState(out), expected, `parser: ${at}`);
      if (!CONSOLE_EXEMPT.has(name)) assert.deepEqual(await parserState(out, { lineFeedReturns: true }), expected, `console: ${at}`);
    }
  }
});

test("CONTROL: the console model shows a bare LF losing its column", async () => {
  const text = `${ESC}[1;5HA\nB`;
  assert.notDeepEqual(await parserState([text], { lineFeedReturns: true }), await parserState([text]));
});

test("CONTROL: the parity gate fails a blanket replace", async () => {
  const text = PARITY["LF inside a CSI before its final byte"];
  const blanket = text.replace(/\n/g, `${ESC}D`);
  assert.notDeepEqual(await parserState([blanket]), await parserState([text]));
});

test("THE PORTED TABLE IS XTERM'S TABLE, entry for entry", async () => {
  // xterm's own table, read from the emulator the parity tests use: index state << 8 | code, value
  // action << 4 | next (TableAccess in EscapeSequenceParser.ts). Private, so a change in xterm fails
  // this loudly rather than letting the port drift from what it copies.
  const screen = await ScreenEmulator.create({ cols: 10, rows: 2 });
  assert.ok(screen, "@xterm/headless is absent, so nothing here is measured");
  const table = screen.term._core._inputHandler._parser._transitions.table;
  screen.dispose();
  let compared = 0;
  for (let state = 0; state < 14; state += 1) {
    for (let code = 0; code <= 0xa0; code += 1) {
      const value = table[(state << 8) | code];
      assert.deepEqual(vt500TableEntry(state, code), [value >> 4, value & 15], `state ${state}, code 0x${code.toString(16)}`);
      compared += 1;
    }
  }
  assert.equal(compared, 14 * 161);
});

test("THE HOLD CEILING applies only to a sequence still unfinished at the end of a chunk", () => {
  const prefix = `${ESC}[${"0".repeat(5000)}1;`;
  const whole = new ConsoleLineFeeds().translate(`${prefix}\n5HX`);
  assert.ok(whole.startsWith(`${ESC}D${ESC}[`), "a long sequence finished in one chunk still has its LF as Index, ahead");
  const lineFeeds = new ConsoleLineFeeds();
  const first = lineFeeds.translate(prefix);
  assert.equal(first, prefix, "an unfinished sequence over the ceiling is written as it stands");
  assert.equal(lineFeeds.translate("\n5HX"), "\n5HX", "and the rest of that sequence passes as it came");
});

test("Index replaces an LF at ground and nothing else there changes", () => {
  assert.equal(new ConsoleLineFeeds().translate(`a\r\nb\nc${ESC}[1;2H`), `a\r${ESC}Db${ESC}Dc${ESC}[1;2H`);
});
