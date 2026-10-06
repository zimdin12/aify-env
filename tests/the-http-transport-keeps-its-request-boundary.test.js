// Transport composition only; protocol, browser and SSE rules keep their inherited tests.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AgentTurnEvents } from "../lib/agent-turn-events.mjs";
import { readFrames } from "../lib/sse-frames.mjs";

async function transport(options) {
  assert.ok(existsSync(new URL("../lib/daemon-http.mjs", import.meta.url)),
    "missing HTTP transport factory module: lib/daemon-http.mjs");
  const { createDaemonHttp } = await import("../lib/daemon-http.mjs");
  assert.equal(typeof createDaemonHttp, "function", "missing createDaemonHttp factory");
  return createDaemonHttp(options);
}
function request(method, url, text = "", headers = {}, read = () => {}) {
  return Object.assign(new EventEmitter(), { method, url, headers,
    async *[Symbol.asyncIterator]() { read(); yield Buffer.from(text); } });
}
function response(t) {
  const r = Object.assign(new EventEmitter(), { writes: [], writableEnded: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(text) { this.writes.push(text); return true; },
    end(text) { if (text !== undefined) this.writes.push(text); this.writableEnded = true; this.emit("close"); },
  });
  t.after(() => r.emit("close"));
  return r;
}
const traffic = () => ({ requests: 0, bytesOut: 0 });
const json = (r) => JSON.parse(r.writes.join(""));

test("browser refusal consumes neither request nor per-request dependencies", async (t) => {
  const io = traffic();
  const callback = await transport({ runner: {}, traffic: io,
    protocolDeps: () => assert.fail("browser refusal resolved dependencies") });
  const q = request("POST", "/agents/a/turn-event", "{}", { origin: "https://fixture.invalid" },
    () => assert.fail("browser refusal consumed the body"));
  Object.defineProperty(q, "url", { get: () => assert.fail("browser refusal read the route") });
  const r = response(t);
  await callback(q, r);
  assert.equal(r.status, 403);
  assert.match(json(r).error, /Origin/);
  assert.deepEqual(io, { requests: 1, bytesOut: 0 });
});

test("fresh dependencies deliver unavailable then successful real turn receiver after body consumption", async (t) => {
  const io = traffic();
  const order = [];
  const applied = [];
  const receiver = new AgentTurnEvents({ instance: "default", host: {
    refresh() { order.push("refresh"); },
    applyEvent(event) { applied.push(event); return { applied: true, reason: "current:first" }; },
  } });
  let current;
  const callback = await transport({ runner: {}, traffic: io,
    protocolDeps: async () => { order.push("deps"); return { turnEvents: current }; } });
  assert.deepEqual(order, [], "factory eagerly resolved dependencies");
  const event = { instance: "default", lifetime: "fixture", kind: "turn-start", firedAtUs: 1 };
  const send = async () => {
    const r = response(t);
    const pending = callback(request("POST", "/agents/a/turn-event?ignored=1", JSON.stringify(event), {}, () => order.push("body")), r);
    assert.equal(typeof pending.then, "function", "callback dropped its promise");
    await pending;
    return r;
  };
  const absent = await send();
  assert.equal(absent.status, 503);
  assert.equal(json(absent).reason, "state-unavailable");
  current = receiver;
  const good = await send();
  assert.equal(good.status, 200);
  assert.deepEqual(json(good), { agentId: "a", applied: true, reason: "current:first" });
  assert.deepEqual(applied, [{ agentId: "a", lifetime: "fixture", kind: "turn-start", firedAtUs: 1 }]);
  assert.deepEqual(order, ["body", "deps", "body", "deps", "refresh"]);
  assert.equal(io.requests, 2);
  assert.equal(io.bytesOut, Buffer.byteLength(absent.writes[0]) + Buffer.byteLength(good.writes[0]));
});

