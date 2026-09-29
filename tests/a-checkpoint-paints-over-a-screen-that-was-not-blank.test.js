#!/usr/bin/env node
// A checkpoint paints over whatever the receiving terminal already shows.
//
// THE OPERATOR, 2026-09-29: "i still see scrambled tui for --attached". herdr's own grid of a claude
// pane held a stale `wo` at column 0 that aify-env's screen did not. The serializer assumes a blank
// terminal, so a viewer that was not blank -- a reconnect, a second attach in the same pane -- kept
// every cell the snapshot skipped, and claude, which redraws only what it changed, never rewrote them.

import assert from "node:assert/strict";
import test from "node:test";

import { selfClearing } from "../lib/screen-checkpoint.mjs";

const ESC = String.fromCharCode(27);
const COLS = 40;
const ROWS = 8;

async function packages() {
  try {
    const { Terminal } = (await import("@xterm/headless")).default;
    const { SerializeAddon } = (await import("@xterm/addon-serialize")).default;
    return { Terminal, SerializeAddon };
  } catch {
    return null;
  }
}

const write = (term, text) => new Promise((resolve) => term.write(text, resolve));
const rows = (term) => Array.from({ length: term.rows },
  (_, y) => term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) ?? "");

/** A source screen with blank rows and short rows, the shape the serializer leaves gaps in. */
async function snapshotOf(Terminal, SerializeAddon, alternate) {
  const source = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const serializer = new SerializeAddon();
  source.loadAddon(serializer);
  await write(source, `${alternate ? `${ESC}[?1049h` : ""}${ESC}[Hfirst row${ESC}[6;3Hsixth`);
  return { source, data: serializer.serialize({ scrollback: 0 }) };
}

/** A viewer that is not blank: the screen the snapshot lands on is full of X. */
async function staleViewer(Terminal, alternate) {
  const viewer = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const fill = Array.from({ length: ROWS }, () => "X".repeat(COLS)).join("\r\n");
  await write(viewer, `${alternate ? `${ESC}[?1049h` : ""}${ESC}[H${fill}`);
  return viewer;
}

for (const alternate of [true, false]) {
  const screen = alternate ? "alternate" : "main";

  test(`a checkpoint of the ${screen} screen leaves nothing of what the viewer showed before`, async (t) => {
    const found = await packages();
    if (!found) return t.skip("the optional xterm packages are not installed");
    const { source, data } = await snapshotOf(found.Terminal, found.SerializeAddon, alternate);
    const viewer = await staleViewer(found.Terminal, alternate);
    await write(viewer, selfClearing(data));
    assert.equal(viewer.buffer.active.type, source.buffer.active.type, "the viewer is on the other screen");
    assert.deepEqual(rows(viewer), rows(source), "the viewer's screen is not the snapshot's");
  });

  test(`CONTROL: the raw ${screen}-screen serializer output does leave stale cells`, async (t) => {
    const found = await packages();
    if (!found) return t.skip("the optional xterm packages are not installed");
    const { data } = await snapshotOf(found.Terminal, found.SerializeAddon, alternate);
    const viewer = await staleViewer(found.Terminal, alternate);
    await write(viewer, data);
    assert.ok(rows(viewer).some((row) => row.includes("X")), "the fixture cannot show the defect");
  });
}
