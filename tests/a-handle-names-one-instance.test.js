#!/usr/bin/env node
// A process handle names one process in ONE instance of this environment, and says which.
//
// THE DEFECT, proven against two real daemons on 2026-08-29 before a line of this was written. The
// counter lived at module scope and started at zero every boot, so the next instance minted `p1`
// again -- for a different agent, on a different pid:
//
//     instance 1 (pid 113896)   agent-A -> p1, pid 136412
//     instance 2 (pid  91856)   agent-B -> p1, pid 67432
//
// WHY THAT IS NOT MERELY UNTIDY. aify-comms holds a handle across a restart ON PURPOSE. Its
// `delegated-exit.mjs` says so: when the output stream ends and this environment cannot be asked
// whether the process survived, it HOLDS the terminal rather than reporting a live process dead,
// because a stale row heals and an orphaned process does not. So during a restart it keeps `p1`, and
// when this environment comes back it asks "is p1 still listed". It got YES about a stranger, and
// three things act on that answer: `reattachLostStreams` pipes another agent's output into that
// terminal and console, `label-reconciler` writes the wrong agent name onto that row -- the AGENT
// column the operator had just asked for -- and `terminal-runtime.stop()` calls stop on it, killing
// an agent nobody asked to stop.
//
// FAIL CLOSED, IN THE ID ITSELF. The alternative was an `instance` field beside the id for consumers
// to compare, and a consumer that forgets the comparison is exactly where it started with no way to
// notice. A qualified id makes a stale handle simply not match, in every consumer, with no consumer
// change at all. `/health` still NAMES the instance, because "your handle is from an older instance"
// and "that process is gone" send an operator to different places.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ProcessRegistry, mintInstanceId } from "../lib/process-registry.mjs";
import { shortHandle } from "../lib/tui.mjs";

test("THE COLLISION: two instances do not mint the same handle", () => {
  // The reproduction, at the level the daemons showed it: first process of one instance against first
  // process of the next. Not a rare late collision -- the counter reset made `p1` the MOST likely id
  // to be reused, and the first thing any restart hands out.
  const first = new ProcessRegistry().add({ service: "aify-comms", pid: 136412 });
  const second = new ProcessRegistry().add({ service: "aify-comms", pid: 67432 });
  assert.notEqual(
    first.id, second.id,
    "a restarted environment minted the same handle again, so a consumer holding the old one is "
      + "pointed at a different agent's process",
  );
});

test("and the handle says which instance it came from", () => {
  const registry = new ProcessRegistry({ instance: "abc123" });
  assert.equal(registry.instance, "abc123");
  assert.equal(registry.add({ service: "aify-comms", pid: 1 }).id, "abc123-p1");
});

test("ids stay monotonic and readable within one instance", () => {
  // The operator reads these in the TUI. Qualifying them must not turn them into opaque uuids, and
  // the sequence still has to say which process started first.
  const registry = new ProcessRegistry({ instance: "abc123" });
  const ids = [1, 2, 3].map((pid) => registry.add({ service: "aify-comms", pid }).id);
  assert.deepEqual(ids, ["abc123-p1", "abc123-p2", "abc123-p3"]);
});

test("the counter belongs to the registry, not the module", () => {
  // It was module-scope, which is why a test could not reproduce the collision at all: two registries
  // in one process shared one counter and never handed out the same number.
  const a = new ProcessRegistry({ instance: "aaa" });
  const b = new ProcessRegistry({ instance: "bbb" });
  a.add({ service: "s", pid: 1 });
  a.add({ service: "s", pid: 2 });
  assert.equal(b.add({ service: "s", pid: 3 }).id, "bbb-p1",
    "a fresh registry started counting from where another one left off");
});

test("THE INSTANCE ID IS A FULL UUID, because a short one is only probably unique", () => {
  // THE FIRST VERSION OF THIS WAS WRONG AND THIS TEST WAS THE WEAKER HALF OF WHY. It minted
  // `randomUUID().slice(0, 6)` -- 24 bits -- to keep the TUI column narrow, and asserted that fifty
  // mints did not repeat. Fifty mints cannot establish non-reuse: a reviewer did the arithmetic, and
  // birthday collision reaches about 1% after 581 boots and 50% after 4,823. Comments elsewhere in
  // this file say a stale handle "cannot match", and against 24 bits that was a hope.
  //
  // So the assertion is on the PROPERTY, not on a sample. 122 random bits either are there or are not,
  // and counting collisions in a loop can only ever fail to find one.
  const id = mintInstanceId();
  assert.match(
    id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    `${id} is not a full uuid, so handle uniqueness across boots is probabilistic`,
  );
  assert.notEqual(mintInstanceId(), mintInstanceId(), "two mints returned the same value, which no "
    + "amount of entropy explains");
});

test("READABILITY IS THE VIEW'S JOB, and the identity stays whole", () => {
  // The reason the short id was reached for. A 39-character handle is right for identity and wrong
  // for a table column, and the fix belongs in the renderer -- an id trimmed to fit a column is an id
  // that collides to fit a column.
  const registry = new ProcessRegistry({ instance: "550e8400-e29b-41d4-a716-446655440000" });
  const { id } = registry.add({ service: "aify-comms", pid: 1 });
  assert.equal(id, "550e8400-e29b-41d4-a716-446655440000-p1", "the stored handle must be whole");
  assert.equal(shortHandle(id), "0000-p1");
  assert.ok(shortHandle(id).length < 12, "the projection is not narrow enough to be worth having");
});

test("the projection never invents a handle it was not given", () => {
  // A renderer that reformatted an unexpected shape would show an operator an id that matches nothing
  // they can grep for.
  assert.equal(shortHandle("p1"), "p1");
  assert.equal(shortHandle(""), "");
  assert.equal(shortHandle(undefined), "");
});

test("a stale handle does not match a live listing", () => {
  // The consumer's actual question, asked the way `processStillListed` asks it: is this id in the
  // listing. Before the fix the answer was yes.
  const before = new ProcessRegistry();
  const stale = before.add({ service: "aify-comms", pid: 136412 }).id;

  const after = new ProcessRegistry();
  after.add({ service: "aify-comms", pid: 67432 });
  assert.equal(
    after.list().some((entry) => entry.id === stale), false,
    "a handle minted by a previous instance was found in this one's listing, which is the yes that "
      + "sent another agent's output, label and stop to the wrong process",
  );
});

test("an empty listing still cannot match a stale handle", () => {
  // NEGATIVE CONTROL on the test above: it must fail for the right reason. If `list()` returned
  // nothing here, the assertion would pass whether or not ids were qualified.
  const after = new ProcessRegistry();
  assert.equal(after.list().length, 0);
  const populated = new ProcessRegistry();
  populated.add({ service: "aify-comms", pid: 1 });
  assert.equal(populated.list().length, 1, "the listing cannot see its own entries, so the check "
    + "above proves nothing about matching");
});
