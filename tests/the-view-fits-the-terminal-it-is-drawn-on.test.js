#!/usr/bin/env node
// Five rendering defects an independent review found, each pinned so it cannot come back.
//
// THEY SHARE ONE SHAPE: the view measured itself against something that was not the screen. Width was
// counted in bytes including escapes, height was not counted at all, and the half of the terminal a
// pane takes was subtracted after the frame had already been drawn for the whole of it. Every one
// ends the same way -- `frameUpdate` addresses rows absolutely, so a line wider or a frame taller
// than the terminal desynchronises the diff and the display never recovers on its own.
//
// AND ONE OF THEM WAS AN AGENT WRITING TO THE OPERATOR'S SCREEN. A process's OSC title was stored
// with `.slice(0, 120)` and nothing else, so `ESC]0;ESC[2J...BEL` cleared the terminal on every poll.

import assert from "node:assert/strict";
import { test } from "node:test";

import { clip, clipToWidth, renderDashboard, width, windowAround } from "../lib/tui.mjs";
import { composeConsole, dashboardColumns } from "../lib/console-view.mjs";
import { sanitizeTitle } from "../lib/process-registry.mjs";

const ESC = String.fromCharCode(27);
const NOW = 1_800_000_000_000;

const procs = (n) => Array.from({ length: n }, (_, i) => ({
  id: `aaaa-p${i + 1}`, pid: 100 + i, label: `agent-${String(i + 1).padStart(2, "0")}`,
  service: "aify-comms", terminal: true, uptimeMs: 60_000, title: "Claude Code",
  lastOutputAtMs: NOW - 900_000,
}));
const snap = (n) => ({
  version: "0.6.2", build: "b", endpoint: "http://127.0.0.1:8802",
  terminals: { available: true, reason: "" }, services: [], processes: procs(n),
  unknown: [], traffic: { requests: 1, bytesOut: 2 }, nowMs: NOW, checks: [],
});
const KEYS = { enabled: true, canQuit: false };
const view = (n, selected, mode = "dashboard") => ({ rows: procs(n), selected, mode, query: "" });

// ── the frame fits the terminal, and the selection stays on it ───────────────────────────────────

test("POSITIVE CONTROL: a frame that already fits is returned untouched", () => {
  // Every assertion below is "the frame is no taller than N". A renderer returning nothing would
  // satisfy all of them, and this is what separates fitting from breaking.
  const small = renderDashboard(snap(3), { columns: 100, keys: KEYS, rows: 40, view: view(3, 0) });
  assert.ok(small.length > 8, "the view rendered almost nothing");
  assert.ok(small.some((l) => l.includes("agent-03")), "a process that fits was dropped");
});

test("THE FRAME IS NEVER TALLER THAN THE TERMINAL", () => {
  // Measured before the fix: 30 processes on a 24-row terminal produced a 45-line frame. The
  // terminal clamps the cursor, so every line past 24 was written onto line 24 in turn -- the bottom
  // row churned through 22 different contents per poll and everything below the table never appeared.
  // THROUGH THE WHOLE COMPOSITION, which is what the daemon renders. The work is split on purpose:
  // `renderDashboard` windows the process table as far as it can, and `composeConsole` clamps what
  // is left -- the fixed furniture (headings, services, health, traffic) has a floor no process
  // count can shrink below, so on a 12-row terminal the table is not what is too tall.
  for (const [n, rows] of [[9, 24], [30, 24], [30, 12], [60, 30], [30, 5]]) {
    const lines = composeConsole({
      dashboardLines: renderDashboard(snap(n), { columns: 100, keys: KEYS, rows, view: view(n, 0) }),
      pane: null, columns: 100, rows,
    });
    assert.ok(lines.length <= rows, `${n} processes on ${rows} rows produced ${lines.length} lines`);
  }
});

