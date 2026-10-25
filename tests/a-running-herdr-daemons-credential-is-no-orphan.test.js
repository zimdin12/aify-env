// A `herdr-aify env` daemon reads its OWN copy of the registry (instance.json serviceRegistry), and on 2026-10-25 the
// live daemon's copy named a credential the main registry no longer did. The doctor called that file an orphan and
// printed the command that removes it. What a may-still-run daemon's copy names is now held; a proven-dead one's is not.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { STATE } from "../lib/health.mjs";
import { liveInvocationRegistries } from "../lib/serving-endpoint.mjs";

const registry = (credentialRef) => JSON.stringify({ version: 1, services: { "aify-comms": { endpoint: "http://127.0.0.2:1", credentialRef } } });

test("liveInvocationRegistries reads every invocation's copy except one whose daemon is proven gone", () => {
  // The bug it would catch: a dead launch's copy keeps a junk file forever, or a live or starting one is skipped.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "inv-registries-"));
  const invocation = (name, { pid, copy } = {}) => {
    const dir = path.join(profile, "invocations", name);
    fs.mkdirSync(dir, { recursive: true });
    if (pid !== undefined) fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify({ pid }));
    if (copy !== undefined) fs.writeFileSync(path.join(dir, "services.json"), copy);
  };
  try {
    invocation("live", { pid: 11, copy: registry("ref-live") });
    invocation("dead", { pid: 22, copy: registry("ref-dead") });
    invocation("starting", { copy: registry("ref-starting") });
    invocation("no-copy", { pid: 11 });
    const state = (pid) => (pid === 22 ? "gone" : "alive");
    const read = liveInvocationRegistries(profile, { state }).sort((a, b) => a.invocation.localeCompare(b.invocation));
    assert.deepEqual(read.map((copy) => copy.invocation), ["live", "starting"]);
    assert.match(read[0].text, /ref-live/);
    // The control: with every pid alive, the dead one's copy is read too, so the skip above came from its state.
    assert.deepEqual(liveInvocationRegistries(profile, { state: () => "alive" }).map((copy) => copy.invocation).sort(),
      ["dead", "live", "starting"]);
    assert.deepEqual(liveInvocationRegistries(path.join(profile, "absent")), [], "no invocations folder is nothing to read");
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("THE DOCTOR holds what a running daemon's copy names, and still reports a true orphan", async () => {
  const credentials = async ({ names, copies = [] }) => {
    const checks = await collectEnvironmentChecks({
      endpoint: "http://example.invalid", knock: async () => ({ ok: false, error: "down" }),
      readRegistry: () => ({ text: registry("ref-current") }), terminalSupport: () => ({ available: true }),
      readCredentialStore: async () => ({ names }), readInvocationRegistries: () => copies,
    });
    return checks.find((check) => check.id === "credentials");
  };
  const liveCopy = { invocation: "f5d8", text: registry("ref-daemon") };

  const held = await credentials({ names: ["ref-current", "ref-daemon"], copies: [liveCopy] });
  assert.equal(held.state, STATE.PASSED, held.detail);
  assert.match(held.detail, /running herdr-aify env daemon's own copy/);
  // The control: the same store with no daemon copy reports the file, so the pass above came from the copy.
  const unheld = await credentials({ names: ["ref-current", "ref-daemon"] });
  assert.match(unheld.detail, /no registry entry references: ref-daemon$/);
  // A true orphan beside a held one is still reported.
  const junk = await credentials({ names: ["ref-current", "ref-daemon", "ref-junk"], copies: [liveCopy] });
  assert.match(junk.detail, /1 stored credential\(s\) that no registry entry references: ref-junk$/);
  // A copy naming a file that is not stored is not dangling: a dead launch's copy may name one long removed.
  const gone = await credentials({ names: ["ref-current"], copies: [liveCopy] });
  assert.equal(gone.state, STATE.PASSED, gone.detail);
  // Fail closed: a copy that cannot be read leaves what is held unknown, so nothing is called an orphan.
  const unread = await credentials({ names: ["ref-current", "ref-junk"], copies: [{ invocation: "f5d8", readError: "EACCES" }] });
  assert.equal(unread.state, STATE.UNANSWERED);
  assert.match(unread.detail, /invocation f5d8: the registry could not be read: EACCES/);
});
