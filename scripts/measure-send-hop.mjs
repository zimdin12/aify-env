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
        //
        // AND DECODED, NOT SEARCHED. The first version kept the raw text and asked whether it
        // CONTAINED a marker, so a body that was nothing but markers, or was not JSON at all,
        // counted as a delivery -- the collector was matching a substring, not a chunk. The
        // envelope is parsed here and the arrival carries the terminal it was addressed to and the
        // output field alone, so everything downstream is asking about the payload the sender
        // actually posted.
        let output = null;
        let terminalId = null;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.output === "string") output = parsed.output;
          terminalId = decodeURIComponent(String(req.url || "").split("/")[2] || "");
        } catch { output = null; }
        this.arrivals.push({ at: process.hrtime.bigint(), output, terminalId, undecodable: output === null });
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

  /**
   * How many times this exact CHUNK appears across everything the service received, for the
   * terminal it was posted to.
   *
   * THE WHOLE CHUNK, NOT THE MARKER. Asking whether the output CONTAINED the marker accepted a
   * valid envelope carrying only the marker and nothing else -- the bytes the producer wrote were
   * never checked. And counting matching REQUESTS rather than OCCURRENCES read a whole output
   * duplicated INSIDE one request as duplicated=0.
   */
  occurrencesOf(chunk) {
    let seen = 0;
    for (const arrival of this.arrivals) {
      if (arrival.output === null || arrival.terminalId !== TERMINAL) continue;
      let from = 0;
      for (;;) {
        const at = arrival.output.indexOf(chunk, from);
        if (at < 0) break;
        seen += 1;
        from = at + chunk.length;
      }
    }
    return seen;
  }

  /** Arrivals whose DECODED output carries this exact chunk, for the terminal it was posted to. */
  carrying(chunk) {
    return this.arrivals.filter((arrival) => arrival.output !== null
      && arrival.terminalId === TERMINAL
      && arrival.output.includes(chunk));
  }

  /** The first such arrival, or null. Content and address, never order or time. */
  firstCarrying(marker) {
    return this.carrying(marker)[0] || null;
  }

  carries(marker) {
    return this.firstCarrying(marker) !== null;
  }

  get undecodable() {
    return this.arrivals.filter((arrival) => arrival.undecodable).length;
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
    this.answerMs = [];
    this.issuedPosts = 0;
    this.completedPosts = 0;
    this.failedPosts = 0;
  }

  async run(port) {
    const service = new ReceivingService();
    // Each arm gets its OWN server so one arm's arrivals can never be credited to another's chunks.
    const ownPort = await service.listen();
    const sender = createOutputSender({
      post: async (terminalId, body) => {
        // TWO INTERVALS, NAMED APART, because the first version reported one and called it the
        // other. It timed the WHOLE call -- including the injected hold, which sleeps BEFORE the
        // request is issued -- and printed it in a column headed "service". That is the caller's
        // post duration, not the service's answer time, and the "about twice the service's answer
        // time" conclusion drawn from it named an interval nothing here measured. Review
        // demonstrated it by moving only the hold to after the response: the 50ms arm went from
        // 101.8ms age against a 51.0ms column to 51.8ms against 51.0ms, and the same sentence still
        // read "about twice" beside 1.02x.
        // THE WHOLE AWAITED POST IS GUARDED, because the sender catches whatever escapes it and
        // carries on -- that is the behaviour keeping a console alive through a service blip, and it
        // means a failure this probe does not count is a failure nobody ever sees. Counting only a
        // non-OK STATUS missed both of the other shapes: a `fetch` rejection, and a `text()`
        // rejection after the request had already arrived. Review failed one quiet post that way and
        // got 40 arrived chunks, 39 completed posts, zero recorded failures, exit 0.
        const callStarted = process.hrtime.bigint();
        this.issuedPosts += 1;
        try {
          if (this.postDelayMs) await delay(this.postDelayMs);
          const issuedAt = process.hrtime.bigint();
          this.requests += 1;
          const response = await fetch(`http://127.0.0.1:${ownPort}/terminals/${terminalId}/output`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`service answered ${response.status}`);
          await response.text();
          const now = process.hrtime.bigint();
          this.postMs.push(Number(now - callStarted) / 1e6);      // the caller's whole post
          this.answerMs.push(Number(now - issuedAt) / 1e6);       // request issued -> response read
          this.completedPosts += 1;
        } catch (error) {
          this.failedPosts += 1;
          throw error;                                            // the sender's own path, unchanged
        }
      },
      status: "attached",
    });

    for (let i = 0; i < this.chunks; i += 1) {
      // KEYED ON THE WHOLE CHUNK, not on the marker inside it. The bytes the producer wrote are
      // what has to arrive; a marker is only how one chunk is told from another.
      const chunk = `<${this.label}-${i}> a line of output from an agent${LF}`;
      this.sentAt.set(chunk, process.hrtime.bigint());
      sender.send(TERMINAL, chunk);
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
    for (const [chunk, sentAt] of this.sentAt) {
      const arrival = service.firstCarrying(chunk);
      if (!arrival) { this.missing.push(chunk); continue; }
      this.ages.push(Number(arrival.at - sentAt) / 1e6);
    }
    this.ages.sort((a, b) => a - b);
    // ONCE, NOT AT LEAST ONCE. A chunk that appears in two arrivals was delivered twice, which is a
    // different world from the one being measured, and taking `[0]` and moving on would hide it.
    this.duplicated = [...this.sentAt.keys()].filter((c) => service.occurrencesOf(c) > 1).length;
    this.undecodable = service.undecodable;
    // THE NEGATIVE CONTROL, in this arm and against this arm's own server: a marker shaped exactly
    // like the others but never handed to the sender must not be found.
    this.foreignFound = service.carries(`<${this.label}-never-sent> a line of output from an agent${LF}`);
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
// HOW LONG A POST TAKES IS THE HOP'S LATENCY, and this sweep measures that relationship. Coalescing
// holds new chunks while a POST is in flight, so a chunk's age rises with the post's duration.
//
// THE HOLD IS THE CALLER'S, NOT THE SERVICE'S, and an earlier version of this comment said the
// opposite. `delay()` runs BEFORE `fetch`, so it lands in the `post` column and never in `answer` --
// which is exactly why `answer` stays at about 2ms across every row of the sweep. Reading the sweep
// as "the service got slower" was the mis-naming review caught.
//
// The 20ms member doubles as the positive control: it MUST exceed the delay it was given.
const DELAY_SWEEP = [0, 5, 20, 50].map((postDelayMs) => new Arm({
  label: `hold +${postDelayMs}ms`, chunks: 40, gapMs: 0, postDelayMs,
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
  "  arm                       chunks   requests  post p50  answer p50    p50 ms    p95 ms    max ms",
  "                                               (whole    (issued ->    <-- the chunk's age -->  ",
  "                                                call)     response)                             "];
const refusals = [];

for (const arm of [...ARMS, ...DELAY_SWEEP]) {
  await arm.run();
  if (arm === DELAY_SWEEP[0]) {
    rows.push("");
    rows.push("  HOW LONG A POST TAKES, and what that does to a chunk's age. The hold is applied");
    rows.push("  BEFORE the request is issued, so it lands in `post` and not in `answer` -- which is");
    rows.push("  why `answer` stays flat at about 2ms across every row below:");
  }
  const wholePost = percentile([...arm.postMs].sort((a, b) => a - b), 0.5);
  const answer = percentile([...arm.answerMs].sort((a, b) => a - b), 0.5);
  rows.push(`  ${arm.label.padEnd(22)}  ${String(arm.chunks).padStart(7)}  `
    + `${String(arm.requests).padStart(9)}  ${wholePost.toFixed(2).padStart(8)}  `
    + `${answer.toFixed(2).padStart(10)}  `
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
  if (arm.duplicated) {
    refusals.push(`${arm.label}: ${arm.duplicated} chunk(s) arrived MORE THAN ONCE -- across `
      + `requests or twice within one -- so "the request that carried it" is not a single thing `
      + `and these ages are not attributable`);
  }
  if (arm.undecodable) {
    refusals.push(`${arm.label}: ${arm.undecodable} request body(ies) could not be decoded as the `
      + `sender's envelope, so what arrived is not what this probe claims to be timing`);
  }
  // EVERY POST ACCOUNTED FOR. The sender CATCHES a failed post and carries on by design, so a run
  // against a service answering 500 to everything completed no posts, timed nothing, and published
  // exit 0 with NaN in every column. A benchmark whose subject never succeeded is not a slow
  // benchmark, it is not a benchmark.
  if (arm.failedPosts) {
    refusals.push(`${arm.label}: ${arm.failedPosts} post(s) FAILED, and the sender swallows those `
      + `by design -- so these figures describe only the ones that happened to work`);
  }
  if (!arm.completedPosts) {
    refusals.push(`${arm.label}: no post completed at all`);
  }
  // ISSUED = COMPLETED + FAILED, or a post ended in a way this ledger does not know about, and the
  // figures describe whichever subset happened to be countable.
  if (arm.issuedPosts !== arm.completedPosts + arm.failedPosts) {
    refusals.push(`${arm.label}: ${arm.issuedPosts} post(s) were issued but `
      + `${arm.completedPosts} completed and ${arm.failedPosts} failed -- the rest ended in a way `
      + `nothing here counted`);
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
  // WHAT THE SWEEP SHOWS, and what an earlier version of this line claimed it showed.
  //
  // WITHDRAWN: "a chunk's age is about twice the SERVICE'S ANSWER TIME", and with it "the sender is
  // not the problem". The injected hold sleeps BEFORE the request is issued, and a chunk's age ends
  // when the server has the complete body -- so the column that ratio was taken against was the
  // caller's WHOLE post, not the service answering. Review moved only the hold to after the
  // response and the 50ms arm went from 101.8ms age against 51.0ms to 51.8ms against 51.0ms: the
  // same sentence, still reading "about twice", now beside 1.02x. A ratio whose denominator is
  // whichever interval the instrument happened to time is not a mechanism.
  //
  // WHAT SURVIVES is narrower and is still the useful part: a chunk's age RISES WITH HOW LONG A
  // POST TAKES, because coalescing holds new chunks while one is in flight. The sweep shows that
  // relationship; it does not establish which part of a post's duration causes it, and this file no
  // longer says.
  const held = DELAY_SWEEP.filter((arm) => arm.requests <= 2 && arm.postMs.length);
  if (held.length) {
    const shape = held.map((arm) => {
      const post = percentile([...arm.postMs].sort((a, b) => a - b), 0.5);
      return `${post.toFixed(0)}ms post -> ${percentile(arm.ages, 0.5).toFixed(0)}ms age`;
    }).join(", ");
    console.log(`A CHUNK'S AGE RISES WITH HOW LONG A POST TAKES (${shape}), because coalescing `
      + `holds new chunks while one is in flight. WHICH PART of a post's duration drives it is NOT `
      + `established here: this probe's own hold sleeps before the request is issued, so its "post" `
      + `column is the caller's whole call and not the service answering.`);
    console.log(`Against a service that answers immediately the busy arm's age is `
      + `${percentile(ARMS[1].ages, 0.5).toFixed(2)}ms over ${ARMS[1].chunks} chunks -- which is `
      + `what this hop costs when nothing is holding it, and is not an attribution of the lag.`);
  }
  console.log("WHAT THIS IS NOT: a real pty feeding a real service over a real network. The sender "
    + "and the receiver are one process on loopback, so this is the hop's own cost and queueing, "
    + "not a production round trip.");
}
