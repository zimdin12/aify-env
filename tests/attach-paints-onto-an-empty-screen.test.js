#!/usr/bin/env node
// `aify-env attach` puts the local screen in a known empty state before the first byte it paints.
//
// THE DEFECT. The client wrote the replay straight to stdout. Whatever the local terminal already
// showed -- a shell, an earlier attach -- stayed wherever the replay did not overwrite it, and the
// replay's own cut-off start drew on top. Old cells and new ghosted together until the agent happened
// to redraw them.
//
// MEASURED WITH A REAL EMULATOR standing in for the operator's terminal, with a negative control that
// shows the ghost is there without the reset.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOCAL_SCREEN_RESET, passthrough } from "../lib/attach-screen.mjs";
import { ScreenEmulator } from "../lib/screen-emulator.mjs";

const ESC = String.fromCharCode(27);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A local terminal that is not blank: old text, a coloured pen, and the alternate screen active. */
async function usedTerminal() {
  const screen = await ScreenEmulator.create({ cols: 40, rows: 6 });
  assert.ok(screen, "@xterm/headless is absent, so nothing here is measured");
  // The pen is set BEFORE entering the alternate screen: leaving it restores the cursor saved on the
  // way in, pen included, so a colour set inside would be undone by `ESC[?1049l` alone.
  await screen.write(`${ESC}[31m${ESC}[5;1HOLD SHELL LINE${ESC}[?1049h${ESC}[3;1HOLD ALT LINE`);
  return screen;
}

/** Everything a sink wrote, in order, applied to the terminal. */
async function paint(screen, sink, chunks) {
  const written = [];
  const out = sink((text) => written.push(text));
  for (const chunk of chunks) out.append(chunk);
  for (const text of written) await screen.write(text);
  return written;
}

const REPLAY = [`${ESC}[1;1Hagent row one`];

test("THE FIRST CHUNK LANDS ON AN EMPTY, NORMAL, UNSTYLED SCREEN", async () => {
  const screen = await usedTerminal();
  await paint(screen, passthrough, REPLAY);
  const rows = screen.rows();
  assert.equal(rows[0].trimEnd(), "agent row one");
  for (const row of rows.slice(1)) assert.equal(row.trim(), "", `a stale row survived: ${JSON.stringify(row)}`);
  assert.equal(screen.term.buffer.active.type, "normal", "the replay was painted into the alternate screen");
  const cell = screen.term.buffer.active.getLine(0).getCell(0);
  assert.equal(cell.isFgDefault(), true, "the replay inherited the pen the terminal was left with");
  screen.dispose();
});

test("A REPLAY THAT DOES NOT POSITION ITSELF STARTS AT THE TOP LEFT", async () => {
  // A suffix can begin mid-line with no cursor move, and a checkpoint paints row by row from wherever
  // the cursor stands. Either lands where the old screen left the cursor unless it is homed first.
  const screen = await usedTerminal();
  await paint(screen, passthrough, ["unpositioned tail"]);
  assert.equal(screen.rows()[0].trimEnd(), "unpositioned tail");
  screen.dispose();
});

test("NEGATIVE CONTROL: without the reset the old rows ghost under the replay", async () => {
  const screen = await usedTerminal();
  await paint(screen, (write) => ({ append: write }), REPLAY);
  assert.match(screen.rows().join("\n"), /OLD ALT LINE/, "the used terminal was blank anyway, so the test above proves nothing");
  screen.dispose();
});

test("THE RESET IS WRITTEN ONCE, IMMEDIATELY BEFORE THE FIRST CHUNK, and never with no output", () => {
  const written = [];
  const out = passthrough((text) => written.push(text));
  assert.deepEqual(written, [], "the screen was cleared before the process had anything to show");
  out.append("a");
  out.append("b");
  assert.deepEqual(written, [LOCAL_SCREEN_RESET, "a", "b"]);
});

test("SCROLLBACK IS LEFT ALONE: it is the operator's, and it never overlaps live cells", () => {
  assert.equal(LOCAL_SCREEN_RESET.includes(`${ESC}[3J`), false);
});

test("THE ATTACH CLIENT USES IT", () => {
  const source = readFileSync(path.join(HERE, "..", "bin", "aify-env-attach.mjs"), "utf8");
  assert.match(source, /buffer: passthrough\(/, "aify-env attach still writes the replay straight to stdout");
});
