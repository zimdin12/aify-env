#!/usr/bin/env node
// The existing title corpus stays on Runner's public export. This contract catches
// a copied facade implementation that would let that corpus bypass the new owner.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as titleOwner from "../lib/terminal-title.mjs";
import { lastTerminalTitle } from "../lib/runner.mjs";

test("Runner re-exports the terminal title owner's exact binding", () => {
  assert.deepEqual(Object.keys(titleOwner), ["lastTerminalTitle"],
    "the pure title owner exports only its scanner");
  assert.equal(lastTerminalTitle, titleOwner.lastTerminalTitle,
    "the facade re-exports the sole owner, not a copied implementation");
});
