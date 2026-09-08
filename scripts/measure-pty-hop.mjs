// HOP ONE, THROUGH A REAL PTY — the leg the hop table still calls UNMEASURED, with a PIPE beside it.
//
// WHAT THE TABLE SAYS TODAY: "0.09-0.21ms p50 on warm PIPES, 0 rejected samples ... cheap here; the
// PTY path is UNMEASURED and hop one is not eliminated." Pipes and a ConPTY are different pieces of
// software with different buffering, and every managed agent on this host runs on the second one.
//
// THE PIPE ARM IS THE CONTROL, AND IT IS THE POINT. A PTY figure alone cannot say whether what it
// read is the console or this host's scheduler: everything on this machine that waits for another
// turn reads about 15.4ms, and three probes in this session have been fooled by exactly that. The
// SAME child, the SAME protocol and the SAME clock over an ordinary pipe answers it in one run.
//
// WHAT IS MEASURED, named as narrowly as it deserves:
//
//   ROUND TRIP   parent writes a request -> the child's reply arrives on the parent's read side.
//                ONE process's clock at both ends, which is the whole reason it is a round trip
//                rather than a one-way time: `process.hrtime` has a per-process origin, so stamping
//                the child and subtracting in the parent would be subtracting two different clocks.
//                It is NOT halved. Producer-to-handler is bounded ABOVE by this.
//
//   DRAIN        parent asks for a pre-built painted frame -> the frame's terminator arrives. Also
//                parent-clocked, and it includes the child's write and the transport's buffering.
//
// THE REPLY TOKEN IS NEVER THE REQUEST TOKEN. A Windows ConPTY echoes the parent's writes back down
// the same stream the child's output arrives on. A probe that searched for the token it had just
// sent would find its own echo and publish the console's line discipline as the child's latency.
// The child wraps every reply in tildes the parent never writes, and the negative control below is a
// wrap that was never requested.
//
// THIS SPAWNS ITS OWN CHILDREN AND TOUCHES NOTHING OF THE OPERATOR'S. It does not import
// `lib/runner.mjs`: that module pulls in the owned-process registry and the reaper, and this repo
// has an incident on file for importing shared infrastructure in order to measure it. The spawn
// options are a REPLICA of `lib/runner.mjs:84-93` -- `name: "xterm-color"`, the caller's grid, and
// `useConptyDll` read from the same variable -- and being a replica rather than the artifact is a
// real limitation, stated here rather than left to be discovered.
//
// THE CHILDREN ARE ASKED TO LEAVE, NOT KILLED. node-pty's default ConPTY `kill()` attaches to the
// console of the pty's shell pid and kills everything in it, which is the mechanism behind this
// project's worst incidents. Each child exits on `Q`; one that does not is REPORTED, and the run
// refuses rather than reaching for a kill.
//
// Run: node scripts/measure-pty-hop.mjs

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "pty-hop-child.mjs");
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

//: The console's own geometry, matching the other probes so the arms compare.
const COLS = 132;
const ROWS = 40;
const ECHO_ITERATIONS = 60;
const PAINT_ITERATIONS = 20;
//: A reply that has not arrived by here is a REJECTION, counted, never aged against anything.
const REPLY_TIMEOUT_MS = 5000;
//: How long a child gets to leave on its own after `Q`.
const EXIT_TIMEOUT_MS = 5000;
//: The sizes `pty-hop-child.mjs` pre-builds. Written in both places would be two sources for one
//: fact, so a mismatch is REPORTED by the child rather than answered with the nearest payload.
const PAINT_SIZES = [1024, 16 * 1024, 64 * 1024];

/** A token nothing hard-coded can hold, because it does not exist until this process runs. */
function freshToken() {
  return randomBytes(5).toString("hex");
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, fraction) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/**
 * One child behind one transport, and the only thing anybody waits for: a wrapped token arriving.
 *
 * The transport is injected rather than branched on, so the PTY arm and the pipe arm differ in
 * exactly one thing -- what carries the bytes -- and nothing else about the measurement moves.
 *
 * The buffer is trimmed rather than grown without bound: 20 iterations of 64 KB is 1.3 MB and the
 * only question ever asked of it is whether a token near the END has arrived.
 */
class Peer {
  constructor({ label, write, subscribe, onExit, release }) {
    this.label = label;
    this._write = write;
    this._release = release;
    this.text = "";
    this.waiter = null;
    this.exited = null;
    subscribe((chunk) => {
      this.text += String(chunk);
      if (this.text.length > 1000000) this.text = this.text.slice(-500000);
      if (this.waiter && this.text.includes(this.waiter.needle)) {
        const settle = this.waiter;
        this.waiter = null;
        settle.resolve(process.hrtime.bigint());
      }
    });
    onExit((status) => { this.exited = status; });
  }

