// A notice is one frame row, whatever the message it carries.
//
// THE DEFECT (v0.7 scan, F4). `CommsApiError` carries up to 300 characters of an HTTP response body,
// and that reaches NOTICES through the plugin's log. A proxy's HTML error page puts a raw newline
// inside one frame line; the frame writer addresses rows absolutely, so the screen moves out from
// under its model -- the 2026-09-04 layout breakage again, through the channel built to fix it.

import assert from "node:assert/strict";
import test from "node:test";

import { createNotices } from "../lib/notices.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const ESC = String.fromCharCode(27);
const LF = "\n";

const SNAPSHOT = {
  version: "0.7.0", endpoint: "http://127.0.0.1:8802", terminals: { available: true },
  services: [], checks: [], processes: [], history: { startedTotal: 0 },
};

const framed = (notices, extra = {}) => renderDashboard({ ...SNAPSHOT, notices, ...extra }, { columns: 120 });
const rowsWithBreaks = (lines) => lines.filter((line) => /[\n\r]/.test(line));

test("a multi-line error body becomes ONE row in the frame", () => {
  const notices = createNotices({ now: () => 0 });
  notices.add(`POST /x -> 502: <html>${LF}<body>Bad gateway</body>${LF}</html>`);
  const lines = framed(notices.recent());
  assert.deepEqual(rowsWithBreaks(lines), [], "a notice split a frame row");
  assert.ok(lines.some((line) => line.includes("502: <html> <body>Bad gateway</body> </html>")),
    "the notice's text was lost rather than folded onto one row");
});

test("a notice cannot carry a terminal command onto the screen", () => {
  const notices = createNotices({ now: () => 0 });
  notices.add(`failed ${ESC}[2J${ESC}]52;c;eA==${String.fromCharCode(7)} here`);
  const text = notices.recent()[0].text;
  assert.equal(text.includes(ESC), false, JSON.stringify(text));
  assert.equal(text, "failed here");
});

test("CONTROL: a single-line notice is unchanged", () => {
  const notices = createNotices({ now: () => 0 });
  notices.add("terminal p1 output not delivered: fetch failed");
  assert.equal(notices.recent()[0].text, "terminal p1 output not delivered: fetch failed");
  assert.deepEqual(rowsWithBreaks(framed(notices.recent())), []);
});

test("THE TABLE GUARDS EVERY CELL, so the next unsanitised producer cannot do this again", () => {
  // Notices built by hand, bypassing `createNotices`, and a process title that was never sanitised.
  const lines = framed([{ text: `one${LF}two`, count: 1, atMs: 0 }], {
    processes: [{ id: "p1", label: `al${LF}pha`, title: `a${ESC}[2Jb` }],
  });
  assert.deepEqual(rowsWithBreaks(lines), [], "a table cell split a frame row");
  assert.equal(lines.some((line) => line.includes(`${ESC}[2J`)), false, "a cell carried a screen clear");
});
