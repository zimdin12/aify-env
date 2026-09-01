#!/usr/bin/env node
// A record we could not read must not be destroyed by the next write.
//
// ENV-L1, external review round 7. `readOwned` degrades to an empty list for FOUR different reasons:
// the file is missing, its JSON does not parse, it is not an array, or every entry in it was
// unrecognisable. Only the first means there is genuinely nothing there. The caller cannot tell them
// apart -- that is the whole point of degrading -- so it reads "no processes" and then writes.
//
// AND EVERY WRITER READS FIRST. `recordStarted` and `recordStopped` both read-then-write, so an
// ordinary spawn is enough to erase a damaged file; `clearOwned` replaces it outright. Whatever the
// file named is then gone, and the processes it named are unreapable for ever with nothing left to
// say they existed. A leak the operator is TOLD about is recoverable; one with no trace is not.
//
// THE DEGRADATION ITSELF IS CORRECT AND IS NOT WHAT CHANGED. This module states its contract at the
// top: reads fail safe because an environment that refuses to start over damaged bookkeeping has
// turned a leak into an outage. Reading "nothing" is safe. Writing over what you could not read is
// not. So the guard preserves and continues -- it does not refuse -- and it lives in `write`, the one
// place all four writers pass through, so a fifth inherits it.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { clearOwned, readOwned, recordStarted, recordStopped } from "../lib/owned-processes.mjs";

const box = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-damaged-")), "owned.json");
const asideOf = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".unreadable-"));

/** The four shapes that all read as "no processes". */
const DAMAGED = {
  "unparseable json": "{ this is not json",
  "not an array": '{"processes": []}',
  "entries in an unknown shape": '[{"process": 4242, "name": "sc-architect"}]',
};

for (const [what, content] of Object.entries(DAMAGED)) {
  test(`a record with ${what} is preserved, not overwritten`, () => {
    const file = box();
    fs.writeFileSync(file, content);

    // The premise: this really does read as "nothing", which is why the caller then writes.
    assert.deepEqual(readOwned(file), [], `${what} did not read as empty, so this test proves nothing`);

    clearOwned(file, { keep: [] });

    const kept = asideOf(file);
    assert.equal(kept.length, 1, `${what} was overwritten with no copy kept`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(file), kept[0]), "utf8"), content,
      "the preserved copy is not what was there",
    );
  });
}

test("an ordinary spawn also preserves it, because recordStarted writes too", () => {
  // The path that actually fires first in practice. A reaper runs at boot; `recordStarted` runs every
  // time anything is launched, so this is the writer most likely to reach a damaged file.
  const file = box();
  fs.writeFileSync(file, "{ not json");
  recordStarted(file, { id: "p1", pid: 4242, service: "aify-comms", launcher: "/l/x", startedAt: 1 });

  assert.equal(asideOf(file).length, 1, "recordStarted destroyed a damaged record");
  // AND IT STILL RECORDED. Refusing would leave a live process untracked, which is the leak this
  // file exists to prevent -- preserving must not become an outage.
  assert.equal(readOwned(file).length, 1, "the new process was not recorded after the preserve");
});

test("recordStopped preserves it as well", () => {
  const file = box();
  fs.writeFileSync(file, "[[[");
  recordStopped(file, "p1");
  assert.equal(asideOf(file).length, 1, "recordStopped destroyed a damaged record");
});

// -- the cases that must NOT be preserved, or every write litters the directory -------------------

test("a healthy record is rewritten in place, with nothing kept aside", () => {
  // NEGATIVE CONTROL, and the one that matters for noise: a guard that fired on ordinary files would
  // leave a copy beside the record on every single spawn.
  const file = box();
  recordStarted(file, { id: "p1", pid: 1, service: "s", launcher: "/l/x", startedAt: 1 });
  recordStarted(file, { id: "p2", pid: 2, service: "s", launcher: "/l/x", startedAt: 2 });

  assert.deepEqual(asideOf(file), [], "a healthy record was moved aside");
  assert.equal(readOwned(file).length, 2);
});

test("an empty array is healthy, not damaged", () => {
  // `clearOwned` writes exactly this, so treating it as damaged would preserve a copy on every
  // shutdown -- and then preserve THAT on the next one.
  const file = box();
  fs.writeFileSync(file, "[]\n");
  clearOwned(file, { keep: [] });
  assert.deepEqual(asideOf(file), [], "an empty record was treated as damaged");
});

test("a missing file is the ordinary first run", () => {
  const file = box();
  assert.equal(fs.existsSync(file), false);
  recordStarted(file, { id: "p1", pid: 1, service: "s", launcher: "/l/x", startedAt: 1 });
  assert.deepEqual(asideOf(file), [], "a first run left a phantom copy aside");
  assert.equal(readOwned(file).length, 1);
});

test("a partly-readable record is NOT preserved, because nothing is lost", () => {
  // The boundary. One good entry among junk means the file parsed and this version understood it;
  // the junk is dropped by `isProcessRecord` exactly as the module documents. Preserving here would
  // fire on a file that is working as designed.
  const file = box();
  fs.writeFileSync(file, JSON.stringify([
    { id: "p1", pid: 4242, service: "s", launcher: "/l/x", startedAt: 1 },
    { nonsense: true },
  ]));
  assert.equal(readOwned(file).length, 1, "the premise changed: the good entry is no longer read");
  clearOwned(file, { keep: readOwned(file) });
  assert.deepEqual(asideOf(file), [], "a record that was understood was moved aside anyway");
});
