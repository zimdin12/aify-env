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

import { lineFeedsAsIndex } from "../lib/attach-screen.mjs";
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

test("Index is written for every LF and nothing else changes", () => {
  assert.equal(lineFeedsAsIndex(`a\r\nb\nc${ESC}[1;2H`), `a\r${ESC}Db${ESC}Dc${ESC}[1;2H`);
});
