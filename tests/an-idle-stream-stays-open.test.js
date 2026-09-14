// An output stream whose process is quiet must stay open.
//
// MEASURED 2026-09-14 on the operator's host, against the running daemon: `aify-env attach` panes for
// two idle Claude Code workers died with `UND_ERR_BODY_TIMEOUT`, while the hermes pane beside them
// lived. A read-only probe of `GET /processes/:id/output` with Node's fetch -- what OutputFollower
// uses -- received the replay at 0.0s and then nothing, and ended at 305.3s with that error. The
// hermes stream got a 114-byte redraw every ~1.7s and never went quiet. Node's fetch aborts a body
// after 300s with no bytes, and the daemon wrote nothing between output chunks.
//
// These tests prove the heartbeat reaches the wire and that every reader here ignores it. They do not
// wait 300s: the timeout itself is the probe's evidence, not something a suite should sit through.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { KEEPALIVE_FRAME, KEEPALIVE_MS, dataFrame, keepStreamAlive, readFrames } from "../lib/sse-frames.mjs";

/** Node's fetch body timeout: the deadline a quiet stream must beat. */
const FETCH_BODY_TIMEOUT_MS = 300_000;

/** Timers a test drives by hand. */
function manualTimers() {
  const intervals = new Map();
  let next = 1;
  return {
    setInterval: (fn, ms) => { const id = next++; intervals.set(id, { fn, ms }); return { id, unref() {} }; },
    clearInterval: (handle) => { intervals.delete(handle?.id); },
    tick() { for (const { fn } of intervals.values()) fn(); },
    get active() { return intervals.size; },
    get periods() { return [...intervals.values()].map((i) => i.ms); },
  };
}

/** A response that records writes and can close, the shape `http.ServerResponse` has here. */
function fakeResponse() {
  const response = new EventEmitter();
  response.writes = [];
  response.writableEnded = false;
  response.destroyed = false;
  response.write = (text) => { response.writes.push(text); return true; };
  return response;
}

test("the heartbeat is invisible to every reader of the stream", () => {
  const { frames, carry } = readFrames("", dataFrame("a") + KEEPALIVE_FRAME + dataFrame("b") + KEEPALIVE_FRAME);
  assert.deepEqual(frames.map((f) => f.text), ["a", "b"]);
  assert.equal(carry, "");
});

test("an open stream gets a heartbeat each period, well inside fetch's body timeout", () => {
  const timers = manualTimers();
  const response = fakeResponse();
  keepStreamAlive(response, { timers });
  assert.deepEqual(timers.periods, [KEEPALIVE_MS]);
  assert.ok(KEEPALIVE_MS * 2 <= FETCH_BODY_TIMEOUT_MS, "one missed beat would already lose the stream");
  timers.tick();
  timers.tick();
  assert.deepEqual(response.writes, [KEEPALIVE_FRAME, KEEPALIVE_FRAME]);
});

test("a closed stream stops beating, and nothing is written after it ends", () => {
  const timers = manualTimers();
  const response = fakeResponse();
  keepStreamAlive(response, { timers });

  // Ended but not yet closed: the exit frame was written and `end()` called.
  response.writableEnded = true;
  timers.tick();
  assert.deepEqual(response.writes, [], "a heartbeat was written after the response ended");

  response.emit("close");
  assert.equal(timers.active, 0, "the interval outlived the connection it was for");
});

test("THE CALL SITE: the daemon starts a heartbeat on the output stream", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  const stream = source.slice(source.indexOf("if (result.stream)"), source.indexOf("runner.subscribeScreen("));
  assert.match(stream, /keepStreamAlive\(response\)/, "the stream branch no longer keeps an idle stream open");
});

test("over a real socket, a quiet stream carries heartbeats and no output", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    keepStreamAlive(response, { everyMs: 40 });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: controller.signal });
    let text = "";
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const deadline = Date.now() + 2000;
    while (text.split(KEEPALIVE_FRAME).length - 1 < 3 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.ok(text.split(KEEPALIVE_FRAME).length - 1 >= 3, `expected 3 heartbeats on the wire, got ${JSON.stringify(text)}`);
    assert.deepEqual(readFrames("", text).frames, [], "a heartbeat was read as output");
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
