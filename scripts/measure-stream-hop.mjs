// How long aify-env takes to carry bytes to and from a process it is running.
//
// THE HOP THIS MEASURES, named precisely because every earlier transport claim in this project was
// retracted for naming the wrong one: from `Runner.write` handing bytes to a running child's stdin,
// to `Runner.subscribe`'s callback receiving what that child echoed back. It is the first of the five
// hops between a producer and a browser terminal. It does NOT measure the service store, the SSE or
// WS delivery to a browser, or the xterm write, and nothing here should be read as though it did.
//
// BOTH TIMESTAMPS ARE OURS, taken in this process either side of the round trip. That is deliberate:
// comparing a child's clock with ours across a process boundary is exactly the move this project
// already retracted a transport claim for. The cost is that the child's own read-and-echo scheduling
// is INSIDE the number, so this is an upper bound on aify-env's share and not aify-env's share.
//
// THE CHILD STAYS WARM. A first version spawned a process per sample and measured ~27ms, which was
// mostly node's own startup: the interesting hop was a rounding error inside it. It also embedded the
// payload in the command line and died with ENAMETOOLONG at 64 KB, which is a fact about Windows
// argument limits and not about this transport.
//
// WHY A SPREAD AND NOT A MEDIAN. This host's own notes record wall-clock A/B as unmeasurable here:
// the live fleet is the load, and the same code has timed 44-47ms then 22-25ms minutes later. So the
// full spread is printed and no single figure is offered as the answer.
//
// REAL CHILD PROCESSES, PIPES NOT PTYS. `new Runner({ openTerminal: null })` is the pipe path, which
// is what `output-stream.test.js` uses; a PTY would add conpty on this platform and is a different
// measurement with a different noun.
//
// Run: node scripts/measure-stream-hop.mjs

import { Runner } from "../lib/runner.mjs";

const LF = String.fromCharCode(10);
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(LF);

//: An echo that stays alive: read a line, write back that many bytes, wait for the next. A line of
//: the form `N@MS` waits MS milliseconds first, which is the control arm.
const ECHO = [
  "process.stdin.setEncoding('utf8');",
  "let buf = '';",
  "process.stdin.on('data', (d) => {",
  "  buf += d;",
  "  let i;",
  "  while ((i = buf.indexOf('\\n')) >= 0) {",
  "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
  "    const at = line.indexOf('@');",
  "    const n = Number(at < 0 ? line : line.slice(0, at)) || 1;",
  "    const wait = at < 0 ? 0 : Number(line.slice(at + 1)) || 0;",
  "    const emit = () => process.stdout.write('R' + 'x'.repeat(Math.max(0, n - 2)) + 'R');",
  "    if (wait > 0) setTimeout(emit, wait); else emit();",
  "  }",
  "});",
].join("");

const spec = {
  service: "measure",
  fileText: ALLOWED,
  command: process.execPath,
  args: ["-e", ECHO],
};

function spread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0], p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

const SAMPLES = 20;
const runner = new Runner({ openTerminal: null });
const handle = await runner.start(spec);

let arrived = null;
let received = 0;
const stop = runner.subscribe(handle.id, (chunk) => {
  received += String(chunk).length;
  if (arrived) arrived();
});

console.log("aify-env's own carry: Runner.write -> the child's echo -> Runner.subscribe");
console.log(`${SAMPLES} samples per size, one warm child, pipes not PTYs, on a busy machine\n`);
console.log(`${"echoed bytes".padStart(13)}   round trip ms: min / p50 / p90 / max`);

async function measure(bytes, waitMs) {
  const times = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    received = 0;
    const done = new Promise((resolve) => {
      arrived = () => { if (received >= bytes) resolve(); };
    });
    const startedAt = process.hrtime.bigint();
    runner.write(handle.id, waitMs ? `${bytes}@${waitMs}${LF}` : `${bytes}${LF}`);
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    times.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  return spread(times);
}

for (const bytes of [64, 4096, 65536]) {
  const s = await measure(bytes, 0);
  console.log(
    `${String(bytes).padStart(13)}   `
    + `${s.min.toFixed(2)} / ${s.p50.toFixed(2)} / ${s.p90.toFixed(2)} / ${s.max.toFixed(2)}`,
  );
}

// ── the control ──────────────────────────────────────────────────────────────────────────────
//
// A SUB-MILLISECOND ROUND TRIP IS NOT BELIEVABLE ON ITS OWN. If this arm does not rise to roughly
// the delay the child was asked to take, the measurement is resolving on something other than the
// echo and every fast figure above it means nothing.
const DELAY_MS = 25;
const delayed = await measure(64, DELAY_MS);
console.log(
  `${LF}CONTROL, the child asked to wait ${DELAY_MS}ms before echoing 64 bytes:`
  + `${LF}${"".padStart(13)}   ${delayed.min.toFixed(2)} / ${delayed.p50.toFixed(2)} / `
  + `${delayed.p90.toFixed(2)} / ${delayed.max.toFixed(2)}`,
);
console.log(
  delayed.p50 >= DELAY_MS * 0.7
    ? `  -> the clock DOES report a slow round trip, so the fast ones above are the transport.`
    : `  -> THE CONTROL FAILED: a ${DELAY_MS}ms delay measured ${delayed.p50.toFixed(2)}ms, so this `
      + `instrument is not timing the echo and none of the figures above mean anything.`,
);

stop?.();
runner.stop(handle.id);

console.log(
  `${LF}THE CHILD'S READ-AND-ECHO IS INSIDE THESE NUMBERS. Both timestamps are taken in THIS process,`
  + `${LF}either side of the round trip, because comparing clocks across a process boundary is the move`
  + `${LF}this project has already retracted a transport claim for. So this is an UPPER BOUND on what`
  + `${LF}aify-env contributes, not a measurement of aify-env alone.`,
);