  /** Write one request and wait for its wrapped token. Resolves NaN on the bound. */
  ask(request, token) {
    const needle = `~${token}~`;
    // ARMED BEFORE THE WRITE. A reply to a small request can arrive inside the same tick the write
    // returns on, and a waiter installed afterwards would wait out the full bound for something that
    // had already come.
    const settled = new Promise((resolve) => {
      this.waiter = { needle, resolve };
      setTimeout(() => {
        if (this.waiter && this.waiter.needle === needle) { this.waiter = null; resolve(NaN); }
      }, REPLY_TIMEOUT_MS).unref();
    });
    const started = process.hrtime.bigint();
    this._write(request + CR + LF);
    return settled.then((at) => (typeof at === "bigint" ? Number(at - started) / 1e6 : NaN));
  }

  sees(needle) {
    return this.text.includes(needle);
  }

  async leave() {
    this._write("Q" + CR + LF);
    const deadline = Date.now() + EXIT_TIMEOUT_MS;
    while (!this.exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this._release) { try { this._release(); } catch { /* already gone */ } }
    return this.exited;
  }
}

/** One request shape on one transport: its samples and its own rejections. */
class Arm {
  constructor(transport, label, make, iterations) {
    this.transport = transport;
    this.label = label;
    this.make = make;
    this.iterations = iterations;
    this.ms = [];
    this.timedOut = 0;
    this.badSpans = 0;
    this.issued = 0;
  }

  async run(peer) {
    for (let i = 0; i < this.iterations; i += 1) {
      const token = freshToken();
      this.issued += 1;
      const elapsed = await peer.ask(this.make(token), token);
      if (!Number.isFinite(elapsed)) { this.timedOut += 1; continue; }
      if (!(elapsed > 0)) { this.badSpans += 1; continue; }
      this.ms.push(elapsed);
    }
  }
}

function openPtyPeer() {
  const require = createRequire(import.meta.url);
  const pty = require("node-pty");
  const handle = pty.spawn(process.execPath, [CHILD], {
    name: "xterm-color",
    cols: COLS,
    rows: ROWS,
    cwd: HERE,
    env: process.env,
    // THE SAME VARIABLE `lib/runner.mjs` READS, so this probe runs on whichever ConPTY backend the
    // operator's environment would use rather than on a default of its own.
    useConptyDll: String(process.env.AIFY_ENV_CONPTY_DLL ?? "").trim() === "1",
  });
  return new Peer({
    label: "pty",
    write: (text) => handle.write(text),
    subscribe: (fn) => handle.onData(fn),
    onExit: (fn) => handle.onExit(({ exitCode, signal }) => fn({ exitCode, signal })),
  });
}

