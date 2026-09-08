// How long aify-env takes to carry bytes to and from a process it is running.
//
// THE HOP: from `Runner.write` handing bytes to a running child's stdin, to `Runner.subscribe`
// receiving what that child echoed back. The first of the five between a producer and a browser
// terminal. NOT the service store, NOT the WS/SSE delivery, NOT the xterm write.
//
// EVERY EARLIER VERSION OF THIS SCRIPT PUBLISHED FIGURES IT HAD NOT EARNED, and the corrections are
// the reason to trust this one:
//
//   v1  spawned a process per sample and measured node's startup (~27ms), with the hop as a rounding
//       error inside it, and died with ENAMETOOLONG at 64 KB because the payload rode in the argv
//   v2  turned the five-second timeout into a SUCCESSFUL SAMPLE, never checked `Runner.write`'s
//       `{ok:false}`, and completed on aggregate CHARACTER COUNT rather than reply identity. Review
//       ran its exact body with injected collaborators: 80 failed writes, ZERO echo bytes, 80
//       timeouts -- and it printed figures and declared its own control satisfied
//
// SO THIS ONE REJECTS BEFORE IT AGGREGATES. A sample counts only if the write was accepted, the reply
// arrived before the deadline, and the reply is THE ONE THIS SAMPLE ASKED FOR -- matched on a token
// unique to it, because `Runner` combines stdout with stderr and a late reply can otherwise satisfy a
// later sample. Anything else is recorded as a rejection with its reason, and rejections are printed
// beside the figures rather than dropped.
//
// AND NOTHING IS PUBLISHED IF THE CONTROL FAILS. A delayed arm that succeeded only by timing out
// would satisfy a lower-bound check, so the control requires valid samples too.
//
// Run: node scripts/measure-stream-hop.mjs

import { Runner } from "../lib/runner.mjs";

const LF = String.fromCharCode(10);
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(LF);

//: Reads `TOKEN:BYTES:WAIT`, waits, then writes `<TOKEN ... TOKEN>` of exactly BYTES characters.
//: The token makes a reply attributable to the sample that asked for it.
const ECHO = [
  "process.stdin.setEncoding('utf8');",
  "let buf = '';",
  "process.stdin.on('data', (d) => {",
  "  buf += d;",
  "  let i;",
  "  while ((i = buf.indexOf('\\n')) >= 0) {",
  "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
  "    const [token, sizeText, waitText] = line.split(':');",
  "    const size = Number(sizeText) || 1;",
  "    const wait = Number(waitText) || 0;",
  "    const open = '<' + token + ' ', close = ' ' + token + '>';",
  "    const fill = Math.max(0, size - open.length - close.length);",
  "    const emit = () => process.stdout.write(open + 'x'.repeat(fill) + close);",
  "    if (wait > 0) setTimeout(emit, wait); else emit();",
  "  }",
  "});",
].join("");

const spec = { service: "measure", fileText: ALLOWED, command: process.execPath, args: ["-e", ECHO] };

const DEADLINE_MS = 4000;
const WARMUP = 3;
const SAMPLES = 20;

const runner = new Runner({ openTerminal: null });
const handle = await runner.start(spec);

let inbox = "";
let onChunk = null;
const stop = runner.subscribe(handle.id, (chunk) => {
  inbox += String(chunk);
  if (onChunk) onChunk();
});

let childExited = false;
handle.exited?.then(() => { childExited = true; }).catch(() => { childExited = true; });

