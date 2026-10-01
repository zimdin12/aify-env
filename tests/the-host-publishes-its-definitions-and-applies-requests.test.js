#!/usr/bin/env node
// The definition sync (P0 C3, C4, the host's half): a real store in a temporary directory and an api
// that records what it is sent. What the service does with those calls is witnessed in aify-comms.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { CommsApiError } from "../lib/plugins/aify-comms/api.mjs";
import { DefinitionSync, FREE_SINCE, PUSH_INTERVAL_MS } from "../lib/plugins/aify-comms/definition-sync.mjs";

const ALL = new Set(["claude", "codex", "hermes"]);
const ENV = "win32:host-a:default";
const MACHINE = "win32:host-a";
const agent = (over = {}) => ({ name: "Lead", role: "coder", harness: "claude", mode: "managed", workspace: "C:/work",
  model: "m1", effort: "", instructions: "", env: {}, herdrSpace: true, ...over });

/** `batches[n]` is what the n-th claim hands out; past the end, nothing. */
function recordingApi({ batches = [], pushAnswers = [], claimError = null, pushError = null } = {}) {
  const calls = [];
  let claims = 0;
  return {
    calls,
    async claimDefinitionRequests(environmentId, machineId) {
      calls.push(["claim", environmentId, machineId]);
      if (claimError) throw claimError;
      return { requests: batches[claims++] || [] };
    },
    async reportDefinitionRequest(environmentId, requestId, machineId, result) {
      calls.push(["report", requestId, result]);
      return { ok: true };
    },
    async pushDefinitions(environmentId, body) {
      calls.push(["push", environmentId, body]);
      if (pushError) throw pushError;
      return pushAnswers.shift() || { ok: true, refused: [] };
    },
  };
}

async function defined(over = {}) {
  const store = new DefinitionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "aify-sync-")), lockWaitMs: 300, ...over });
  await store.set("lead", agent(), { installed: ALL });
  return store;
}

//: The clock starts at 0, as a host's never does, so the first pass is told to publish by having
//: published nothing yet rather than by a large clock reading.
function syncWith(store, api, clock = { now: 0 }) {
  return new DefinitionSync({ api, store, installed: () => ALL, machineId: MACHINE, now: () => clock.now });
}

const pushes = (api) => api.calls.filter(([kind]) => kind === "push").map(([, , body]) => body);

test("THE FIRST PASS PUBLISHES the complete snapshot, fenced by machine; the next waits for the interval", async () => {
  const store = await defined();
  const api = recordingApi();
  const clock = { now: 0 };
  const sync = syncWith(store, api, clock);
  await sync.pass(ENV);
  const [body] = pushes(api);
  const { storeId } = await store.list();
  assert.deepEqual([body.machineId, body.storeId, body.entries.map((e) => [e.id, e.state, e.revision])],
    [MACHINE, storeId, [["lead", "valid", 1]]]);
  assert.match(body.snapshotDigest, /^[0-9a-f]{64}$/);
  assert.equal(api.calls[0][1], ENV, "the claim names this environment");
  clock.now += PUSH_INTERVAL_MS - 1;
  await sync.pass(ENV);
  assert.equal(pushes(api).length, 1, "nothing changed and the interval has not passed");
  clock.now += 1;
  await sync.pass(ENV);
  assert.equal(pushes(api).length, 2, "the interval passed");
  assert.deepEqual(sync.state.published, { storeId, revision: body.revision });
});

test("A REQUEST is applied to the file, reported, and only then published", async () => {
  const store = await defined();
  const { storeId } = await store.list();
  const request = { id: "req-1", agentId: "lead", storeId, expectedIncarnation: 1, expectedRevision: 1, patch: { model: "m2" } };
  // Handed out on the SECOND pass, inside the interval: only the applied change can cause its push.
  const api = recordingApi({ batches: [[], [request]] });
  const clock = { now: 0 };
  const sync = syncWith(store, api, clock);
  await sync.pass(ENV);
  clock.now += 1;
  const after = api.calls.length;
  await sync.pass(ENV);
  assert.deepEqual(api.calls.slice(after).map(([kind]) => kind), ["claim", "report", "push"]);
  assert.deepEqual(api.calls[after + 1], ["report", "req-1", { status: "done", outcome: "", resultIncarnation: 1, resultRevision: 2 }]);
  assert.deepEqual(pushes(api).at(-1).entries[0].definition.model, "m2", "the published snapshot carries the change");
  assert.equal(sync.state.requestsHandled, 1);
});

