// Starting and stopping from the view say what happened.
//
// THE DEFECT (v0.7 scan, F9). `s`, choose, Enter closed the list and then nothing: the service's
// refusal came back as `{started: false, problem}` and was dropped by `.catch(() => {})` with the
// resolved value unread. A stop failure was swallowed too. The operator could not tell "refused
// because it has a live session" from "starting", or "stop failed" from "stop is slow".

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { startDashboard } from "../lib/dashboard.mjs";
import { startDaemonView } from "../lib/daemon-view.mjs";
import { createNotices } from "../lib/notices.mjs";
import { actionOutcomeNotice, startOutcomeNotice } from "../lib/action-outcome.mjs";

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function view(extra) {
  const input = new FakeInput();
  const notices = createNotices({ now: () => 0 });
  const handle = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    columns: 120,
    rows: 40,
    input,
    notices,
    actions: ["attach", "stop"],
    fetchImpl: async () => ({
      ok: true, status: 200, body: null,
      json: async () => ({ processes: [{ id: "p1", label: "alpha" }] }),
    }),
    readFile: () => { throw new Error("no registry"); },
    ...extra,
  });
  await settle();
  return { input, notices, stop: handle.stop };
}

const texts = (notices) => notices.recent().map((n) => n.text);

test("a REFUSED start is reported, with the service's reason", async () => {
  const { input, notices, stop } = await view({
    onStartList: async () => ({ agents: [{ id: "bravo", name: "bravo" }] }),
    onStartAgent: async () => ({ started: false, problem: "bravo has a live session" }),
  });
  input.emit("data", "s");
  await settle();
  input.emit("data", "\r");
  await settle();
  stop();
  assert.ok(texts(notices).some((t) => /bravo/.test(t) && /refused/.test(t) && /live session/.test(t)),
    `the refusal left no trace: ${JSON.stringify(texts(notices))}`);
});

test("an accepted start says it is starting", async () => {
  const { input, notices, stop } = await view({
    onStartList: async () => ({ agents: [{ id: "bravo", name: "bravo" }] }),
    onStartAgent: async () => ({ started: true, problem: "" }),
  });
  input.emit("data", "s");
  await settle();
  input.emit("data", "\r");
  await settle();
  stop();
  assert.ok(texts(notices).some((t) => /starting bravo/.test(t)), JSON.stringify(texts(notices)));
});

test("a FAILED stop is reported, and a successful one too", async () => {
  const failing = await view({ onAction: async () => { throw new Error("access denied"); } });
  for (const key of ["m", "\u001b[B", "\r", "y"]) failing.input.emit("data", key);
  await settle();
  failing.stop();
  assert.ok(texts(failing.notices).some((t) => /stop.*alpha.*failed.*access denied/.test(t)),
    JSON.stringify(texts(failing.notices)));

  const working = await view({ onAction: async () => true });
  for (const key of ["m", "\u001b[B", "\r", "y"]) working.input.emit("data", key);
  await settle();
  working.stop();
  assert.ok(texts(working.notices).some((t) => /stopped alpha/.test(t)), JSON.stringify(texts(working.notices)));
});

test("the outcome words, from the two shapes the tiers answer in", () => {
  assert.equal(startOutcomeNotice({ id: "a", name: "alpha" }, { started: true }), "starting alpha");
  assert.equal(startOutcomeNotice({ id: "a" }, { started: false, problem: "no" }), "start of a refused: no");
  assert.equal(actionOutcomeNotice({ action: "stop", process: { id: "p1", label: "alpha" } }, true), "stopped alpha");
  assert.equal(actionOutcomeNotice({ action: "stop", process: { id: "p1" } }, false),
    "stop of p1 failed: the environment did not accept it");
  assert.equal(actionOutcomeNotice({ action: "stop", process: { id: "p1" } }, { ok: false, problem: "gone" }),
    "stop of p1 failed: gone");
  // A handler that answers nothing claims nothing, and nothing is reported for it.
  assert.equal(actionOutcomeNotice({ action: "stop", process: { id: "p1" } }, undefined), "");
});

test("THE DAEMON'S handlers hand the outcome back instead of dropping it", async () => {
  const calls = [];
  await startDaemonView({
    endpoint: "e", registryPath: "r",
    stdout: { isTTY: true, columns: 120, rows: 40 }, stdin: { isTTY: true },
    agents: () => ({ start: async (id) => ({ started: false, problem: `${id} is live` }) }),
    runner: { stop: async () => { throw new Error("denied"); } },
    start: async (options) => { calls.push(options); return { stop: () => {} }; },
  });
  assert.deepEqual(await calls[0].onStartAgent({ id: "bravo" }), { started: false, problem: "bravo is live" });
  assert.deepEqual(await calls[0].onAction({ action: "stop", process: { id: "p1" } }), { ok: false, problem: "denied" });
});
