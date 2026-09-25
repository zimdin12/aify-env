// Keystrokes from `aify-env tui` to a process, over HTTP, in the order they were typed.
//
// Writing to a process is the daemon's business. A view asks; it does not reach into a PTY.
//
// ONE `InputSender` PER TARGET (v0.7 scan, F2). This client used to send every chunk as its own
// fire-and-forget POST, which is exactly the shape that scrambled typed text under load in
// `aify-env attach` (2026-09-19): independent requests carry no ordering, so a busy daemon could
// answer a later keystroke first. `InputSender` keeps one request in flight and coalesces what was
// typed meanwhile, so order is a property of the code rather than of timing.
//
// PER TARGET, because the order that matters is within one agent's input. One agent's slow send
// must not hold keys typed into another.
//
// NO SOCKET FAST PATH here, deliberately: that is a latency optimisation `attach` has, and ordering
// -- the defect -- is fully fixed without it.
//
// NEVER THROWS INTO THE VIEW. A keystroke that did not land is counted by its sender and is not worth
// taking the screen down for; the pane's own status reports a connection that stopped working.

import { InputSender, postJson } from "./input-sender.mjs";

/**
 * @returns {(target: {id: string}|null, data: string) => void} the view's `onInput`
 */
export function createClientInput({ endpoint, fetchImpl = fetch } = {}) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  const senders = new Map();
  return (target, data) => {
    const id = String(target?.id ?? "");
    if (!id || !data) return;
    let sender = senders.get(id);
    if (!sender) {
      const url = `${base}/processes/${encodeURIComponent(id)}/input`;
      sender = new InputSender((bytes) => postJson(url, { data: bytes }, { fetchImpl }));
      senders.set(id, sender);
    }
    sender.write(data);
  };
}