test("THE SELECTION STAYS VISIBLE, which is the whole point of the window", () => {
  // The cost of the overflow was this: with 30 agents the cursor sat on frame row 30 of 45, so the
  // operator arrowed down past agent 11 and NOTHING ON SCREEN MOVED. The feature stopped working at
  // exactly the fleet size that makes it worth having.
  for (const selected of [0, 5, 15, 29]) {
    const lines = renderDashboard(snap(30), { columns: 100, keys: KEYS, rows: 24, view: view(30, selected) });
    const at = lines.findIndex((line) => line.includes("❯"));
    assert.ok(at >= 0, `no cursor is drawn with selection ${selected}`);
    assert.ok(at < 24, `the cursor for selection ${selected} is on row ${at}, off a 24-row screen`);
    assert.ok(
      lines[at].includes(`agent-${String(selected + 1).padStart(2, "0")}`),
      `the cursor is on the wrong agent for selection ${selected}`,
    );
  }
});

test("the window says how much it is hiding", () => {
  // A table silently showing 9 of 30 agents lies by omission, and the operator would arrow past the
  // end and see nothing move -- the same symptom as the bug, with the cause hidden.
  const lines = renderDashboard(snap(30), { columns: 100, keys: KEYS, rows: 24, view: view(30, 0) }).join("\n");
  assert.match(lines, /below/, "nothing says there are more agents off screen");
});

test("no `rows` means unbounded, which is what a pipe and `--once` want", () => {
  // Truncating there would hide rows from a log, and a caller that does not own a screen has no
  // height to fit.
  const lines = renderDashboard(snap(30), { columns: 100, keys: KEYS, view: view(30, 0) });
  assert.ok(lines.some((l) => l.includes("agent-30")), "an unbounded render dropped rows anyway");
});

test("windowAround centres, then clamps at both ends", () => {
  assert.deepEqual(windowAround(0, 30, 10), { start: 0, end: 10 });
  assert.deepEqual(windowAround(29, 30, 10), { start: 20, end: 30 });
  assert.deepEqual(windowAround(15, 30, 11), { start: 10, end: 21 });
  // Degenerate inputs must not produce a negative or inverted range.
  assert.deepEqual(windowAround(-1, 5, 99), { start: 0, end: 5 });
  assert.deepEqual(windowAround(NaN, 5, 2), { start: 0, end: 2 });
});

test("composeConsole clamps whatever it is handed", () => {
  // The backstop. The fixed furniture -- headings, services, health, traffic -- has a floor, so a
  // 5-row terminal cannot show this view at any process count. Cutting is the honest failure;
  // corrupting the diff's model of the screen is not.
  const lines = composeConsole({
    dashboardLines: Array.from({ length: 40 }, (_, i) => `line ${i}`), pane: null, columns: 100, rows: 6,
  });
  assert.equal(lines.length, 6);
});

// ── width is counted in columns, not bytes ──────────────────────────────────────────────────────

test("A CLIPPED CELL CLOSES ITS COLOUR, so the style cannot bleed down the frame", () => {
  // Every last-column cell arrives already painted. The naive clip sliced by `.length`, so the
  // opening `ESC[2m` survived the cut and its closing `ESC[0m` did not. Measured across widths
  // 55-130 against title lengths 8-60: 1855 of 4028 rendered rows left an SGR open.
  const painted = `${ESC}[2m${"T".repeat(40)}${ESC}[0m`;
  const cut = clip(painted, 10);
  assert.ok(cut.includes(`${ESC}[0m`), "the cut cell leaves its colour open");
  // A TRAILING PARTIAL SEQUENCE. The pattern is BUILT from `ESC` rather than typed, because the
  // first version carried a raw 0x1b byte in the source -- which this repo avoids deliberately
  // (`process-registry.mjs` says why: a source file that greps as binary is one nobody can review),
  // and which made the line read differently through three different tools while I edited it.
  assert.doesNotMatch(cut, new RegExp(ESC + "\\[[0-9;]*$"), "the cut ends inside an escape");
  assert.equal(width(cut), 10, "the cut cell is not the width it was asked for");
});

