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
//: The shape `freshToken` mints, so a reply can be recognised without knowing which one it is --
//: which is what makes an UNREQUESTED one visible at all.
const MARKER = /~[0-9a-f]{10}~/g;
const MARKER_CHARS = 12;
//: WHAT A PAINTED ROW LOOKS LIKE COMING BACK. The drain is measured in ROWS, not bytes, and that is
//: forced by the transport rather than chosen: a ConPTY is a terminal, not a pipe. It renders the
//: child's writes onto a 132x40 screen and emits its own updates, so a 64 KB paint comes back as at
//: most a screenful -- a byte floor refused every real PTY run on the first attempt, which is the
//: measurement telling me the semantics were wrong. Rows survive the rendering; bytes do not.
const PAINTED_ROW = /row \d+ of a full-screen redraw/g;
//: THE ROWS A PAINT MAY CONTAIN come from the CHILD, which builds the payloads -- see its `I`
//: verb. A row-shaped string is not a row from the payload that was requested: review answered
//: with rows 900 to 904, none of which any payload addresses, and every figure published.
//:
//: HOW MANY DISTINCT PAINTED ROWS MUST ARRIVE before a paint's timing is a sample. MEASURED, and
//: the report prints the numbers it is set against: the fewest any iteration delivered is 14 / 39 /
//: 39 through the PTY and 14 / 200 / 200 through the pipe, at 1 / 16 / 64 KB. Five is well clear of
//: the smallest and far above the ZERO a terminator-only reply or a substituted payload produces.
//:
//: THE 39-VERSUS-200 IS THE TRANSFORMATION ITSELF, visible in the output. The pipe carries every row
//: the child wrote; the ConPTY renders them onto a 40-row screen and emits that. Same child, same
//: bytes offered, different observable -- which is why the drain is counted in rows and not bytes.
const MIN_PAINTED_ROWS = 5;

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
    //: WHAT ARRIVED WHILE ONE REQUEST WAS OUTSTANDING. A reply that carries the terminator and none
    //: of the paint is not a drain of that paint, and final-token membership alone admitted exactly
    //: that -- review dropped the payload, kept the token, and all eight rows published. It also
    //: admitted a substituted payload of the same length, which a byte count cannot tell apart and
    //: the painted rows can.
    this.window = "";
    //: EVERY MARKER-SHAPED RUN THAT HAS ARRIVED, in order. One request should produce exactly one,
    //: and it should be the one that was asked for. Counting them is what refuses a DUPLICATED reply
    //: and a reply nobody requested, neither of which a per-request membership test can see.
    this.markers = [];
    let carry = "";
    subscribe((chunk) => {
      const text = String(chunk);
      if (this.waiter) {
        this.window += text;
        if (this.window.length > 1000000) this.window = this.window.slice(-500000);
      }
      // OVERLAPPED, because a marker can straddle a chunk boundary and a scan of each chunk alone
      // would miss it -- which would turn this ledger into a source of false refusals.
      const scanned = carry + text;
      for (const found of scanned.match(MARKER) || []) this.markers.push(found);
      carry = scanned.slice(-(MARKER_CHARS - 1));
      this.text += text;
      if (this.text.length > 1000000) this.text = this.text.slice(-500000);
      if (this.waiter && this.text.includes(this.waiter.needle)) {
        const settle = this.waiter;
        this.waiter = null;
        settle.resolve(process.hrtime.bigint());
      }
    });
    onExit((status) => { this.exited = status; });
  }

  /**
   * Write one request and wait for its wrapped token.
   *
   * Answers `{ms, rows}`, or NaN milliseconds when nothing usable arrived in time.
   */
  ask(request, token, maxRow = 0) {
    const needle = `~${token}~`;
    this.window = "";
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
    return settled.then((at) => {
      const seen = [...new Set(this.window.match(PAINTED_ROW) || [])];
      const rows = seen.length;
      // A ROW NUMBER NO PAYLOAD ADDRESSES IS NOT THIS PAINT. `maxRow` comes from the child, which
      // builds the payloads and answers for them; zero means the arm asked for no paint and there
      // is nothing to bind.
      const foreign = maxRow > 0 && seen.some((line) => {
        const number = Number(line.slice(4, line.indexOf(" of ")));
        return !(number >= 1 && number <= maxRow);
      });
      if (typeof at !== "bigint") return { ms: NaN, rows, foreign };
      const ms = Number(at - started) / 1e6;
      // THE AGE DECIDES, NOT WHICH CALLBACK RAN FIRST. A reply delivered after the bound but before
      // the deferred timer fired was accepted and aged -- review's completion at 6000ms on an
      // injected clock published as 6000.000ms under a 5000ms deadline. A timer is a hint about
      // elapsed time; the elapsed time is the fact.
      //
      // AND THIS GUARD SURVIVES ITS OWN MUTATION BATTERY, which is worth saying rather than hiding.
      // Removing it changes nothing here, because on this host no reply is ever late and no timer is
      // ever starved -- review reached the case with an INJECTED monotonic clock, which this file
      // does not have. So it is a guard against a condition this file cannot currently produce, kept
      // because the alternative is publishing a number aged past its own bound.
      if (!(ms >= 0) || ms > REPLY_TIMEOUT_MS) return { ms: NaN, rows, foreign, aged: ms > REPLY_TIMEOUT_MS };
      return { ms, rows, foreign };
    });
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

/** One request shape on one transport: its samples, its own rejections, and what it asked for. */
class Arm {
  constructor(transport, label, make, iterations, expectBytes = 0) {
    this.transport = transport;
    this.label = label;
    this.make = make;
    this.iterations = iterations;
    //: WHETHER THIS ARM ASKS FOR A PAINT AT ALL. The echo arm does not, so it is not held to the row
    //: floor -- there is nothing for it to drain, and holding it there would refuse a correct run.
    this.expectBytes = expectBytes;
    //: THE FEWEST DISTINCT PAINTED ROWS EVERY ITERATION DELIVERED, reported so the floor below can
    //: be seen to be clear of the real numbers rather than asserted to be.
    this.minRows = Infinity;
    this.ms = [];
    this.timedOut = 0;
    this.badSpans = 0;
    this.thinDrains = 0;
    this.agedOut = 0;
    //: REPLIES CARRYING A ROW NUMBER NO PAYLOAD ADDRESSES. Counted apart from a thin drain:
    //: one says too little arrived, the other says the wrong thing did.
    this.foreignRows = 0;
    //: THE HIGHEST ROW THIS ARM'S PAYLOAD ADDRESSES, asked of the child before the arm runs.
    this.maxRow = 0;
    this.issued = 0;
    this.tokens = [];
  }

  /**
   * Ask the child which rows this arm's payload addresses, before timing anything.
   *
   * THE PARENT MUST NOT OWN THE RECIPE. Copying `paintedBytes` here to derive the range would make
   * two sources of truth for one fact, and the one that rots is always the copy. The child builds
   * the payloads, so the child answers for them.
   */
  async learnRows(peer) {
    if (!this.expectBytes) return true;
    const token = freshToken();
    this.tokens.push(`~${token}~`);
    const { ms } = await peer.ask(`I ${token} ${this.expectBytes}`, token);
    if (!Number.isFinite(ms)) return false;
    const said = peer.window.match(/maxrow=(\d+)/);
    this.maxRow = said ? Number(said[1]) : 0;
    return this.maxRow > 0;
  }

  async run(peer) {
    for (let i = 0; i < this.iterations; i += 1) {
      const token = freshToken();
      this.issued += 1;
      this.tokens.push(`~${token}~`);
      const { ms, rows, aged, foreign } = await peer.ask(this.make(token), token, this.maxRow);
      if (foreign) { this.foreignRows += 1; continue; }
      if (this.expectBytes) this.minRows = Math.min(this.minRows, rows);
      // AGED AND NEVER-ARRIVED ARE DIFFERENT FACTS and are counted apart. Folded together, a run in
      // which the deadline guard actually fired would be indistinguishable from one where a reply
      // was simply lost -- and the guard's whole point is that those are not the same thing.
      if (aged) { this.agedOut += 1; continue; }
      if (!Number.isFinite(ms)) { this.timedOut += 1; continue; }
      if (!(ms > 0)) { this.badSpans += 1; continue; }
      // A REPLY IS NOT A DRAIN. Review answered a 64 KB paint request with the terminator alone, and
      // separately with an unrelated payload of the same length, and every row published both times:
      // the terminator says the child reached the end of its handler, not that the paint crossed the
      // transport. Distinct PAINTED ROWS is the measure a terminal does not destroy, and it refuses
      // both -- a substituted payload carries none of them.
      if (this.expectBytes && rows < MIN_PAINTED_ROWS) {
        this.thinDrains += 1;
        continue;
      }
      this.ms.push(ms);
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
      size,
    )),
  ];
}

