// Where an aify-env instance keeps its own files (lib/instance-files.mjs).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { instanceFile } from "../lib/instance-files.mjs";

test("AN INSTANCE NAME IS A FILE NAME, so one that would leave the directory is refused", () => {
  assert.equal(instanceFile("/home", "default", "generation"), path.join("/home", "env", "default.generation"));
  for (const bad of ["../x", "", "a/b", "a\\b", ".hidden", undefined]) {
    assert.throws(() => instanceFile("/home", bad, "generation"), /not an instance name/, String(bad));
  }
});
