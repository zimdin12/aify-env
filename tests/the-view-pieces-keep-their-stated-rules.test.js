// The pieces every pane of the view is drawn with (lib/tui-parts.mjs), each held to the rule its own comment states.
//
// They were private to lib/tui.mjs and reached only through renderDashboard until the 0.9.6 split made them the
// exports the panes import. The render tests still cover them in place; these say what each one promises on its own.

import { test } from "node:test";
import assert from "node:assert/strict";

import { QUIET, WORKING } from "../lib/activity.mjs";
import {
  STATE_STYLE, activityMark, exitDescription, fittedHints, relativeAge, rowMarker, statusCell, withoutLeadingEndpoint,
} from "../lib/tui-parts.mjs";

test("STATE_STYLE: every check state has a glyph AND a word, and unanswered is not drawn as failed", () => {
  for (const state of ["passed", "failed", "unanswered"]) {
    assert.ok(STATE_STYLE[state].mark && STATE_STYLE[state].word, state);
  }
  assert.notEqual(STATE_STYLE.unanswered.mark, STATE_STYLE.failed.mark);
  assert.notEqual(STATE_STYLE.unanswered.word, STATE_STYLE.failed.word);
});

test("rowMarker: a number only where a key can jump to it, and the attached cursor differs from the selected one", () => {
  assert.equal(rowMarker(0, { selected: 0, mode: "dashboard" }, false), "❯1");
  assert.equal(rowMarker(0, { selected: 0, mode: "pty" }, false), "▶1");
  assert.equal(rowMarker(8, { selected: 0 }, false), " 9");
  assert.equal(rowMarker(9, { selected: 0 }, false), "  ", "past nine there is no key to press");
});

test("activityMark: producing, quiet, and NOTHING for unmeasured", () => {
  assert.equal(activityMark(WORKING, false), "●");
  assert.equal(activityMark(QUIET, false), "○");
  assert.equal(activityMark("unknown", false), " ");
});

test("statusCell: the word in the dashboard's terms, and a dash when there is none", () => {
  assert.equal(statusCell(undefined, false), "—");
  assert.equal(statusCell("", false), "—");
  assert.match(statusCell("idle", false), /online$/, "aify-env's idle is the dashboard's online");
});

test("fittedHints: whole items only, the most discoverable dropped first, the last one standing kept", () => {
  const items = [{ text: "↑↓ move", drop: 2 }, { text: "1-9 jump", drop: 3 }, { text: "g find", drop: 0 }, { text: "q quit", drop: 0 }];
  assert.equal(fittedHints(items, 200, " · "), "↑↓ move · 1-9 jump · g find · q quit");
  assert.equal(fittedHints(items, 30, " · "), "↑↓ move · g find · q quit", "jump goes first, and q quit survives");
  assert.equal(fittedHints(items, 22, " · "), "g find · q quit");
  assert.equal(fittedHints([{ text: "a very long only hint", drop: 9 }], 5, " · "), "a very long only hint");
});

test("relativeAge: nothing without a clock or a timestamp, and never a time in the future", () => {
  assert.equal(relativeAge(undefined, 1000), null);
  assert.equal(relativeAge(1000, undefined), null);
  assert.equal(relativeAge(5000, 1000), null);
  assert.equal(relativeAge(0, 59_000), "59s ago");
  assert.equal(relativeAge(0, 3_660_000), "1h1m ago");
});

test("exitDescription: a signal, a code (zero included) and no evidence stay three different answers", () => {
  assert.equal(exitDescription({ exitSignal: "SIGKILL", exitCode: 1 }, false), "killed by SIGKILL");
  assert.equal(exitDescription({ exitCode: 0 }, false), "exited cleanly (0)");
  assert.equal(exitDescription({ exitCode: 3 }, false), "exited 3");
  assert.equal(exitDescription({ reason: "stopped" }, false), "stopped on request");
  assert.equal(exitDescription({ reason: "reaped" }, false), "found already gone");
  assert.equal(exitDescription({}, false), "no exit reported");
});

test("withoutLeadingEndpoint: the address goes only as a prefix, never from inside a sentence", () => {
  assert.equal(withoutLeadingEndpoint("http://h:1 reports healthy", "http://h:1"), "reports healthy");
  assert.equal(withoutLeadingEndpoint("no answer from http://h:1: ECONNREFUSED", "http://h:1"), "no answer from http://h:1: ECONNREFUSED");
  assert.equal(withoutLeadingEndpoint("http://h:1", "http://h:1"), "http://h:1");
});