test("malformed JSON remains undefined, an empty body is null, and null responses remain empty", async (t) => {
  const io = traffic();
  const runner = { relabel: () => true };
  const received = [];
  const turnEvents = new AgentTurnEvents({ instance: "default", host: {
    refresh: () => assert.fail("a malformed envelope refreshed state"),
  } });
  const receive = turnEvents.receive.bind(turnEvents);
  turnEvents.receive = (id, body) => { received.push(body); return receive(id, body); };
  const callback = await transport({ runner, traffic: io, protocolDeps: async () => ({ runner, turnEvents }) });
  const bad = response(t);
  await callback(request("POST", "/agents/a/turn-event", "{"), bad);
  assert.equal(bad.status, 400);
  assert.deepEqual(json(bad), { agentId: "a", applied: false, reason: "malformed-event" });
  const blank = response(t);
  await callback(request("POST", "/agents/a/turn-event"), blank);
  assert.equal(blank.status, 400);
  assert.deepEqual(received, [undefined, null], "transport changed the parser's body convention");
  const empty = response(t);
  await callback(request("POST", "/processes/p/label", '{"label":"new"}'), empty);
  assert.equal(empty.status, 204);
  assert.deepEqual(empty.writes, []);
  assert.equal(io.bytesOut, Buffer.byteLength(bad.writes[0]) + Buffer.byteLength(blank.writes[0]));
});

test("a dependency rejection stays inside the old internal-error boundary", async (t) => {
  const io = traffic();
  const callback = await transport({ runner: {}, traffic: io,
    protocolDeps: async () => { throw new Error("fixture dependency failure"); } });
  const r = response(t);
  await callback(request("GET", "/health"), r);
  assert.equal(r.status, 500);
  assert.deepEqual(json(r), { error: "internal error" });
  assert.equal(io.bytesOut, Buffer.byteLength(r.writes[0]));
});

test("real SSE encoders carry meta, replay, live output, resize and exit; close releases the subscription", async (t) => {
  const io = traffic();
  let handlers, unsubscribed = 0;
  const meta = { cols: 80, rows: 24, truncated: false, resized: false, replayBytes: 3 };
  const runner = { canStream: () => true, streamMeta: () => meta,
    subscribeScreen(id, on) {
      assert.equal(id, "p"); handlers = on;
      on.onMeta(meta); on.onOutput("old");
      return () => { unsubscribed++; };
    } };
  const callback = await transport({ runner, traffic: io, protocolDeps: async () => ({ runner }) });
  const q = request("GET", "/processes/p/output");
  const r = response(t);
  await callback(q, r);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/event-stream");
  assert.equal(r.listenerCount("close"), 1, "heartbeat was not installed");
  handlers.onOutput("é\n");
  handlers.onResize({ cols: 100, rows: 30 });
  handlers.onExit(null, "SIGTERM");
  assert.equal(r.writableEnded, true);
  assert.equal(r.listenerCount("close"), 0, "heartbeat cleanup did not run");
  const { frames, carry } = readFrames("", r.writes.join(""));
  assert.equal(carry, "");
  assert.deepEqual(frames.map((f) => f.type), ["meta", "output", "output", "meta", "exit"]);
  assert.equal(frames[0].cols, 80);
  assert.deepEqual(frames.slice(1, 3).map((f) => f.text), ["old", "é\n"]);
  assert.equal(frames[3].cols, 100);
  assert.equal(frames[3].rows, 30);
  assert.deepEqual(frames[4], { type: "exit", code: null, signal: "SIGTERM" });
  assert.equal(io.bytesOut, Buffer.byteLength("oldé\n"));
  q.emit("close");
  assert.equal(unsubscribed, 1);
});

test("a raced stream ends without installing a request subscription", async (t) => {
  const runner = { canStream: () => true, subscribeScreen: () => null };
  const io = traffic();
  const callback = await transport({ runner, traffic: io, protocolDeps: async () => ({ runner }) });
  const q = request("GET", "/processes/p/output");
  const r = response(t);
  await callback(q, r);
  assert.equal(r.writableEnded, true);
  assert.equal(q.listenerCount("close"), 0);
  assert.equal(r.listenerCount("close"), 0);
  assert.equal(io.bytesOut, 0);
});
