#!/usr/bin/env node
// `aify-env tui` must deliver typed keys in the order they were typed, like `aify-env attach` does.
//
// THE DEFECT (v0.7 scan, F2). The scrambled-text report of 2026-09-19 was fixed for `attach` with
// `InputSender` -- one request in flight, the rest coalesced -- but the `tui` client still sent each
// chunk as its own `fetch`, not awaited by the view. Independent HTTP requests carry no ordering, so
// under load keys typed into an attached pane could reach the agent out of order.
//
// THE DELAYS ARE ADVERSARIAL BUT REAL IN KIND: a busy daemon answers a later call sooner.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { createClientInput } from "../lib/client-input.mjs";
import { postJson } from "../lib/input-sender.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A daemon whose later calls answer sooner, recording what each target was handed, in arrival order. */
function slowDaemon(delaysMs) {
  const arrived = [];
  let call = 0;
  return {
    arrived,
    fetchImpl: async (url, init) => {
      const delay = delaysMs[Math.min(call, delaysMs.length - 1)];
      call += 1;
      await wait(delay);
      const id = decodeURIComponent(String(url).split("/processes/")[1].split("/")[0]);
      arrived.push({ id, data: JSON.parse(init.body).data });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
}

test("keys typed into one agent arrive in the order they were typed", async () => {
  const daemon = slowDaemon([40, 30, 20, 10, 1]);
  const { send } = createClientInput({ endpoint: "http://127.0.0.1:1", fetchImpl: daemon.fetchImpl });
  const alpha = { id: "p1" };
  // The view does not await these -- `dashboard.mjs` hands each chunk over and moves on.
  for (const key of "hello") void send(alpha, key);
  await wait(150);
  assert.equal(daemon.arrived.map((a) => a.data).join(""), "hello");
});

test("one agent's slow send does not hold another agent's keys", async () => {
  const daemon = slowDaemon([60, 1]);
  const { send } = createClientInput({ endpoint: "http://127.0.0.1:1", fetchImpl: daemon.fetchImpl });
  void send({ id: "p1" }, "a");
  void send({ id: "p2" }, "b");
  await wait(20);
  assert.deepEqual(daemon.arrived, [{ id: "p2", data: "b" }], "a second agent waited on the first");
  await wait(80);
  assert.equal(daemon.arrived.length, 2);
});

test("no target, no request", async () => {
  const daemon = slowDaemon([1]);
  const { send } = createClientInput({ endpoint: "http://127.0.0.1:1", fetchImpl: daemon.fetchImpl });
  await send(null, "x");
  await wait(10);
  assert.deepEqual(daemon.arrived, []);
});

test("THE CLIENT USES IT: bin/aify-env-tui.mjs routes its keys through createClientInput", () => {
  // bin/ cannot be imported without starting a view that talks to a daemon, so this reads the
  // source. The behaviour is proven above; this only proves the entrypoint is wired to it.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const source = fs.readFileSync(path.join(here, "..", "bin", "aify-env-tui.mjs"), "utf8");
  assert.match(source, /const clientInput = createClientInput\(/);
  assert.match(source, /onInput:\s*clientInput\.send/);
  assert.doesNotMatch(source, /\/input`/, "the client still builds its own input request");
});

// ── postJson: a send that did not land must say so, or `InputSender.failed` can never count ──────

test("postJson resolves on 2xx and THROWS on a non-2xx answer or a dead connection", async () => {
  const seen = [];
  const ok = await postJson("http://127.0.0.1:1/x", { data: "a" }, {
    fetchImpl: async (url, init) => { seen.push(init); return { ok: true, status: 204 }; },
  });
  assert.equal(ok.status, 204);
  assert.equal(seen[0].redirect, "manual", "a redirect would re-send keystrokes somewhere nobody chose");
  await assert.rejects(postJson("http://127.0.0.1:1/x", {}, {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  }), /404/);
  await assert.rejects(postJson("http://127.0.0.1:1/x", {}, {
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  }), /ECONNREFUSED/);
});