test("A REFUSED REQUEST is reported refused and changes nothing published", async () => {
  const store = await defined();
  const { storeId } = await store.list();
  const stale = { id: "req-2", agentId: "lead", storeId, expectedIncarnation: 1, expectedRevision: 9, patch: { model: "m2" } };
  // Handed out on the SECOND pass, after the first has published: only a refusal is left to cause a push.
  const api = recordingApi({ batches: [[], [stale]] });
  const clock = { now: 0 };
  const sync = syncWith(store, api, clock);
  await sync.pass(ENV);
  clock.now += 1;
  const after = api.calls.length;
  await sync.pass(ENV);
  assert.deepEqual(api.calls.slice(after).map(([kind]) => kind), ["claim", "report"], "a refusal is not a reason to publish");
  assert.equal(api.calls.at(-1)[2].status, "refused");
});

test("AN INCOMPLETE SNAPSHOT IS NEVER PUBLISHED: the service would withdraw what it lacks", async () => {
  // A store whose directory listing fails, over a directory that defines an agent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aify-sync-incomplete-"));
  await new DefinitionStore({ dir, lockWaitMs: 300 }).set("lead", agent(), { installed: ALL });
  const blind = new DefinitionStore({ dir, lockWaitMs: 300, readdirSync: (target, options) => {
    if (options?.withFileTypes) { const error = new Error("denied"); error.code = "EACCES"; throw error; }
    return fs.readdirSync(target, options);
  } });
  const api = recordingApi();
  const sync = syncWith(blind, api);
  await sync.pass(ENV);
  assert.deepEqual(pushes(api), []);
  assert.match(sync.state.lastPushError, /^incomplete: /);
});

test("AN ID FREED SINCE is taken at once: a fresh revision is published, and only one", async () => {
  const store = await defined();
  const api = recordingApi({ pushAnswers: [{ ok: true, refused: [{ id: "lead", reason: FREE_SINCE }] },
    { ok: true, refused: [{ id: "lead", reason: FREE_SINCE }] }] });
  const sync = syncWith(store, api);
  await sync.pass(ENV);
  const [first, second, ...more] = pushes(api);
  assert.equal(second.revision, first.revision + 1, "the fresh push carries a new revision");
  assert.deepEqual(more, [], "a second refusal of the same kind waits for the next pass");
  const other = recordingApi({ pushAnswers: [{ ok: true, refused: [{ id: "lead", reason: "defined on win32:host-b" }] }] });
  await syncWith(store, other).pass(ENV);
  assert.equal(pushes(other).length, 1, "control: another machine's id is not retried");
});

test("THE SERVICE UNREACHABLE: the claim's failure is recorded and the push still tried; a failed push is retried next pass", async () => {
  const store = await defined();
  const down = new CommsApiError("connect ECONNREFUSED", { status: 0 });
  const api = recordingApi({ claimError: down, pushError: down });
  const clock = { now: 0 };
  const sync = syncWith(store, api, clock);
  await sync.pass(ENV);
  assert.equal(sync.state.lastRequestError, "unreachable: connect ECONNREFUSED");
  assert.equal(sync.state.lastPushError, "unreachable: connect ECONNREFUSED");
  clock.now += 1;
  await sync.pass(ENV);
  assert.equal(pushes(api).length, 2, "the failed push is tried again, well inside the interval");
});

test("A SERVICE OLDER THAN DEFINITIONS: its 404s are logged once each, and `accepted` says so (C11)", async () => {
  const store = await defined();
  const notFound = () => new CommsApiError("not found", { status: 404, path: "/x" });
  const api = recordingApi({ claimError: notFound(), pushError: notFound() });
  const logged = [];
  const sync = new DefinitionSync({ api, store, installed: () => ALL, machineId: MACHINE, now: () => 0, log: (line) => logged.push(line) });
  assert.equal(sync.state.accepted, null, "nothing asked yet, nothing known");
  for (let pass = 0; pass < 3; pass += 1) await sync.pass(ENV);
  assert.equal(pushes(api).length, 3, "it still tries every pass");
  assert.deepEqual(logged, ["aify-comms definition requests failed (404: not found)", "aify-comms definitions not published (404: not found)"]);
  assert.equal(sync.state.accepted, false);
});

test("A FAILURE THAT CLEARS is logged again when it returns; one that is not a 404 leaves `accepted` alone", async () => {
  const store = await defined();
  const api = recordingApi({ pushError: new CommsApiError("down", { status: 0, path: "/x" }) });
  const logged = [];
  const clock = { now: 0 };
  const sync = new DefinitionSync({ api, store, installed: () => ALL, machineId: MACHINE, now: () => clock.now, log: (line) => logged.push(line) });
  await sync.pass(ENV);
  await sync.pass(ENV);
  assert.equal(logged.length, 1);
  assert.equal(sync.state.accepted, true, "the claim was answered, so the service accepts definitions");
  const pushError = api.pushDefinitions;
  api.pushDefinitions = async () => ({ ok: true, refused: [] });
  await sync.pass(ENV);
  api.pushDefinitions = pushError;
  clock.now = PUSH_INTERVAL_MS;
  await sync.pass(ENV);
  assert.equal(logged.length, 2, "logged again after it had cleared");
});
