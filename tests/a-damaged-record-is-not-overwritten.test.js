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
// not. So the guard preserves and continues -- it does not refuse -- and it lives in OwnedProcessRecord,
// the one owner every writer passes through, so a fifth inherits it.
//
// CORRECTED FOR ISSUE 17. Two premises here were the old writer's behaviour, not the contract, and they
// changed on purpose rather than being loosened:
//   - A clear or a stop has nothing to remove from bytes it cannot read, so it no longer copies them
//     aside and writes "[]" over them: it leaves them exactly where they are. Only a write that must
//     record something (a spawn) copies damaged bytes aside first.
//   - A list is understood even when some or all of its rows are not. Those rows used to be dropped by
//     the next write ("nothing is lost", which was false: whatever they named was lost). They are now
//     kept in place, byte for byte, and still never read as processes.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { clearOwned, readOwned, recordStarted, recordStopped } from "../lib/owned-processes.mjs";
import { ProcessEffectTripwire } from "./fixtures/no-process-effects.mjs";

new ProcessEffectTripwire();

const box = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-damaged-")), "owned.json");
const asideOf = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".unreadable-"));

/** Shapes whose bytes cannot be kept as rows: unparseable, or not a list at all. */
const DAMAGED = {
  "unparseable json": "{ this is not json",
  "not an array": '{"processes": []}',
};

for (const [what, content] of Object.entries(DAMAGED)) {
  test(`a record with ${what} is left exactly as it is by a clear or a stop`, () => {
    // Was "preserved aside, then overwritten with []". Neither writer can identify a row in these bytes,
    // so neither has anything to remove: the original stays in place, which loses nothing at all.
    const file = box();
    fs.writeFileSync(file, content);

    // The premise: this really does read as "nothing", which is why the caller then writes.
    assert.deepEqual(readOwned(file), [], `${what} did not read as empty, so this test proves nothing`);

    clearOwned(file, { keep: [] });
    recordStopped(file, "p1");

    assert.equal(fs.readFileSync(file, "utf8"), content, `${what} was overwritten by a clear or a stop`);
    assert.deepEqual(asideOf(file), [], "bytes left in place were copied aside as well");
  });

  test(`a record with ${what} is copied aside before a spawn replaces it`, () => {
    // The writer most likely to reach a damaged file: it runs every time anything is launched. AND IT
    // STILL RECORDS. Refusing would leave a live process untracked, the leak this file exists to prevent.
    const file = box();
    fs.writeFileSync(file, content);
    recordStarted(file, { id: "p1", pid: 4242, service: "aify-comms", launcher: "/l/x", startedAt: 1 });

    const kept = asideOf(file);
    assert.equal(kept.length, 1, `${what} was overwritten with no copy kept`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(file), kept[0]), "utf8"), content,
      "the preserved copy is not what was there",
    );
    assert.equal(readOwned(file).length, 1, "the new process was not recorded after the preserve");
  });
}

test("a list whose entries are ALL in an unknown shape keeps them in place through every writer", () => {
  // Was in the table above and moved aside. A list parses, so its rows can be kept as they are; what a
  // newer writer recorded stays where the next version can read it, and this version still trusts none.
  const file = box();
  const unknown = '{"process": 4242, "name": "sc-architect"}';
  fs.writeFileSync(file, `[${unknown}]`);
  assert.deepEqual(readOwned(file), [], "premise: the unknown row is not read as a process");

  recordStarted(file, { id: "p1", pid: 1, service: "s", launcher: "/l/x", startedAt: 1 });
  clearOwned(file, { keep: [] });
  recordStopped(file, "p1");

  assert.ok(fs.readFileSync(file, "utf8").includes(unknown), "an unknown row was dropped by a write");
  assert.deepEqual(readOwned(file), [], "control: the recognised row was still removed");
  assert.deepEqual(asideOf(file), [], "rows kept in place were also copied aside");
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

test("a partly-readable record keeps its unreadable rows in place, and is not copied aside", () => {
  // CORRECTED PREMISE. This said the junk "is dropped by `isProcessRecord` exactly as the module
  // documents" and that nothing is lost. Dropping it IS the loss: a row this version cannot read may
  // name a process a newer writer recorded. Reading still leaves it out; writing now leaves it in.
  const file = box();
  fs.writeFileSync(file, JSON.stringify([
    { id: "p1", pid: 4242, service: "s", launcher: "/l/x", startedAt: 1 },
    { nonsense: true },
  ]));
  assert.equal(readOwned(file).length, 1, "the premise changed: the good entry is no longer read");
  clearOwned(file, { keep: readOwned(file) });
  recordStarted(file, { id: "p2", pid: 2, service: "s", launcher: "/l/x", startedAt: 2 });
  clearOwned(file, { keep: [] });

  // Positive: the unknown row survived a spawn's write and a clear's, and the recognised rows went as asked.
  assert.ok(fs.readFileSync(file, "utf8").includes('{"nonsense":true}'), "the unreadable row was discarded");
  assert.deepEqual(readOwned(file), [], "a recognised row was not removed");
  // Negative: nothing was copied aside for a file that was understood.
  assert.deepEqual(asideOf(file), [], "a record that was understood was moved aside anyway");
});