/** One sample, or a rejection with its reason. Never both, and never a silent success. */
async function sample(token, bytes, waitMs) {
  if (childExited) return { ok: false, why: "the child had already exited" };
  inbox = "";
  const expectedOpen = `<${token} `;
  const expectedClose = ` ${token}>`;

  const startedAt = process.hrtime.bigint();
  const wrote = runner.write(handle.id, `${token}:${bytes}:${waitMs}${LF}`);
  // THE WRITE IS CHECKED. v2 ignored this and reported round trips for writes that never happened.
  if (wrote && wrote.ok === false) {
    return { ok: false, why: `the write was refused: ${wrote.error ?? "no reason given"}` };
  }

  const arrived = await new Promise((resolve) => {
    let timer = null;
    onChunk = () => {
      const open = inbox.indexOf(expectedOpen);
      const close = inbox.indexOf(expectedClose, open + 1);
      if (open >= 0 && close >= 0) {
        clearTimeout(timer);
        onChunk = null;
        resolve({ at: process.hrtime.bigint(), text: inbox.slice(open, close + expectedClose.length) });
      }
    };
    timer = setTimeout(() => { onChunk = null; resolve(null); }, DEADLINE_MS);
    onChunk();
  });

  // A TIMEOUT IS A REJECTION, NOT A SAMPLE. This is the defect that made v2's figures meaningless.
  if (!arrived) return { ok: false, why: `no matching reply within ${DEADLINE_MS}ms` };
  if (arrived.text.length !== bytes) {
    return { ok: false, why: `reply was ${arrived.text.length} characters, asked for ${bytes}` };
  }
  return { ok: true, ms: Number(arrived.at - startedAt) / 1e6 };
}

async function series(label, bytes, waitMs) {
  const times = [];
  const rejected = [];
  for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
    const got = await sample(`T${bytes}W${waitMs}N${i}`, bytes, waitMs);
    if (i < WARMUP) continue;                       // discarded, explicitly
    if (got.ok) times.push(got.ms);
    else rejected.push(got.why);
  }
  return { label, bytes, waitMs, times, rejected };
}

function spread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return `${sorted[0].toFixed(2)} / ${at(0.5).toFixed(2)} / ${at(0.9).toFixed(2)} / `
    + `${sorted[sorted.length - 1].toFixed(2)}`;
}

const runs = [];
for (const bytes of [64, 4096, 65536]) runs.push(await series(`${bytes} bytes`, bytes, 0));
const DELAY_MS = 25;
const control = await series(`control, child waits ${DELAY_MS}ms`, 64, DELAY_MS);

stop?.();
runner.stop(handle.id);

console.log("aify-env's own carry: Runner.write -> the child's echo -> Runner.subscribe");
console.log(`${SAMPLES} samples per arm after ${WARMUP} discarded warm-ups; pipes, not PTYs\n`);

const controlValid = control.times.length === SAMPLES && control.rejected.length === 0;
const controlMedian = control.times.length
  ? [...control.times].sort((a, b) => a - b)[Math.floor(control.times.length / 2)] : 0;
const controlProves = controlValid && controlMedian >= DELAY_MS * 0.7;

for (const run of [...runs, control]) {
  const line = run.times.length
    ? spread(run.times)
    : "no valid sample";
  console.log(`${run.label.padStart(28)}   ${line}`
    + (run.rejected.length ? `   REJECTED ${run.rejected.length}: ${run.rejected[0]}` : ""));
}

console.log(
  controlProves
    ? `${LF}The control took ${controlMedian.toFixed(2)}ms for a requested ${DELAY_MS}ms with every `
      + `sample valid, so the clock reports a slow round trip and the arms above are the transport.`
    : `${LF}THE CONTROL DID NOT HOLD, so nothing above is published: `
      + `${control.times.length}/${SAMPLES} valid samples, median ${controlMedian.toFixed(2)}ms.`,
);
console.log(
  `${LF}A SAMPLE COUNTS ONLY IF the write was accepted, a reply arrived before ${DEADLINE_MS}ms, and`
  + `${LF}the reply carries THIS sample's token at exactly the requested length. Everything else is`
  + `${LF}rejected with a reason and counted above -- an earlier version of this script recorded`
  + `${LF}timeouts as samples and published the result.`
  + `${LF}${LF}Both timestamps are taken in this process, so the child's own read-and-echo is inside`
  + `${LF}the number: an upper bound on aify-env's share for THAT sample, not aify-env's share, and`
  + `${LF}not a statement about the PTY path, which this does not exercise.`,
);
