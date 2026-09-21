#!/usr/bin/env node
// Attach this terminal to a process aify-env is running.
//
//   aify-env attach sc-lead        by the name the operator thinks in
//   aify-env attach <process-id>   by the id the protocol uses
//
// THE HERDR PROPERTY, and the reason this exists: it ATTACHES to a real terminal rather than
// redrawing one. Bytes from the process go to this stdout untouched, keys from this stdin go to the
// process untouched, and the resize travels -- so the thing on screen is the program's own output,
// not a view's idea of it.
//
// DETACHING DOES NOT KILL. Ctrl-] leaves; the process keeps running, keeps its PTY and keeps its
// context, because aify-env owns it and this is only a client. That is the whole point of hosting a
// resident's terminal here: today closing the window ends the agent, and after this it does not.
//
// CTRL-C IS THE PROCESS'S. A client that trapped it would make the one key an operator reaches for
// when something runs away do nothing -- so it passes through like every other byte, and only the
// detach byte is ever intercepted. `lib/keys.mjs` already draws that line for the dashboard's pane;
// this uses the same one so an operator learns it once.
//
// IT KNOWS NO SERVICE. A process is an id and a label here, exactly as everywhere else in this
// repo -- aify-dashboard and aify-project-graph will attach to processes they started through the
// same routes, and nothing in this file would need to change for them.

import { OutputFollower } from "../lib/output-follower.mjs";
import { DETACH } from "../lib/keys.mjs";
import { resolveAttachTarget } from "../lib/attach-target.mjs";
import { passthrough } from "../lib/attach-screen.mjs";
import { InputSender } from "../lib/input-sender.mjs";
import { connectInputSocket } from "../lib/input-socket.mjs";
import { readHostConfig } from "../lib/host-config.mjs";

const LF = String.fromCharCode(10);
const ENDPOINT = process.env.AIFY_ENV_ENDPOINT || "http://127.0.0.1:8802";

const say = (text) => process.stderr.write(`${text}${LF}`);

async function daemonHealth() {
  // WHERE THE FAST PATH IS, asked rather than computed: the daemon knows whether it has a socket,
  // and a client that guessed an address would connect to whatever happened to hold that name.
  try {
    const response = await fetch(`${ENDPOINT}/health`, { signal: AbortSignal.timeout(2000) });
    return await response.json();
  } catch { return {}; }
}

