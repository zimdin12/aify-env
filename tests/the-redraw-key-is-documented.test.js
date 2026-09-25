// Ctrl+L, the one way to recover a smeared screen, is a declared and documented key.
//
// THE DEFECT (v0.7 scan, F15). Several things can smear this view -- a stray write, an external
// resize, a line a producer should not have sent -- and the recovery is Ctrl+L. It was absent from
// `--help`, from the README key table and from VIEW_KEYS, so the key-documentation sweep could not
// ask for it: it walks printable characters, and a control key is not one.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { VIEW_KEYS, keyName, routeKey } from "../lib/keys.mjs";
import { USAGE } from "../lib/usage.mjs";

const CTRL_L = String.fromCharCode(12);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const README = fs.readFileSync(path.join(HERE, "..", "README.md"), "utf8");

test("Ctrl+L is a declared view key, and pressing it redraws", () => {
  assert.ok(CTRL_L in VIEW_KEYS, "Ctrl+L is not declared");
  assert.equal(routeKey(CTRL_L, { mode: "dashboard", selected: 0, count: 1 }).action, "repaint");
});

test("a control key is named the way the documents write it", () => {
  assert.equal(keyName(CTRL_L), "Ctrl+L");
  assert.equal(keyName("g"), "g", "a printable key is its own name");
});

test("Ctrl+L is in `aify-env --help` and in the README table", () => {
  assert.match(USAGE, /^\s+Ctrl\+L\s{2,}/m);
  assert.ok(README.includes("| `ctrl+l` |"), "the README key table does not list ctrl+l");
});
