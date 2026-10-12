#!/usr/bin/env node
// What this host admits when the service asks it to start a terminal (C7, D8). A named agent no definition here
// names is not born, whatever the service asked: the pre-tag review of 0.9 (F2) drove the service's console path
// into exactly that launch, `claude-aify --aify-agent coder --auto` with `definition: null`.

import assert from "node:assert/strict";
import test from "node:test";

import { automaticStartAdmission } from "../lib/plugins/aify-comms/automatic-start-admission.mjs";

const reading = (definitions = []) => ({ storeId: "s1", definitions, unreadable: [], conflict: null, enumerationFailed: null });

function admit(definitions) {
  const births = [];
  const admission = automaticStartAdmission({ definitions: { list: async () => reading(definitions) }, agents: null });
  return { births, run: (launch) => admission(launch, async () => { births.push(launch.agentId || "(no agent)"); return "born"; }) };
}

test("A NAMED AGENT NO DEFINITION HERE NAMES is refused, and nothing is born", async () => {
  const { births, run } = admit();
  assert.deepEqual(await run({ agentId: "coder", definition: null }), { refused: "automatic-agent-undefined" });
  assert.deepEqual(births, []);
});

test("A TERMINAL FOR NO AGENT still starts", async () => {
  const { births, run } = admit();
  assert.deepEqual(await run({ agentId: "", definition: null }), { produced: "born" });
  assert.deepEqual(births, ["(no agent)"]);
});

test("A DEFINED AGENT'S LAUNCH WITHOUT ITS DEFINITION is still refused as before", async () => {
  const { births, run } = admit([{ id: "coder", problems: [] }]);
  assert.deepEqual(await run({ agentId: "coder", definition: null }), { refused: "automatic-definition-unavailable" });
  assert.deepEqual(births, []);
});
