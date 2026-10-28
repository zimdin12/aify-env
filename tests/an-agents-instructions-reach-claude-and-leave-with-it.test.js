// An agent's instructions, defined here, reach claude through aify-wrapper's real launcher, and leave with the agent.
//
// THE TWO HALVES MEET HERE AND NOWHERE ELSE. aify-wrapper (c4818238) writes a claude definition's `agent.instructions`
// to ~/.aify/sessions/<id>/instructions.txt and hands claude `--append-system-prompt-file <it> --system-prompt-snapshot
// off`; aify-env removes ~/.aify/sessions/<id>/ once the agent is neither defined nor running (lib/session-folders.mjs).
// Each side's suite proves its half against its own fixtures. This one runs the definition FILE aify-env's store writes
// through the launcher aify-wrapper renders, to a stub claude that records its argv, and then asks aify-env's own
// session-folder rule about the folder that launch filled.
//
// THE WRAPPER'S TEST HELPER IS IMPORTED BY PATH (tests/launch-to-a-stub-runtime.mjs, its `launch`), the way aify-comms
// imports modules of this repo: aify-wrapper is told, so a change to that helper's interface is not a surprise.
//
// Skipped without AIFY_WRAPPER_REPO; an explicit one that is not a checkout with the instructions launcher refuses.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { SessionFolders, sessionsRoot } from "../lib/session-folders.mjs";

function peer() {
  const value = process.env.AIFY_WRAPPER_REPO;
  if (value === undefined) return null;
  for (const marker of ["tests/launch-to-a-stub-runtime.mjs", "bin/aify-definition.sh"]) {
    assert.ok(value && fs.existsSync(path.join(value, marker)), `AIFY_WRAPPER_REPO must name an aify-wrapper checkout with ${marker}`);
  }
  return path.resolve(value);
}
const WRAPPER = peer();
const SKIP = WRAPPER ? false : "requires AIFY_WRAPPER_REPO; an explicit invalid one refuses";

const INSTRUCTIONS = "Answer in French.\n\"quoted\" $HOME `tick` \\ back\n";
//: The variables the wrapper's credential custody needs to name this host's user, and nothing else of this machine.
const OWNER = Object.fromEntries(["USERNAME", "USERDOMAIN", "SystemRoot"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
const MANAGED = { ...OWNER, AIFY_MANAGED_VIA_WRAPPER: "1", AIFY_AGENT_ID: "lead" };

function scratch(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The bytes aify-env's store writes for `lead` with these `instructions` and `harness`: the file the launcher reads. */
async function definitionFile(t, { instructions, harness = "claude" }) {
  const dir = path.join(scratch(t, "aify-instructions-store-"), "agent-definitions");
  await new DefinitionStore({ dir }).set("lead", { id: "lead", name: "Lead", role: "reviewer", harness, mode: "managed",
    workspace: os.tmpdir(), model: "", effort: "", instructions, env: {}, herdrSpace: false }, { installed: new Set([harness]) });
  return fs.readFileSync(path.join(dir, "lead.json"), "utf8");
}

const launcher = async () => (await import(pathToFileURL(path.join(WRAPPER, "tests", "launch-to-a-stub-runtime.mjs")).href)).launch;
const flagValue = (args, flag) => { const at = args.indexOf(flag); return at < 0 ? null : args[at + 1]; };

test("a managed claude started from aify-env's definition gets its instructions as an appended prompt file, in aify-env's session folder", { skip: SKIP }, async (t) => {
  const launch = await launcher();
  const r = launch("claude", ["--aify-agent", "lead"], { definitions: { lead: await definitionFile(t, { instructions: INSTRUCTIONS }) }, env: MANAGED });
  assert.equal(r.run.status, 0, r.run.stderr);
  const file = flagValue(r.args, "--append-system-prompt-file");
  assert.ok(file, `no --append-system-prompt-file in ${r.args.join(" ")}`);
  assert.equal(flagValue(r.args, "--system-prompt-snapshot"), "off", "a resume would keep the prompt recorded when it began");
  assert.equal(r.sessionFiles["lead/instructions.txt"], INSTRUCTIONS, "the file does not hold the definition's text byte for byte");
  const named = file.replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/");
  const expected = path.join(sessionsRoot(r.home), "lead", "instructions.txt").replace(/\\/g, "/");
  assert.equal(named.toLowerCase(), expected.toLowerCase(), "the launcher's file is not in the folder aify-env removes");
});

test("CONTROL: no instructions, no flag and no file; and codex, which cannot be handed them, refuses with 78", { skip: SKIP }, async (t) => {
  const launch = await launcher();
  const none = launch("claude", ["--aify-agent", "lead"], { definitions: { lead: await definitionFile(t, { instructions: "" }) }, env: MANAGED });
  assert.equal(none.run.status, 0, none.run.stderr);
  assert.equal(flagValue(none.args, "--append-system-prompt-file"), null);
  assert.equal(none.sessionFiles["lead/instructions.txt"], undefined);
  const codex = launch("codex", ["--aify-agent", "lead"], { definitions: { lead: await definitionFile(t, { instructions: INSTRUCTIONS, harness: "codex" }) }, env: MANAGED });
  assert.equal(codex.run.status, 78, `${codex.run.status}: ${codex.run.stderr}`);
});

test("the folder that launch filled stays while the agent is defined, and aify-env removes it once it is not", { skip: SKIP }, async (t) => {
  const launch = await launcher();
  const r = launch("claude", ["--aify-agent", "lead"], { definitions: { lead: await definitionFile(t, { instructions: INSTRUCTIONS }) }, env: MANAGED });
  assert.equal(r.run.status, 0, r.run.stderr);
  // The launch's own home is gone with its run; its session files are laid down, byte for byte, under a home of ours.
  const home = scratch(t, "aify-instructions-home-");
  for (const [rel, text] of Object.entries(r.sessionFiles)) {
    const to = path.join(sessionsRoot(home), ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, text);
  }
  assert.ok(fs.existsSync(path.join(sessionsRoot(home), "lead", "instructions.txt")), "CONTROL: the launch left the file");
  const store = new DefinitionStore({ dir: path.join(home, ".aify", "agent-definitions") });
  await store.set("lead", JSON.parse(await definitionFile(t, { instructions: INSTRUCTIONS })).agent, { installed: new Set(["claude"]) });
  const folders = new SessionFolders({ root: sessionsRoot(home), definitions: store,
    identity: () => ({ current: null, unknown: false, conflict: false }) });
  assert.deepEqual(await folders.forget("lead"), { agentId: "lead", removed: false, reason: "defined" });
  assert.ok(fs.existsSync(path.join(sessionsRoot(home), "lead", "instructions.txt")), "a defined agent's instructions were removed");
  await store.remove("lead");
  assert.deepEqual(await folders.forget("lead"), { agentId: "lead", removed: true, reason: "not-running" });
  assert.equal(fs.existsSync(path.join(sessionsRoot(home), "lead")), false, "the instructions outlived the agent's definition");
});
