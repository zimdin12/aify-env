#!/usr/bin/env node
// On Windows `aify-env attach` writes the stream's line feeds as Index, so a row stays in its column.
//
// THE DEFECT (2026-09-30), the scrambled herdr pane. ConPTY moves the cursor down with a bare LF,
// meaning "same column". Written by a program to a Windows console, LF becomes CR+LF, so the row
// landed at column 1 and the cells it did not cover kept the old text ("bot-" for "both").
//
// MEASURED THROUGH A REAL CONPTY, the path the bytes take in a herdr pane: a child writes through
// `passthrough` inside node-pty, and a real emulator reads what the console made of it. The control
// runs the same bytes untranslated and must show the shift, so this test can see the defect.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConsoleLineFeeds } from "../lib/attach-screen.mjs";
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

// PARSER PARITY (review of e880d48): an emulator must end in the same state -- rows, cursor, title --
// whether it reads the stream or the translated stream. A blanket replace failed four of these: an LF
// inside a CSI is executed and the sequence goes on, and one inside an OSC is part of the title.
const PARITY = {
  "LF at ground, and on the bottom row": `${ESC}[2;3Hab\ncd${ESC}[6;1Hbottom\nnext`,
  "LF inside a CSI before its final byte": `${ESC}[1;\n5HX`,
  "LF and CR inside a CSI": `${ESC}[3;\r\n9HY`,
  "LF inside an escape with an intermediate": `${ESC}(\nBZ`,
  "LF inside an OSC ended by BEL": `${ESC}]0;BEFORE\nAFTER\x07X`,
  "LF inside an OSC ended by ESC \\": `${ESC}]0;ONE\nTWO${ESC}\\X\nY`,
  "LF inside a DCS": `${ESC}Pq\n#0${ESC}\\A\nB`,
  "a CSI aborted by CAN, then LF": `${ESC}[12\x18Q\nR`,
  "an ESC restarting a CSI with an LF inside": `${ESC}[5${ESC}[2;\n4HW`,
};

async function parserState(chunks) {
  const screen = await ScreenEmulator.create({ cols: 40, rows: 6 });
  assert.ok(screen, "@xterm/headless is absent, so nothing here is measured");
  const titles = [];
  screen.term.onTitleChange((title) => titles.push(title));
  for (const chunk of chunks) await screen.write(chunk);
  const buffer = screen.term.buffer.active;
  const state = { rows: screen.rows(), cursor: [buffer.cursorX, buffer.cursorY], titles };
  screen.dispose();
  return state;
}

function translated(chunks) {
  const lineFeeds = new ConsoleLineFeeds();
  return chunks.map((chunk) => lineFeeds.translate(chunk));
}

test("THE TRANSLATION LEAVES AN EMULATOR IN THE SAME STATE, whole and split at every point", async () => {
  for (const [name, text] of Object.entries(PARITY)) {
    const expected = await parserState([text]);
    for (let cut = 0; cut <= text.length; cut += 1) {
      const chunks = [text.slice(0, cut), text.slice(cut)];
      assert.deepEqual(await parserState(translated(chunks)), expected, `${name}, split at ${cut}`);
    }
  }
});

test("CONTROL: the parity gate fails a blanket replace", async () => {
  const text = PARITY["LF inside a CSI before its final byte"];
  const blanket = text.replace(/\n/g, `${ESC}D`);
  assert.notDeepEqual(await parserState([blanket]), await parserState([text]));
});

test("Index replaces an LF at ground and nothing else there changes", () => {
  assert.equal(new ConsoleLineFeeds().translate(`a\r\nb\nc${ESC}[1;2H`), `a\r${ESC}Db${ESC}Dc${ESC}[1;2H`);
});
