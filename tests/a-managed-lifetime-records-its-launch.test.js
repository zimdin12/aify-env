// C1: a managed lifetime records the folder it was launched in and the definition it was built from, so the
// published state can say both. A malformed binding is recorded as none, never as half of one.
import test from "node:test";
import assert from "node:assert/strict";
import { ManagedLifetimes, launchDefinition } from "../lib/managed-lifetimes.mjs";

function owner() {
  const started = [];
  return { started, managedHost: () => ({ host: { startManaged: (r) => started.push(r), endManaged: () => ({}) },
    instance: "default", url: "http://127.0.0.1:4000" }) };
}

test("the record carries the launch's folder and definition", () => {
  const o = owner();
  const { register } = new ManagedLifetimes({ managedHost: o.managedHost }).spawn(
    { agentId: "a", cwd: "C:/work", definition: { storeId: "s", incarnation: 2, revision: 5 }, env: {} }, () => ({}));
  register("h", 42);
  assert.deepEqual([o.started[0].cwd, o.started[0].definition], ["C:/work", { storeId: "s", incarnation: 2, revision: 5 }]);
});

test("no folder and no binding are recorded as null", () => {
  const o = owner();
  new ManagedLifetimes({ managedHost: o.managedHost }).spawn({ agentId: "a", env: {} }, () => ({})).register("h", 42);
  assert.deepEqual([o.started[0].cwd, o.started[0].definition], [null, null]);
});

test("a malformed binding is none, never half", () => {
  for (const bad of [{}, { storeId: "", incarnation: 1, revision: 1 }, { storeId: "s", incarnation: 0, revision: 1 },
    { storeId: "s", incarnation: 1, revision: "1" }, "s:1:1", null, undefined]) {
    assert.equal(launchDefinition(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(launchDefinition({ storeId: "s", incarnation: 1, revision: 1, extra: true }), { storeId: "s", incarnation: 1, revision: 1 });
});