async function listProcesses() {
  const response = await fetch(`${ENDPOINT}/processes`, { signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  return Array.isArray(body?.processes) ? body.processes : [];
}

async function post(path, body) {
  // BEST-EFFORT AND SILENT. A keystroke that did not land is not worth taking the screen down for,
  // and a resize that failed will be corrected by the next one. The follower's own status is what
  // reports a connection that has stopped working.
  try {
    await fetch(`${ENDPOINT}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* the stream is the instrument that reports a dead connection */ }
}

const args = process.argv.slice(2);
const exactId = args[0] === '--id';
if (exactId && (args.length !== 2 || !args[1])) {
  say('Usage: aify-env attach --id <process-id>');
  process.exit(64);
}
const wanted = exactId ? args[1] : args.find((arg) => !arg.startsWith("-")) ?? "";

let health = {};
let processes;
try {
  health = await daemonHealth();
  processes = await listProcesses();
} catch (error) {
  say(`aify-env attach: no environment answered at ${ENDPOINT} (${error?.message ?? error}).`);
  say("  Start one with `aify-env`, or point AIFY_ENV_ENDPOINT at the right host.");
  process.exit(69);
}

const target = resolveAttachTarget(processes, wanted, { exactId });
if (target.error) {
  say(`aify-env attach: ${target.error}`);
  if (target.fix) say(`  ${target.fix}`);
  process.exit(64);
}

// A TERMINAL IS REQUIRED, and saying so beats half-working. Without raw mode every keystroke is line
// buffered and Ctrl-C is caught by this process rather than reaching the program -- an attach that
// looks connected and swallows the one key that matters.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  say("aify-env attach: this needs a terminal on both ends.");
  say("  To READ a process without one, stream it: GET /processes/<id>/output");
  process.exit(64);
}

// A WRITE-THROUGH BUFFER, which is how a pane-shaped follower becomes a pipe. `OutputFollower`
// appends each decoded chunk to whatever `buffer` it was given, so handing it one whose `append`
// writes to stdout turns the same streaming, framing and decoding into a passthrough -- no second
// implementation of any of it, and no change to the class the dashboard depends on.
//
// It keeps no history on purpose: a terminal already holds its own scrollback, and buffering here
// would only be a second copy that can disagree with the screen. It does clear the visible screen
// before the first chunk, so the replay is not painted over what this terminal showed before.
const follower = new OutputFollower({
  endpoint: ENDPOINT,
  id: target.id,
  buffer: passthrough((text) => process.stdout.write(text)),
});

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  // ON EVERY PATH OUT. A client that leaves the terminal in raw mode hands the operator a shell that
  // does not echo and does not respond to Ctrl-C -- worse than the problem it was solving.
  try { process.stdin.setRawMode(false); } catch { /* not a tty any more */ }
  process.stdin.pause();
  try { follower.stop(); } catch { /* already closed */ }
  try { socket?.close(); } catch { /* already closed */ }
}

function leave(code, message) {
  restore();
  if (message) say(message);
  process.exit(code);
}

process.stdin.setRawMode(true);

// THE SENDER AND THE LISTENER EXIST BEFORE stdin IS RESUMED. A resumed stdin with no listener
// DISCARDS what arrives, and the socket handshake below is awaited -- so every key typed during it,
// Ctrl-] included, was thrown away. Measured by review: 1 ms on the happy path, up to the 400 ms
// connect timeout against a busy daemon, which is exactly the load the ordering fix was written for.
//
// Early keys therefore travel by HTTP, and the socket takes over the moment it is connected. The
// sender keeps one send in flight either way, so the changeover cannot reorder anything.
const inputPath = `/processes/${encodeURIComponent(target.id)}/input`;
let socket = null;
const input = new InputSender(async (data) => {
  // `encoding: "binary"` because stdin is read raw, one code unit per byte. Without it the daemon
  // treats the string as text and encodes it again -- typing `e-acute` reached the process as
  // c383c2a9 instead of c3a9, on both transports, from the first version of this client.
  if (socket?.send(inputPath, { data, encoding: "binary" })) return;
  await post(inputPath, { data, encoding: "binary" });
});

process.stdin.on("data", (chunk) => {
  const data = chunk.toString("binary");
  // ONLY WHEN THE CHUNK **IS** THE DETACH BYTE, never when it merely contains one: a paste or a
  // program sending 0x1d mid-stream must reach the process. `lib/keys.mjs` draws the same line.
  if (data === DETACH) {
    leave(0, `detached from ${wanted || target.id}. It is still running.`);
    return;
  }
  input.write(data);
});

process.stdin.resume();

// THE FAST PATH WHEN THIS HOST HAS ONE. A local socket carries keystrokes in ~0.02 ms against
// ~0.33 ms over `fetch` (measured 2026-09-20, both ends), and the stream itself keeps them in order.
// It is attempted only when the daemon advertises an address and this host has not switched it off;
// a WSL client, another machine, or an older daemon simply never gets one and keeps using HTTP.
//
// AND IT CAN GO AWAY MID-SESSION. `send` answers false when the socket has closed, and the next
// keystroke travels by HTTP -- the transport degrades, the session does not end.
const hostConfig = readHostConfig({ env: process.env });
if (hostConfig.localSocket && typeof health?.inputSocket === "string" && health.inputSocket) {
  socket = await connectInputSocket({
    address: health.inputSocket,
    onRefusal: (frame) => { if (frame?.status === 404) leave(69, `${wanted || target.id} is no longer running here.`); },
  });
}

const sendResize = async () => {
  const size = { cols: process.stdout.columns || 0, rows: process.stdout.rows || 0 };
  const path = `/processes/${encodeURIComponent(target.id)}/resize`;
  if (socket?.send(path, size)) return;
  await post(path, size);
};
process.stdout.on("resize", () => void sendResize());

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  // SIGINT reaches here only if raw mode is off; it is restored either way so a terminal is never
  // left broken. The process on the other end is NOT stopped -- this is a client leaving.
  process.on(signal, () => leave(0, ""));
}

// AWAITED BEFORE THE STREAM OPENS, so the screen the daemon checkpoints for this client is already at
// this terminal's size. Racing it, the checkpoint could be taken at the PTY's previous width and wrap
// on this screen until the agent redrew.
await sendResize();

say(`attached to ${wanted || target.id} — Ctrl-] to detach, which leaves it running.`);

// `start()` RESOLVES RATHER THAN REJECTS, always, and puts the outcome in `status`. So the ending is
// read off the follower rather than caught: a stream that ended because the process exited and one
// that ended because the connection dropped are different facts, and an operator staring at a frozen
// screen needs to be told which.
await follower.start();
if (follower.status === "exited") {
  const how = follower.exit?.signal
    ? `killed by ${follower.exit.signal}`
    : `exited with code ${follower.exit?.code ?? "unknown"}`;
  leave(0, `${wanted || target.id} ${how}.`);
}
if (follower.status === "gone") leave(69, `${wanted || target.id} is no longer running here.`);
leave(70, `the stream to ${wanted || target.id} ended: ${follower.reason ?? "no reason given"}. `
  + "It may still be running — this client left, nothing was stopped.");