function openPipePeer() {
  const handle = spawn(process.execPath, [CHILD], {
    cwd: HERE, env: process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  handle.stdout.setEncoding("utf8");
  return new Peer({
    label: "pipe",
    write: (text) => handle.stdin.write(text),
    subscribe: (fn) => handle.stdout.on("data", fn),
    onExit: (fn) => handle.on("exit", (exitCode, signal) => fn({ exitCode, signal })),
    // NOT A KILL. The child has already left by the time this runs; closing our end of its stdin is
    // what stops an open pipe from holding this process's event loop open.
    release: () => { try { handle.stdin.end(); } catch { /* already closed */ } },
  });
}

function armsFor(transport) {
  return [
    new Arm(transport, "echo (round trip)", (token) => `E ${token}`, ECHO_ITERATIONS),
    ...PAINT_SIZES.map((size) => new Arm(
      transport,
      `paint ${size >= 1024 ? `${size / 1024} KB` : `${size} B`}`,
      (token) => `P ${token} ${size}`,
      PAINT_ITERATIONS,
    )),
  ];
}

const results = [];
const refusals = [];

for (const [transport, open] of [["pty", openPtyPeer], ["pipe", openPipePeer]]) {
  const peer = open();
  const arms = armsFor(transport);
  for (const arm of arms) await arm.run(peer);
  // NEGATIVE CONTROL, ASKED OF THE SAME STREAM THAT ANSWERED EVERY ARM, before the child is asked
  // to leave. A wrap nobody requested must not be found; a search that cannot return ABSENT cannot
  // return PRESENT.
  const foundAbsent = peer.sees(`~${freshToken()}~`);
  const exited = await peer.leave();

  for (const arm of arms) {
    if (arm.timedOut || arm.badSpans) {
      refusals.push(`${transport} ${arm.label}: ${arm.timedOut} repl(ies) never arrived within `
        + `${REPLY_TIMEOUT_MS}ms and ${arm.badSpans} produced a span that is not positive`);
    }
    // THE LEDGER HAS TO BALANCE, or requests are going somewhere this probe does not name.
    const accounted = arm.ms.length + arm.timedOut + arm.badSpans;
    if (accounted !== arm.issued) {
      refusals.push(`${transport} ${arm.label}: ${accounted} of ${arm.issued} requests accounted for`);
    }
    if (!arm.ms.length) refusals.push(`${transport} ${arm.label}: produced no usable sample`);
  }
  if (foundAbsent) {
    refusals.push(`${transport}: a wrapped token nobody requested was found in the stream, so its `
      + "absences say nothing and neither do its presences");
  }
  if (!exited) {
    refusals.push(`${transport}: the child did not exit within ${EXIT_TIMEOUT_MS}ms of being asked `
      + "to; it is left running rather than killed, because node-pty's default ConPTY kill attaches "
      + "to a console");
  } else if (exited.exitCode !== 0) {
    refusals.push(`${transport}: the child exited ${exited.exitCode} (signal ${exited.signal}), so `
      + "some of these requests were answered by a process on its way out");
  }
  results.push({ transport, arms, exited });
}

if (refusals.length) {
  process.stderr.write(`NOTHING IS PUBLISHED:${LF}`);
  for (const refusal of refusals) process.stderr.write(`  - ${refusal}${LF}`);
  process.exit(1);
}

const lines = [
  `HOP ONE, THE SAME CHILD OVER A REAL PTY AND OVER A PIPE, at ${COLS}x${ROWS}.`,
  "",
  "  transport  arm                     n    p50 ms    p95 ms",
];
for (const { transport, arms } of results) {
  for (const arm of arms) {
    lines.push("  " + transport.padEnd(11) + arm.label.padEnd(20)
      + String(arm.ms.length).padStart(5)
      + median(arm.ms).toFixed(3).padStart(10)
      + percentile(arm.ms, 0.95).toFixed(3).padStart(10));
  }
}

const ptyEcho = median(results[0].arms[0].ms);
const pipeEcho = median(results[1].arms[0].ms);
lines.push("");
lines.push("EVERY SPAN IS ONE PROCESS'S CLOCK AT BOTH ENDS, which is why these are ROUND TRIPS and");
lines.push("not one-way times. Producer-to-handler is bounded ABOVE by an echo row and is NOT half of");
lines.push("it: the two directions are not symmetric and nothing here measured them separately.");
lines.push("");
lines.push("THE PAINT ROWS INCLUDE the child's own write and the transport's buffering, so they are a");
lines.push("request-to-fully-drained time for that payload, not a read cost in isolation.");
lines.push("");
lines.push(`THE TWO ECHO ROWS: pty ${ptyEcho.toFixed(3)}ms against pipe ${pipeEcho.toFixed(3)}ms, a `
  + `ratio of ${(ptyEcho / pipeEcho).toFixed(1)}x. Both were measured in`);
lines.push("THIS run, by the same code, against the same child. What the difference is CAUSED by is");
lines.push("not established here -- only that the two transports do not read alike.");
lines.push("");
const issued = results.reduce((n, r) => n + r.arms.reduce((m, a) => m + a.issued, 0), 0);
lines.push(`CONTROLS, in this run: all ${issued} requests were answered with their own wrapped token,`);
lines.push("a wrap nobody requested was NOT found on either stream, and both children exited 0 when");
lines.push("asked rather than being killed.");
lines.push("");
lines.push("WHAT THIS IS NOT: the operator's agents. This child echoes and writes a pre-built buffer;");
lines.push("a coding agent computes between frames, and its PTY carries that too. And the spawn is a");
lines.push("REPLICA of `lib/runner.mjs`'s options rather than that module, which is not imported here");
lines.push("because it pulls in the owned-process registry and the reaper.");

// THE PTY HANDLE HOLDS THE LOOP OPEN AFTER ITS CHILD IS GONE, measured: the first version of this
// file published these figures and then never exited, so a caller reading its exit status got a
// timeout rather than a result. Exiting on the write's callback rather than after it keeps stdout
// from being truncated when it is a pipe.
process.stdout.write(lines.join(LF) + LF, () => process.exit(0));