const results = [];
const refusals = [];

for (const [transport, open] of [["pty", openPtyPeer], ["pipe", openPipePeer]]) {
  const peer = open();
  const arms = armsFor(transport);
  for (const arm of arms) {
    // THE HANDSHAKE FIRST, and a child that cannot answer it stops the run: without the payload's
    // row range there is nothing to bind an admission to, and a probe that quietly fell back to
    // "any row-shaped string" would be the exact weakness this replaces.
    if (!await arm.learnRows(peer)) {
      refusals.push(`${transport} ${arm.label}: the child did not say which rows its payload `
        + "addresses, so a reply could not be bound to the paint that was requested");
    }
    await arm.run(peer);
  }
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
    if (arm.agedOut) {
      refusals.push(`${transport} ${arm.label}: ${arm.agedOut} repl(ies) arrived AFTER the `
        + `${REPLY_TIMEOUT_MS}ms bound while their timer had not yet run, so a starved loop was `
        + "about to publish an aged sample as a fresh one");
    }
    if (arm.foreignRows) {
      refusals.push(`${transport} ${arm.label}: ${arm.foreignRows} repl(ies) carried a painted row `
        + `number this payload never addresses (its highest is ${arm.maxRow}), so what came back is `
        + "not the paint that was asked for");
    }
    if (arm.thinDrains) {
      refusals.push(`${transport} ${arm.label}: ${arm.thinDrains} repl(ies) carried fewer than `
        + `${MIN_PAINTED_ROWS} distinct painted rows (fewest seen: ${arm.minRows}), so the `
        + "terminator arrived without the paint it terminates");
    }
    // THE LEDGER HAS TO BALANCE, or requests are going somewhere this probe does not name.
    const accounted = arm.ms.length + arm.timedOut + arm.badSpans + arm.thinDrains + arm.agedOut
      + arm.foreignRows;
    if (accounted !== arm.issued) {
      refusals.push(`${transport} ${arm.label}: ${accounted} of ${arm.issued} requests accounted for`);
    }
    if (!arm.ms.length) refusals.push(`${transport} ${arm.label}: produced no usable sample`);
  }
  // ONE REPLY PER REQUEST, AND EACH THE ONE THAT WAS ASKED FOR. A per-request membership test cannot
  // see a DUPLICATED reply or one nobody requested -- review published all eight rows with each --
  // because both leave the needle it was looking for exactly where it looked. The ledger of every
  // marker-shaped run that crossed the stream can see both.
  const wanted = arms.flatMap((arm) => arm.tokens);
  const got = peer.markers;
  if (got.length !== wanted.length || got.some((mark, at) => mark !== wanted[at])) {
    const extra = got.filter((mark) => !wanted.includes(mark));
    refusals.push(`${transport}: ${got.length} replies crossed the stream for ${wanted.length} `
      + `requests, ${extra.length} of them for a token never issued -- so a reply was duplicated, `
      + "reordered, or invented, and no per-request check can see that");
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
lines.push("");
lines.push("EVERY PAINT ARM DRAINED, and this is the number the floor is set against: the fewest");
lines.push(`DISTINCT painted rows any single iteration delivered, against a floor of ${MIN_PAINTED_ROWS}.`);
for (const { transport, arms } of results) {
  const painted = arms.filter((arm) => arm.expectBytes)
    .map((arm) => `${arm.label.trim()} ${arm.minRows}`);
  lines.push(`  ${transport.padEnd(6)} ${painted.join(", ")}`);
}
lines.push("A terminator-only reply delivers ZERO, and so does a payload of the same length carrying");
lines.push("something else -- which a byte count could not tell apart. What is NOT bound is the paint's");
lines.push("exact bytes: a ConPTY renders onto a 132x40 screen and emits its own updates, so the bytes");
lines.push("out are not the bytes in, and for a TIMING of a payload of that size the content is not");
lines.push("what the number depends on.");
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
