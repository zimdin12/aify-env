// How stale a byte is by the time the service has it.
//
// THE HOP, named before the number because every earlier transport claim in this project was
// retracted for naming the wrong one: from `outputSender.send(terminalId, chunk)` accepting a chunk,
// to the bytes of that chunk arriving in a request handler on the service side. Hop TWO of the five
// between a producer and a browser terminal -- aify-env to the service. Not the pty read before it
// (hop one), not the service's write queue after it (hop three), not the WebSocket (hop four) and
// not the browser (hop five).
//
// WHY IT NEEDED ITS OWN NUMBER. Hop two had only ever been measured by COUNT: 500 chunks arriving
// during one in-flight POST become exactly one more POST. That is the right shape for proving
// coalescing is bounded, and it says nothing about how long any individual byte waited -- which is
// the thing an operator watching a console actually experiences. A count is not a latency.
//
// EACH CHUNK CARRIES A UNIQUE MARKER AND IS AGED AGAINST THE ARRIVAL OF THE BODY CARRYING IT.
// Coalescing means one request can carry dozens of chunks, so pairing by ORDER or by TIME would
// silently age a chunk against somebody else's request. This project has made that exact mistake in
// its store-hop probe and corrected it there; the correction is applied here from the start.
//
// A CHUNK THAT NEVER ARRIVES IS A REJECTION, counted and printed, never dropped and never aged
// against something else.
//
// THE CONTROLS ARE IN THE SAME RUN. POSITIVE: an arm whose `post` sleeps 20ms before issuing must
// show ages above 20ms, or this instrument cannot see a slow send. NEGATIVE: a marker that is never
// sent must never be found in anything the server received -- a probe that cannot return ABSENT
// cannot return PRESENT.
//
// NOTHING REACHES stdout UNLESS EVERY CONTROL HELD. A refusal printed after the rows cannot retract
// them.
//
// Run: node scripts/measure-send-hop.mjs

import http from "node:http";

import { createOutputSender } from "../lib/plugins/aify-comms/output-sender.mjs";

const TERMINAL = "term-send-hop";
const LF = String.fromCharCode(10);

/** The service side: a real HTTP server that timestamps each body as it finishes arriving. */
class ReceivingService {
  constructor() {
    this.arrivals = [];
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (piece) => { raw += piece; });
      req.on("end", () => {
        // STAMPED WHEN THE BODY IS COMPLETE, which is when the service could first act on it.
        // Stamping on the first byte would credit the hop for work still on the wire.
        this.arrivals.push({ at: process.hrtime.bigint(), body: raw });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
    });
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve(this.server.address().port));
    });
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  /** The first arrival whose body contains this marker, or null. Content, never order or time. */
  firstCarrying(marker) {
    return this.arrivals.find((arrival) => arrival.body.includes(marker)) || null;
  }

  carries(marker) {
    return this.firstCarrying(marker) !== null;
  }
}

/** One emit cadence, run end to end and accounted for chunk by chunk. */
class Arm {
  constructor({ label, chunks, gapMs, postDelayMs = 0 }) {
    this.label = label;
    this.chunks = chunks;
    this.gapMs = gapMs;
    this.postDelayMs = postDelayMs;
    this.sentAt = new Map();
    this.requests = 0;
    this.postMs = [];
  }

  async run(port) {
    const service = new ReceivingService();
    // Each arm gets its OWN server so one arm's arrivals can never be credited to another's chunks.
    const ownPort = await service.listen();
    const sender = createOutputSender({
      post: async (terminalId, body) => {
        // MEASURED, NOT REQUESTED. `delay(5)` on this host is ~15.6ms -- the platform's timer
        // granularity -- so the arm labels below would overstate their own precision if they
        // reported what was asked for. The span actually taken is what the table prints.
        const postStarted = process.hrtime.bigint();
        if (this.postDelayMs) await delay(this.postDelayMs);
        this.requests += 1;
        const response = await fetch(`http://127.0.0.1:${ownPort}/terminals/${terminalId}/output`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`service answered ${response.status}`);
        await response.text();
        this.postMs.push(Number(process.hrtime.bigint() - postStarted) / 1e6);
      },
      status: "attached",
    });

    for (let i = 0; i < this.chunks; i += 1) {
      const marker = `<${this.label}-${i}>`;
      this.sentAt.set(marker, process.hrtime.bigint());
      sender.send(TERMINAL, `${marker} a line of output from an agent${LF}`);
      if (this.gapMs > 0) await delay(this.gapMs);
      else await new Promise((resolve) => setImmediate(resolve));
    }

    // Let the tail drain. Bounded rather than open-ended: anything still unsent after this is a
    // REJECTION, which is the honest answer for a probe that cannot wait for ever.
    await settle(() => sender.pendingFor(TERMINAL)?.pending === 0
      && sender.pendingFor(TERMINAL)?.inFlight === false, 5000);
    await delay(50 + this.postDelayMs * 2);

    this.service = service;
    this.ages = [];
    this.missing = [];
    for (const [marker, sentAt] of this.sentAt) {
      const arrival = service.firstCarrying(marker);
      if (!arrival) { this.missing.push(marker); continue; }
      this.ages.push(Number(arrival.at - sentAt) / 1e6);
    }
    this.ages.sort((a, b) => a - b);
    // THE NEGATIVE CONTROL, in this arm and against this arm's own server: a marker shaped exactly
    // like the others but never handed to the sender must not be found.
    this.foreignFound = service.carries(`<${this.label}-never-sent>`);
    await service.close();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(5);
  }
  return false;
}

function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
}

