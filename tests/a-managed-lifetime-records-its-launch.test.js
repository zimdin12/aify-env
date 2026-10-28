// C1: a managed lifetime records the folder it was launched in and the definition it was built from, so the
// published state can say both. A malformed binding is recorded as none, never as half of one.
import test from "node:test";
import assert from "node:assert/strict";
import { BINDING_CARRIERS, ManagedLifetimes, launchDefinition } from "../lib/managed-lifetimes.mjs";

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

// THE BINDING TRAVELS TO THE CHILD (0.9.9): aify-wrapper compares it with the definition file it reads, so the
// instructions a managed claude starts with are the admitted revision's or none (the P2 in aify-wrapper c4818238).
const childEnv = (spec) => {
  let env = null;
  new ManagedLifetimes({ managedHost: owner().managedHost }).spawn(spec, (prepared) => { env = prepared.env; return {}; });
  return env;
};

test("a start built from a definition tells its child the admitted incarnation and revision, as decimal text", () => {
  const env = childEnv({ agentId: "a", definition: { storeId: "s", incarnation: 3, revision: 17 }, env: { PATH: "/bin" } });
  assert.deepEqual([env.AIFY_DEFINITION_INCARNATION, env.AIFY_DEFINITION_REVISION], ["3", "17"]);
  assert.equal(env.PATH, "/bin", "CONTROL: the rest of the env is the spec's");
});

test("an inherited binding never reaches the child: replaced by the admitted one, or dropped when there is none", () => {
  const inherited = { AIFY_DEFINITION_INCARNATION: "9", aify_definition_revision: "99", PATH: "/bin" };
  const bound = childEnv({ agentId: "a", definition: { storeId: "s", incarnation: 3, revision: 17 }, env: inherited });
  assert.deepEqual([bound.AIFY_DEFINITION_INCARNATION, bound.AIFY_DEFINITION_REVISION, bound.aify_definition_revision], ["3", "17", undefined]);
  for (const definition of [undefined, null, { storeId: "s", incarnation: 0, revision: 1 }]) {
    const env = childEnv({ agentId: "a", definition, env: inherited });
    for (const name of BINDING_CARRIERS) {
      assert.ok(!Object.keys(env).some((key) => key.toUpperCase() === name), `${name} reached a child with binding ${JSON.stringify(definition)}`);
    }
  }
});
