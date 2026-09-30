// Runs one DefinitionStore call and KILLS ITS OWN PROCESS at a named boundary: no finally block, no
// lock release, nothing after the step that just became durable. That is the interruption the store
// must recover from, exercised for real rather than simulated in-process.
//
// usage: node crash-at.mjs <dir> <json {call, id, agent?, options?, crashAt: {name, op?, nth?}}>
// Exit 0 means the call finished without reaching the boundary, which the caller treats as a failure
// of the test's setup, never as a pass.

import { DefinitionStore } from "../../../lib/agent-definitions.mjs";

const [dir, specText] = process.argv.slice(2);
const spec = JSON.parse(specText);
let seen = 0;
const boundary = (name, context) => {
  if (name !== spec.crashAt.name) return;
  if (spec.crashAt.op && context.op !== spec.crashAt.op) return;
  seen += 1;
  if (seen === (spec.crashAt.nth ?? 1)) process.kill(process.pid, "SIGKILL");
};
const store = new DefinitionStore({ dir, boundary });
const options = { ...(spec.options ?? {}), installed: new Set(["claude", "codex", "hermes"]) };
if (spec.call === "set") await store.set(spec.id, spec.agent, options);
else if (spec.call === "remove") await store.remove(spec.id, spec.options ?? {});
else if (spec.call === "list") await store.list();
else throw new Error(`unknown call ${spec.call}`);