const ARMS = [
  // A quiet agent: one chunk every ~50ms, nothing to coalesce with.
  new Arm({ label: "quiet", chunks: 40, gapMs: 50 }),
  // A talking agent: a chunk as fast as the loop will hand one over.
  new Arm({ label: "busy", chunks: 400, gapMs: 0 }),
];
// THE SERVICE'S SPEED IS THE HOP'S LATENCY, and this sweep is what turns that from an argument
// about the code into a measurement. Coalescing holds new chunks while a POST is in flight, so a
// chunk's age is dominated by how long the service takes to answer -- not by anything aify-env does.
// The 20ms member doubles as the positive control: it MUST exceed the delay it was given.
const DELAY_SWEEP = [0, 5, 20, 50].map((postDelayMs) => new Arm({
  label: `service +${postDelayMs}ms`, chunks: 40, gapMs: 0, postDelayMs,
}));
const CONTROL_DELAY_MS = 20;
const CONTROL = DELAY_SWEEP.find((arm) => arm.postDelayMs === CONTROL_DELAY_MS);
// FAILS CLOSED. A sweep with no delayed member leaves this undefined, and the run then died with a
// TypeError three lines from the end -- which a mutation caught, and which is the wrong shape: a
// probe that has lost its positive control has to SAY SO, not crash in a way somebody reads as a
// broken script and reruns.
if (!CONTROL) {
  process.stderr.write(`${LF}NOTHING IS PUBLISHED: the sweep contains no ${CONTROL_DELAY_MS}ms arm, `
    + `so this run has no positive control and cannot show that a slow send is visible.${LF}`);
  process.exit(1);
}

const rows = ["HOP TWO: send() accepted a chunk -> the service has its bytes",
  "  arm                       chunks   requests   service    p50 ms    p95 ms    max ms",
  "                                                   p50 ms                              "];
const refusals = [];

for (const arm of [...ARMS, ...DELAY_SWEEP]) {
  await arm.run();
  if (arm === DELAY_SWEEP[0]) {
    rows.push("");
    rows.push("  HOW LONG THE SERVICE TAKES TO ANSWER, and what that does to a chunk's age:");
  }
  const servicePost = percentile([...arm.postMs].sort((a, b) => a - b), 0.5);
  rows.push(`  ${arm.label.padEnd(22)}  ${String(arm.chunks).padStart(7)}  `
    + `${String(arm.requests).padStart(9)}  ${servicePost.toFixed(2).padStart(7)}  `
    + `${percentile(arm.ages, 0.5).toFixed(3).padStart(8)}  `
    + `${percentile(arm.ages, 0.95).toFixed(3).padStart(8)}  `
    + `${(arm.ages.at(-1) ?? NaN).toFixed(3).padStart(8)}`);
  if (arm.missing.length) {
    refusals.push(`${arm.label}: ${arm.missing.length} of ${arm.chunks} chunk(s) never reached the `
      + `service, so they cannot be aged`);
  }
  if (arm.foreignFound) {
    refusals.push(`${arm.label}: a marker that was NEVER SENT was found in what the service `
      + `received, so this collector cannot tell present from absent`);
  }
  if (!arm.ages.length) refusals.push(`${arm.label}: no chunk was aged at all`);
  if (arm.ages.some((ms) => !Number.isFinite(ms))) {
    refusals.push(`${arm.label}: a non-finite age was admitted`);
  }
}

const controlP50 = percentile(CONTROL.ages, 0.5);
if (!Number.isFinite(controlP50)) {
  refusals.push(`the control arm's p50 is not a finite number (${controlP50}), so it states nothing `
    + `about whether a slow send is visible`);
} else if (controlP50 < CONTROL_DELAY_MS) {
  refusals.push(`the control arm's p50 is ${controlP50.toFixed(3)}ms, under the 20ms its post was `
    + `delayed by -- this instrument cannot see a slow send`);
}

if (refusals.length) {
  process.stderr.write(`${LF}NOTHING IS PUBLISHED. A number is only a hop if its controls held:${LF}`);
  for (const line of refusals) process.stderr.write(`  - ${line}${LF}`);
  process.exitCode = 1;
} else {
  for (const row of rows) console.log(row);
  console.log("");
  console.log(`Every chunk was matched to the request that CARRIED IT, by content; a marker never `
    + `sent was not found; and a post delayed 20ms showed up as `
    + `${controlP50.toFixed(1)}ms.`);
  console.log("");
  // THE RELATIONSHIP, COMPUTED FROM THE SWEEP rather than left for a reader to notice. A chunk that
  // arrives while a POST is in flight waits for that POST to finish AND for the next one to
  // complete, so its age is about twice the service's answer time. The arm LABELS are what was
  // requested; the `service p50` column is what was measured, and on this host they differ because
  // its timer granularity is ~15.6ms.
  const ratios = DELAY_SWEEP.filter((arm) => arm.requests <= 2 && arm.postMs.length).map((arm) => {
    const service = percentile([...arm.postMs].sort((a, b) => a - b), 0.5);
    return percentile(arm.ages, 0.5) / service;
  });
  if (ratios.length) {
    const spread = ratios.map((r) => r.toFixed(2)).join(", ");
    console.log(`A CHUNK'S AGE IS ABOUT TWICE THE SERVICE'S ANSWER TIME (${spread}x across the `
      + `coalescing arms): it waits for the POST in flight to finish and then for its own to `
      + `complete. aify-env's own contribution is the ${percentile(ARMS[1].ages, 0.5).toFixed(2)}ms `
      + `the busy arm shows against a service that answers immediately. So this hop is not a fixed `
      + `cost -- it TRACKS how fast the service answers, which is a single-worker event loop shared `
      + `by every console on the host.`);
  }
  console.log("WHAT THIS IS NOT: a real pty feeding a real service over a real network. The sender "
    + "and the receiver are one process on loopback, so this is the hop's own cost and queueing, "
    + "not a production round trip.");
}
