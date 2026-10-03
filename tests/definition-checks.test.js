#!/usr/bin/env node
// The doctor's two definition rows (P0 C10, C11, D12): every branch, from the daemon's own answers.

import assert from "node:assert/strict";
import test from "node:test";

import { definitionsCheck, undefinedAgentsCheck } from "../lib/definition-checks.mjs";
import { STATE } from "../lib/health.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";

const sync = (over = {}) => ({ lastPushError: "", lastRequestError: "", accepted: true, published: { storeId: "s", revision: 4 }, ...over });
const plugin = (definitions) => ({ name: "aify-comms", state: { definitions } });
const row = (check) => [check.state, check.detail];

test("DEFINITIONS: published passes; a 404 says the service predates them; a failure says which call", () => {
  assert.deepEqual(row(definitionsCheck({ answered: true, plugins: [plugin(sync())] })),
    [STATE.PASSED, "this host's definitions are published: aify-comms has revision 4"]);
  assert.deepEqual(row(definitionsCheck({ answered: true, plugins: [plugin(sync({ accepted: false, lastPushError: "404: x" }))] })),
    [STATE.FAILED, "aify-comms does not accept definitions: it predates them"]);
  assert.deepEqual(row(definitionsCheck({ answered: true, plugins: [plugin(sync({ lastPushError: "0: down" }))] })),
    [STATE.FAILED, "aify-comms: not published (0: down)"]);
  assert.deepEqual(row(definitionsCheck({ answered: true, plugins: [plugin(sync({ lastRequestError: "500: boom" }))] })),
    [STATE.FAILED, "aify-comms: change requests not applied (500: boom)"]);
  assert.deepEqual(row(definitionsCheck({ answered: true, plugins: [plugin(sync({ published: null, accepted: null }))] })),
    [STATE.FAILED, "aify-comms: nothing published yet"]);
});

test("DEFINITIONS REFUSED: an id the service refused fails the row, naming it and the service's reason", () => {
  const refused = [{ id: "lead", reason: "defined on win32:host-b" }];
  assert.deepEqual(row(definitionsCheck({ answered: true, plugins: [plugin(sync({ refused }))] })),
    [STATE.FAILED, "aify-comms refused lead (defined on win32:host-b)"]);
  assert.equal(definitionsCheck({ answered: true, plugins: [plugin(sync({ refused: [] }))] }).state, STATE.PASSED,
    "control: nothing refused still passes");
});

test("DEFINITIONS UNANSWERED: no aify-env, one too old to report plugins, or no plugin that publishes", () => {
  assert.equal(definitionsCheck({ answered: false }).state, STATE.UNANSWERED);
  assert.equal(definitionsCheck({ answered: true, plugins: null }).state, STATE.UNANSWERED);
  assert.equal(definitionsCheck({ answered: true, plugins: [plugin(null), { name: "old", state: {} }] }).state, STATE.UNANSWERED);
  assert.equal(definitionsCheck({ answered: true, plugins: [] }).state, STATE.UNANSWERED);
});

const importable = (body, status = 200) => ({ ok: true, status, body });
const service = (name, ids, problem = "") => ({ service: name, agents: ids.map((id) => ({ id })), problem });

test("UNDEFINED AGENTS are named, compared without case, and pass: they run as before", () => {
  const check = undefinedAgentsCheck(importable({ services: [service("aify-comms", ["b", "Kept", "a"])], defined: ["kept"] }));
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /^2 agent\(s\) the services know on this host have no definition here: a, b \(they run as before; `aify-env agents import` defines them\)$/);
  assert.deepEqual(row(undefinedAgentsCheck(importable({ services: [service("aify-comms", ["kept"])], defined: ["kept"] }))),
    [STATE.PASSED, "every agent the services know on this host is defined here"]);
});

test("WITHDRAWN AGENTS are named apart: they are not started, so they do not 'run as before'", () => {
  const services = [{ service: "aify-comms", problem: "", agents: [{ id: "gone", withdrawn: true }, { id: "never" }] }];
  assert.deepEqual(row(undefinedAgentsCheck(importable({ services, defined: [] }))), [STATE.PASSED,
    "1 agent(s) the services know on this host have no definition here: never (they run as before; "
    + "`aify-env agents import` defines them); 1 withdrawn here, so not started: gone (`aify-env agents import` defines them again)"]);
});

test("UNDEFINED AGENTS UNKNOWN: no daemon, an older one, no store answer, or no service that answered", () => {
  assert.equal(undefinedAgentsCheck(null).state, STATE.UNANSWERED);
  assert.match(undefinedAgentsCheck(importable({}, 404)).detail, /predates definitions/);
  assert.match(undefinedAgentsCheck(importable({ services: [], defined: null, definedProblem: "the store is locked" })).detail, /the store is locked/);
  const silent = undefinedAgentsCheck(importable({ services: [service("aify-comms", [], "ECONNREFUSED")], defined: [] }));
  assert.deepEqual(row(silent), [STATE.UNANSWERED, "no service answered; not asked: aify-comms (ECONNREFUSED)"]);
  const partly = undefinedAgentsCheck(importable({ services: [service("a", ["x"]), service("b", [], "down")], defined: [] }));
  assert.match(partly.detail, /: x .*; not asked: b \(down\)$/);
});

test("THE DOCTOR asks for both rows: the plugins' sync state from /health, and /agents/importable", async () => {
  const endpoint = "http://example.invalid";
  const asked = [];
  const checks = await collectEnvironmentChecks({
    endpoint,
    knock: async (url) => {
      asked.push(url);
      if (url === `${endpoint}/health`) {
        return { ok: true, status: 200, body: { processes: [], terminals: { available: true }, advertiseCredentials: {},
          plugins: [plugin(sync({ accepted: false }))], build: "a", codeOnDisk: "a" } };
      }
      if (url === `${endpoint}/agents/importable`) return importable({ services: [service("aify-comms", ["lead"])], defined: [] });
      return { ok: true, status: 200, body: { agents: [], problem: "" } };
    },
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ available: true }),
    readCredentialStore: async () => ({ names: [] }),
  });
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  assert.equal(byId.definitions.state, STATE.FAILED);
  assert.match(byId["undefined-agents"].detail, /: lead /);
  assert.ok(asked.includes(`${endpoint}/agents/importable`));
});
