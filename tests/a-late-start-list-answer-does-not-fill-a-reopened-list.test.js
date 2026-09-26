// An answer to an earlier opening of the start list does not fill the list opened after it.
//
// THE DEFECT (v0.7.1 review, W12). Opening the list asks for it and does not wait. Close it and open
// it again while the first request is still out, and whichever answer lands first fills the list --
// including the first one, which describes the host as it was before the operator closed it. Enter
// then started an agent from that stale answer, which is the F8 defect arriving by a second route.
//
// Each opening is its own question; only the answer to the current one may fill the list.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { startDashboard } from "../lib/dashboard.mjs";

const DETACH = String.fromCharCode(29);

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A start list whose every request stays out until the test answers it. */
function heldStartList() {
  const asks = [];
  const onStartList = () => new Promise((resolve) => { asks.push(resolve); });
  return { asks, onStartList };
}

async function view(onStartList, started) {
  const input = new FakeInput();
  const handle = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    columns: 120,
    rows: 40,
    input,
    fetchImpl: async () => ({ ok: true, status: 200, body: null, json: async () => ({ processes: [] }) }),
    readFile: () => { throw new Error("no registry"); },
    onStartList,
    onStartAgent: async (agent) => { started.push(agent.id); return { started: true }; },
  });
  return { input, stop: handle.stop };
}

test("the first opening's answer, arriving after a reopen, starts nothing", async (t) => {
  const { asks, onStartList } = heldStartList();
  const started = [];
  const { input, stop } = await view(onStartList, started);
  t.after(stop);
  input.emit("data", "s");                  // first opening, request out
  input.emit("data", DETACH);               // closed
  input.emit("data", "s");                  // reopened, second request out
  assert.equal(asks.length, 2, "positive control: reopening did not ask again");
  asks[0]({ agents: [{ id: "stale", name: "stale" }] });
  await settle();
  input.emit("data", "\r");
  await settle();
  assert.deepEqual(started, [], `Enter started ${JSON.stringify(started)} from the earlier answer`);
});

test("CONTROL: the current opening's answer fills the list, and Enter starts from it", async (t) => {
  const { asks, onStartList } = heldStartList();
  const started = [];
  const { input, stop } = await view(onStartList, started);
  t.after(stop);
  input.emit("data", "s");
  input.emit("data", DETACH);
  input.emit("data", "s");
  asks[0]({ agents: [{ id: "stale", name: "stale" }] });
  asks[1]({ agents: [{ id: "fresh", name: "fresh" }] });
  await settle();
  input.emit("data", "\r");
  await settle();
  assert.deepEqual(started, ["fresh"]);
});

test("a refusal of the first opening, arriving after a reopen, does not answer the new one", async (t) => {
  // THE FAILURE BRANCH, which reports a refusal as an answer: drawn late, it would replace
  // "asking" with a reason that belongs to a request the operator already abandoned.
  const asks = [];
  const onStartList = () => new Promise((resolve, reject) => { asks.push(reject); });
  const frames = [];
  const input = new FakeInput();
  const handle = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: (text) => frames.push(text),
    clearScreen: false,
    intervalMs: 60_000,
    columns: 120,
    rows: 40,
    input,
    fetchImpl: async () => ({ ok: true, status: 200, body: null, json: async () => ({ processes: [] }) }),
    readFile: () => { throw new Error("no registry"); },
    onStartList,
  });
  t.after(handle.stop);
  input.emit("data", "s");
  input.emit("data", DETACH);
  input.emit("data", "s");
  asks[0](new Error("the old request went away"));
  await settle();
  const last = frames.at(-1);
  assert.doesNotMatch(last, /the old request went away/, "the abandoned request's refusal was drawn");
  assert.match(last, /asking/, "the reopened list stopped saying it is asking");
});
