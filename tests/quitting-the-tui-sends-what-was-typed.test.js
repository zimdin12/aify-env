// Quitting `aify-env tui` sends what was already typed into an agent before the process exits.
//
// THE DEFECT (v0.7.1 review, E3). `onQuit` called `process.exit(0)` at once. The per-agent senders
// keep one request in flight and coalesce the rest, so on a loaded host the tail of a typed line --
// often its Enter -- was still queued behind the request in flight, and died with the process. That
// is the F22 defect `aify-env attach` had, fixed there with a bounded drain; this is the same drain for
// the other client, across every agent's sender.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createClientInput } from "../lib/client-input.mjs";
import { QUIT_DRAIN_MS, quitView } from "../lib/view-exit.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A daemon answering each agent's keystrokes after that agent's delay, recording what arrived. */
function slowDaemon(delayMsById) {
  const arrived = [];
  return {
    arrived,
    fetchImpl: async (url, init) => {
      const id = decodeURIComponent(String(url).split("/processes/")[1].split("/")[0]);
      await wait(delayMsById[id]);
      arrived.push(`${id}:${JSON.parse(init.body).data}`);
      return { ok: true, status: 204 };
    },
  };
}

test("keys queued behind a send in flight, for two agents, are sent before the drain says done", async () => {
  // p2 is the slower, and its sender is the second one made: a drain that waited on fewer than
  // every sender would return before p2's keys landed.
  const daemon = slowDaemon({ p1: 30, p2: 150 });
  const input = createClientInput({ endpoint: "http://127.0.0.1:1", fetchImpl: daemon.fetchImpl });
  input.send({ id: "p1" }, "ab");
  input.send({ id: "p1" }, "c\r");         // queued behind "ab"
  input.send({ id: "p2" }, "x\r");
  assert.equal(await input.drainedWithin(QUIT_DRAIN_MS), true);
  assert.deepEqual(daemon.arrived.sort(), ["p1:ab", "p1:c\r", "p2:x\r"]);
});

test("a daemon that stopped answering cannot hold the terminal past the bound", async () => {
  const input = createClientInput({ endpoint: "http://127.0.0.1:1", fetchImpl: () => new Promise(() => {}) });
  input.send({ id: "p1" }, "a");
  const started = Date.now();
  assert.equal(await input.drainedWithin(50), false);
  assert.ok(Date.now() - started < 1000, "the drain waited past its bound");
});

test("quitting gives the screen back first, then drains, then exits", async () => {
  const order = [];
  let release;
  await Promise.all([
    quitView({
      stop: () => order.push("stop"),
      drainedWithin: (ms) => { order.push(`drain ${ms}`); return new Promise((resolve) => { release = resolve; }); },
      exit: (code) => order.push(`exit ${code}`),
    }),
    (async () => {
      await wait(10);
      assert.deepEqual(order, ["stop", `drain ${QUIT_DRAIN_MS}`], "the process exited before the drain finished");
      release(true);
    })(),
  ]);
  assert.deepEqual(order, ["stop", `drain ${QUIT_DRAIN_MS}`, "exit 0"]);
});

test("aify-env tui quits through quitView, with its own input's drain", () => {
  // THE ENTRYPOINT CANNOT BE RUN HERE -- running it starts a view that talks to a daemon -- so this
  // reads that it is wired to the two pieces proven above.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "bin", "aify-env-tui.mjs"), "utf8");
  assert.match(source, /onQuit: \(\) => quitView\(\{[^}]*drainedWithin: clientInput\.drainedWithin/);
});
