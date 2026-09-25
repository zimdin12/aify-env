// A character whose bytes arrive in two reads reaches the attached agent as that character.
//
// THE DEFECT (v0.7 scan, F23). The view's keyboard decoded every stdin chunk on its own
// (`String(chunk)`), so a multi-byte character split across a read boundary -- a large non-ASCII
// paste -- reached the process as two U+FFFD replacement characters. `aify-env attach` avoids this by
// reading binary; the view now keeps one decoder across reads.

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { startDashboard } from "../lib/dashboard.mjs";

const LF = String.fromCharCode(10);

class FakeInput extends EventEmitter {
  setRawMode() { return this; }
  resume() { return this; }
  pause() { return this; }
}

/** A daemon with one process whose console stream opens and stays open. */
const fakeFetch = async (url) => {
  if (String(url).includes("/output")) {
    const encoder = new TextEncoder();
    return {
      ok: true, status: 200,
      body: (async function* body() {
        yield encoder.encode(`event: meta${LF}data: ${JSON.stringify(
          { cols: 80, rows: 24, truncated: false, resized: false, replayBytes: 65536 })}${LF}${LF}`);
        yield encoder.encode(`data: ${JSON.stringify("ready")}${LF}${LF}`);
        await new Promise(() => {});
      })(),
    };
  }
  return { ok: true, status: 200, json: async () => ({ version: "0", processes: [{ id: "p1", label: "one" }] }) };
};

test("the two bytes of é, in two reads, reach the process as é", async () => {
  const sent = [];
  const input = new FakeInput();
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1", registryPath: "/nonexistent/services.json",
    write: () => {}, clearScreen: false, intervalMs: 60_000, columns: 120, rows: 20, input,
    fetchImpl: fakeFetch, readFile: () => { throw new Error("no registry"); },
    onInput: (target, data) => sent.push(data),
  });
  input.emit("data", Buffer.from("\r"));
  await new Promise((r) => setTimeout(r, 120));   // the stream opens and a streaming frame is drawn
  // CONTROL: a whole character in one read is delivered, so the pane is live.
  input.emit("data", Buffer.from("a"));
  const bytes = Buffer.from("é");
  input.emit("data", bytes.subarray(0, 1));
  input.emit("data", bytes.subarray(1));
  stop();
  assert.equal(sent.join(""), "aé", `the agent received ${JSON.stringify(sent)}`);
});