test("colour costs no columns", () => {
  // It also charged the escape BYTES against the budget, so a coloured table showed four fewer
  // characters of title than the same table with colour off.
  const plain = renderDashboard(snap(1), { columns: 80, color: false, keys: KEYS, view: view(1, 0) })
    .find((l) => l.includes("agent-01"));
  const painted = renderDashboard(snap(1), { columns: 80, color: true, keys: KEYS, view: view(1, 0) })
    .find((l) => l.includes("agent-01"));
  assert.equal(width(plain), width(painted), "the coloured row is a different width from the plain one");
});

test("clip marks a shortening; clipToWidth does not", () => {
  // TWO BEHAVIOURS, NOT ONE. A pane line is a slice of somebody's terminal and an ellipsis would be
  // a character the process never printed; a table cell cut without a mark reads as the whole value.
  assert.equal(clipToWidth("abcdef", 3), "abc");
  assert.equal(clip("abcdef", 3), "ab…");
  assert.equal(clipToWidth("abc", 3), "abc", "an exact fit was shortened");
  assert.equal(clip("abc", 3), "abc");
});

// ── the pane's half of the screen ───────────────────────────────────────────────────────────────

test("THE DASHBOARD IS DRAWN FOR THE WIDTH IT WILL GET", () => {
  // `composeConsole` receives the frame already rendered, so handing it a full-width one and letting
  // it cut produced a left column with `io`, `up` and `title` gone, a header reading `SERVI`, an
  // endpoint reading `http://` and every heading rule sliced mid-rule.
  assert.equal(dashboardColumns(160, true), 80);
  assert.equal(dashboardColumns(160, false), 160, "a view with no pane was narrowed anyway");
  assert.equal(dashboardColumns(79, true), 79, "below the pane minimum there is no pane to make room for");
});

// ── an agent cannot drive the operator's terminal ───────────────────────────────────────────────

test("A PROCESS'S OWN TITLE CANNOT MOVE OR CLEAR THE SCREEN", () => {
  // The only thing a managed agent writes directly into the operator's view. It arrives in an OSC
  // sequence the process chooses and was stored with `.slice(0, 120)` and nothing else.
  assert.equal(sanitizeTitle(`${ESC}[2J${ESC}[Hgotcha`), "[2J[Hgotcha", "an erase sequence survived");
  assert.equal(sanitizeTitle("claude\nSECOND"), "claudeSECOND", "a newline survived and would split a frame row");
  assert.equal(sanitizeTitle("a\rB"), "aB", "a carriage return survived and would overwrite the row");
  assert.equal(sanitizeTitle("a\tb"), "ab", "a tab survived and would jump to the next tab stop");
  assert.equal(sanitizeTitle(`a${String.fromCharCode(7)}b`), "ab", "a bell survived");
});

test("NEGATIVE CONTROL: an ordinary title is untouched", () => {
  // The expensive direction of over-stripping. Real titles carry punctuation, em-dashes and
  // non-Latin text, and mangling them would make the column useless.
  assert.equal(sanitizeTitle("✳ Claude Code — src/main.rs"), "✳ Claude Code — src/main.rs");
  assert.equal(sanitizeTitle("翻訳エージェント"), "翻訳エージェント");
});

test("the length cap is applied AFTER stripping", () => {
  // Otherwise a title padded with control bytes uses up the budget and the readable part is cut.
  const padded = `${"".repeat(200)}visible`;
  assert.equal(sanitizeTitle(padded), "visible");
  assert.equal(sanitizeTitle("x".repeat(500)).length, 120);
});

test("the hint is shown even when NOTHING is running", () => {
  // The state an operator is most likely sitting in taught them nothing at all: the hint lived
  // inside the `else` of the empty check. This file's own view says bindings that are not written
  // down are bindings nobody has, and the emptiest screen was the one enforcing that.
  const idle = { ...snap(0), history: { startedTotal: 0, lastExitAtMs: null } };
  const out = renderDashboard(idle, { columns: 90, keys: { enabled: true, canQuit: true }, view: { rows: [], selected: -1, mode: "dashboard", query: "" } }).join("\n");
  assert.match(out, /find/, "an idle environment names no bindings at all");
  assert.doesNotMatch(out, /attach/, "it offers attaching when there is nothing to attach to");
});
