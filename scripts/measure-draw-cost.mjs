// What one dashboard frame costs, so the redraw cadence can be argued with a number.
//
// THE QUESTION THIS ANSWERS. The console pane redraws on a fixed 2000ms timer and on keypresses;
// arriving output triggers nothing, so a live agent TUI updates at 0.5 frames a second. The obvious
// lever is `AIFY_TUI_REFRESH_MS`, but it speeds up the WHOLE frame -- process list, health, traffic
// and pane together -- so the cost of a frame decides whether a faster pane is affordable at all.
// "Not a performance hog" is the operator's requirement, and an adjective cannot meet it.
//
// TWO ARMS, BECAUSE ONE OF THEM FLATTERS THE CACHE. `width` memoises, so a roster that renders
// identical text every frame measures the best case. The CHANGING arm gives every row a new title
// on every frame, which is the worst case a live view can present -- every string novel, every
// lookup a miss. The truth for a real fleet sits between them, nearer the static arm, because a
// process list mostly repeats while only the pane churns.
//
// NO NETWORK, NO PTY, NO TERMINAL. `startDashboard` takes an injected `fetchImpl` and an injected
// `write`, so this drives the real compose-and-render path with fake collaborators and discards the
// output. `once: true` renders exactly one frame and returns.
//
// A LIMIT WORTH KNOWING: `clearScreen: false` is used so each frame is a full write. The production
// view sets it true and diffs against the previous frame, which writes fewer bytes and adds the
// differ's own cost. So these numbers are compose-and-render, not the steady-state redraw.
//
// TWO SEPARATE QUESTIONS, AND THE SECOND ONE IS NEW. The frame check below answers "is this frame
// this frame". `execution-receipt.mjs` answers "is this function that function" -- it hashes the
// module's bytes AND the imported object's own source and requires the second to appear verbatim in
// the first. Review's standing objection was that an import line is one link; this is the rest of
// the chain, and the run refuses rather than publishing if it does not close. It still does NOT
// prove the function was called: nothing in-process can, and the report says so.
//
// Run: node scripts/measure-draw-cost.mjs

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { startDashboard } from "../lib/dashboard.mjs";

import { receiptFor, receiptLines } from "./execution-receipt.mjs";

// `fileURLToPath`, not `.pathname`: on Windows the latter yields a leading-slash "/C:/..."
// that `readFile` cannot open, and the registry read fails into an empty service list --
// which silently removed a probe from the count this script exists to make.
const REGISTRY_PATH = fileURLToPath(new URL("./measure-draw-cost.registry.json", import.meta.url));
const ENDPOINT = "http://127.0.0.1:8802";
const FRAMES = 40;
// THE VIEWPORT IS A BOUND, not decoration: a frame is at most this many lines of at most this many
// columns, so a blob large enough to carry every arm's tokens at once is refusable on size alone.
const COLUMNS = 132;
const ROWS = 40;

// THE FRAME IS PARSED, not searched: it is split into the lines the renderer laid out, and a line
// is the unit a row is bound to below.
//: THE WHOLE CONTROL VOCABULARY A FRAME MAY CONTAIN, which is LF and nothing else.
//:
//: MEASURED, NOT CHOSEN, 2026-09-09: a real frame from this renderer at this configuration holds
//: exactly one control character -- LF, 32 of them in 2,335 chars. No CR, no ESC, no tab, no
//: DEL. An ESC-only refusal was therefore half a grammar, and review walked through the other
//: half: a correct identity and token followed by an embedded CR and 24 X's on each row published
//: eight numeric rows, while those exact bytes interpreted at 132x40 leave six rows of X and
//: every identity overwritten. Stripping or ignoring a CR treats an OVERWRITE as decoration,
//: which is the same mistake the ESC round made about an erase.
//:
//: A FRAME THIS RENDERER DOES NOT DRAW IS REFUSED AND NAMED, rather than interpreted. If it
//: ever starts emitting one of these, the run says which -- and that is the failure anybody
//: would want from a probe whose figures are attributed to it.
//:
//: AND C1 IS A CONTROL RANGE TOO, which this missed. Review appended U+009B -- CSI, the single
//: character an 8-bit terminal reads as ESC-bracket -- followed by 2J, then U+009B and H, to a
//: roster of content-valid rows: eight numeric rows published, while the real headless parser
//: at 132x40 interprets those exact admitted bytes as an entirely blank viewport. That is the
//: ESC-erase hole again, arriving through the other encoding of the same sequence. The refusal
//: runs to U+009F, so it covers the whole block rather than the one code point demonstrated.
const FORBIDDEN_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
//: LF ALONE, because CR is refused above -- an `\r?` here would be unreachable and would read as though
//: a CRLF frame were expected.
const NEWLINE = /\n/;
//: THE SHAPE `freshToken` MINTS, so a marker can be recognised without knowing which one it is.
//: That is what makes "no marker but this frame's" checkable at all: a scan that only knew the
//: tokens this run ISSUED could never see one it did not.
const MARKER = /~[0-9a-f]{10}~/g;

/** A token no hard-coded carrier can hold, because it does not exist until this process runs. */
function freshToken() {
  return `~${randomBytes(5).toString("hex")}~`;
}

/** A process row shaped like the ones a real roster carries. `nonce` makes the text novel. */
function processRow(i, nonce) {
  return {
    id: `proc-${i}`,
    label: `agent-${i}`,
    // THE NONCE LEADS. Appended, it sat in the part of the title the 132-column clip removes,
    // so every changing frame was rejected for missing content the renderer had correctly
    // cropped. A per-frame witness has to survive the layout it is checked against.
    title: `${nonce}claude — working on something ${i}`,
    status: i % 4 === 0 ? "exited" : "running",
    pid: 10000 + i,
    startedAt: new Date(Date.now() - i * 60000).toISOString(),
  };
}

function health(processCount, nonce) {
  return {
    version: "0.6.3",
    terminals: true,
    processes: Array.from({ length: processCount }, (_, i) => processRow(i, nonce)),
    unknown: [],
    traffic: { requests: 1200, bytesOut: 8_400_000 },
  };
}

/** `nonceFor` decides whether each frame's text repeats or is new. */
function fakeFetch(processCount, nonceFor) {
  let frame = 0;
  //: WHAT THE LAST FRAME WAS ASKED TO DRAW. The changing arm's nonce differs per call, so a frame
  //: that carries it is THAT frame -- which no constant answer can satisfy. Review passed 328 calls
  //: by returning a fixed string containing six expected markers; a per-frame expectation is the
  //: only shape that closes it.
  //: OWNED BY THE RENDER, not by the request. `collectSnapshot` makes TWO requests per frame -- the
  //: environment's /health and each registered service's -- so a counter incremented here advanced
  //: twice per render and the "expected" nonce had never been drawn. A per-request counter is not a
  //: per-frame identity, which is the same noun confusion the transport probes were retracted for.
  const state = { nonce: nonceFor(0), issued: [] };
  state.issued.push(state.nonce);
  const fetchImpl = async () => {
    const body = health(processCount, state.nonce);
    const text = JSON.stringify(body);
    return { ok: true, status: 200, json: async () => body, text: async () => text, body: null };
  };
  fetchImpl.nextFrame = () => {
    state.nonce = nonceFor(frame);
    frame += 1;
    state.issued.push(state.nonce);
    return state.nonce;
  };
  fetchImpl.lastNonce = () => state.nonce;
  //: EVERY TOKEN THIS ARM HAS EVER HANDED OUT, which is what makes a SUPERSET refusable. Membership
  //: of the current token in the whole frame admits a fixed blob carrying all of them at once --
  //: review passed 328 calls with exactly that. A frame that also carries a RETIRED token is not
  //: this frame, whatever else it contains.
  fetchImpl.retiredNonces = () => state.issued.filter((n) => n && n !== state.nonce);
  return fetchImpl;
}

async function drawOnce(fetchImpl, count) {
  // ONE NONCE PER FRAME, chosen before the render and read back after it.
  //
  // AND OUTSIDE THE CLOCK, with the frame check below. Timing the whole of this function charged
  // the render for the instrument: minting a token (`randomBytes`), stripping escapes, splitting
  // lines and scanning a growing retired-token set all sat inside the measured span. Review held
  // the renderer constant and charged token generation two fake milliseconds; the published figures
  // moved to 0.03 static and 2.02 changing, which is an instrument boundary, not a render. So the
  // clock now brackets `startDashboard` and nothing else, and the delta this file reports is the
  // renderer's.
  if (fetchImpl.nextFrame) fetchImpl.nextFrame();
  let text = "";
  const renderStarted = process.hrtime.bigint();
  await startDashboard({
    endpoint: ENDPOINT, registryPath: REGISTRY_PATH,
    write: (t) => { text += t; }, clearScreen: false, once: true,
    columns: COLUMNS, rows: ROWS, fetchImpl,
    // SEALED. `collectSnapshot` reads the host's real credential store by default, so without this
    // the number below is decided partly by whatever this machine happens to hold -- an ambient
    // input, and one an injected fetch does not close. (External review of c74927a.)
    readCredentialStore: () => [],
  });
  const renderNs = Number(process.hrtime.bigint() - renderStarted);
  // A FRAME IS ONLY A SAMPLE IF IT DREW *THIS* FRAME, and review has now defeated three weaker
  // versions of that: one marker, six markers, and whole-output membership of a per-frame token --
  // the last by returning one fixed blob carrying every token the arm would ever issue. Each time
  // the hole was the same shape: a predicate a SUPERSET satisfies without rendering anything.
  //
  // So the frame is parsed and bound three ways, and a carrier has to beat all three at once:
  //
  //   BOUNDED   at most ROWS lines of at most COLUMNS columns, because that is the viewport the
  //             render was given. One blob holding every token cannot also fit a terminal.
  //   PER ROW   each visible label must share a LINE with this frame's token. Whole-output
  //             membership was the defect; a line is the unit the renderer actually lays out.
  //   EXCLUSIVE no line may carry a token this arm has retired. A superset carries them all, and
  //             that is precisely what makes it not this frame.
  //
  // WHAT THIS ESTABLISHES, and no more: that each accepted frame carries THIS frame's identity and
  // content, laid out inside the viewport it was given. That is a content-and-identity predicate.
  // It is NOT proof that the imported renderer ran -- an answer that reads the input and lays it
  // out itself satisfies every clause here, and one is kept in the mutation battery for that
  // reason. Whether the real renderer was invoked is a source-and-execution fact, established by
  // reading this file's imports, not inferred from anything below.
  //
  // MEASURED, NOT CLAIMED, 2026-09-08. The paragraph above was an argument until the carriers were
  // put back through it, `startDashboard` replaced by each in turn and restored byte-identical:
  //
  //   review's own constant -- the six labels plus the whole declared marker domain    REFUSED
  //   the same constant wrapped to the viewport, so the width bound cannot catch it    REFUSED
  //   the same rows with eight blank lines between them, which beat an older filter    REFUSED
  //   a dynamic non-renderer that READS the input and lays the six rows out itself     PUBLISHED
  //
  // AND FOUR MORE, 2026-09-09, because the round above was too kind to this check. Review answered
  // it by publishing eight rows twice through VISIBLY WRONG output, which the impossibility argument
  // above does not cover at all -- it is about output that is INDISTINGUISHABLE, not output that is
  // simply different:
  //
  //   ONE line carrying all six labels and the current token       REFUSED, shares a line
  //   six rows labelled agent-000, agent-100 ... with the token    REFUSED, agent-0 not found
  //   correct rows plus a RETIRED token split by an escape         REFUSED, foreign marker
  //   correct rows plus an EXTRA token this run never issued       REFUSED, foreign marker
  //   a correctly laid-out dynamic renderer                        PUBLISHED, as it must be
  //
  // AND TWO MORE, 2026-09-09, because the round above closed only the boundaries it was shown:
  //
  //   six rows labelled agent-0WRONG, agent-1WRONG ...             REFUSED, agent-0 not found
  //   six rows labelled _agent-0, _agent-1 ...                     REFUSED, agent-0 not found
  //   correct rows, then the viewport ERASED with ESC[2J ESC[H     REFUSED, an escape in the frame
  //   the correctly laid-out dynamic renderer, again               PUBLISHED
  //
  // The first two are the identity boundaries: the right side excluded only DIGITS and the left
  // omitted UNDERSCORE, so both leaked. The third is the erase, and it is the one that changes what
  // this file believes a frame is -- see the note beside `ESCAPES`.
  //
  // The last is the control against over-tightening: a check that had stopped admitting CORRECT
  // output would be a worse defect than the one being fixed, and invisible from a run that only
  // tries carriers.
  //
  // The survivor is the one this comment already names, and it is not a hole to be closed by a
  // longer or more random token: any predicate over the OUTPUT is satisfied by something that
  // produces the right output. Review's warning was the same -- "a dynamic fake can still append
  // the current marker without rendering" -- and the answer is that this file imports the real
  // `startDashboard` and times it, which is a fact about the source rather than about a frame.
  //
  // The STATIC arm is weaker still: its token is constant for the run by construction, so within
  // it a correct render IS the same text every frame and nothing here separates that from a cache
  // of one. It is unpredictable rather than fixed -- generated per run, so nothing written in
  // advance can contain it.
  // THE FRAME FORMAT IS PLAIN TEXT AND NEWLINES, AND AN ESCAPE IS REFUSED RATHER THAN STRIPPED.
  //
  // MEASURED, NOT ASSUMED, 2026-09-09: a real frame from this renderer at this configuration
  // contains ZERO CSI sequences and no other ESC -- 2,335 bytes of text and newlines at ten
  // processes. So an escape in a frame is not something the thing under measurement produces, and
  // the honest response is to refuse the frame and say so.
  //
  // STRIPPING THEM WAS TWO HOLES, both walked through by review. A retired token split internally by
  // `ESC[31m` was absent from the raw bytes and plainly visible once the escapes were removed; 164
  // frames carried one and published. And stripping treats ERASE and CURSOR MOVES as though they
  // were styling -- so six correct rows followed by `ESC[2J` and `ESC[H` published eight numeric
  // rows, while the same bytes interpreted at 132x40 leave a screen with no non-blank line on it.
  // A membership test over stripped text is not a statement about the final viewport.
  //
  // REFUSING RATHER THAN INTERPRETING is deliberate. Interpreting would need an emulator -- an
  // optional dependency in this repo -- to answer a question this renderer never poses. If it ever
  // starts emitting escapes, this refuses and names them, which is the failure everyone wants.
  const missing = [];
  const controls = text.match(FORBIDDEN_CONTROL) || [];
  if (controls.length) {
    const first = controls[0].codePointAt(0).toString(16).padStart(4, "0");
    missing.push(`${controls.length} control character(s) outside this renderer's vocabulary, which `
      + `is LF and nothing else -- the first is U+${first}. Refused rather than stripped or `
      + "interpreted, because an erase and an overwrite are not decoration");
  }
  const lines = text.split(NEWLINE);
  // PHYSICAL LINES, not painted ones. Filtering the blanks out first was a hole review walked
  // straight through: forty empty lines inserted between the rows changed no label and no token,
  // took the frame to 46 physical lines, and still passed -- a frame three viewports tall that the
  // height bound never saw. Only a single trailing terminator is excused, because a frame ending in
  // a newline yields one empty element that was never a row.
  const terminated = lines.length > 0 && lines[lines.length - 1] === "";
  const physical = lines.length - (terminated ? 1 : 0);
  if (physical > ROWS) missing.push(`${physical} physical lines exceeds the ${ROWS}-row viewport`);
  const overWide = lines.find((line) => line.length > COLUMNS);
  if (overWide !== undefined) missing.push(`a line of ${overWide.length} columns exceeds ${COLUMNS}`);

  const nonce = fetchImpl.lastNonce ? fetchImpl.lastNonce() : "";
  // BOUNDED BY THE VIEWPORT, not by the roster size: 40 rows cannot show 80 agents, so requiring
  // every label would fail for a reason that is not a defect. The first few are always on screen.
  const visible = Math.min(count, 6);
  // EXACT IDENTITIES ON DISTINCT LINES, and `includes` was neither. Review published eight rows
  // twice through this check: once with ONE line carrying all six labels and the current token, and
  // once with six rows labelled `agent-000`, `agent-100` ... which every `includes("agent-0")`
  // accepts. A substring match is not an identity, and six identities found on one line are not six
  // rows -- a laid-out frame puts each on its own.
  const claimedBy = new Map();
  for (let i = 0; i < visible; i += 1) {
    const label = `agent-${i}`;
    // DELIMITED ON BOTH SIDES, and the first version leaked on each of them differently. The
    // right boundary excluded only DIGITS, so `agent-0WRONG` matched `agent-0`; the left excluded letters,
    // digits and dashes but not UNDERSCORE, so `_agent-0` matched too. Review published eight rows
    // through each. \\w covers the underscore and the whole word class, and a dash is added because these
    // labels contain one: `agent-0` must not match inside `agent-000`, `agent-0WRONG` or `_agent-0`.
    const identity = new RegExp(`(?<![\\w-])${label}(?![\\w-])`);
    const at = lines.reduce((found, line, index) => (identity.test(line) ? [...found, index] : found), []);
    if (!at.length) { missing.push(label); continue; }
    if (at.length > 1) { missing.push(`${label} is on ${at.length} lines, so the frame is not a roster`); continue; }
    if (claimedBy.has(at[0])) {
      missing.push(`${label} shares line ${at[0]} with ${claimedBy.get(at[0])}, so they are not rows`);
      continue;
    }
    claimedBy.set(at[0], label);
    if (nonce && !lines[at[0]].includes(nonce)) {
      missing.push(`${label} is on a line that does not carry ${nonce}`);
    }
  }
  // NO MARKER BUT THIS FRAME'S, which is what line 225 has always claimed and what the retired-only
  // scan did not check. Review published with an EXTRA `~fffffffffe~` that this run never issued, so
  // it was in no retired set and nothing looked for it. Every marker-shaped run in the
  // frame must be the current token; a retired one is named as retired because that is the more
  // useful message, but an unissued one is refused just the same.
  if (nonce) {
    const retired = new Set(fetchImpl.retiredNonces ? fetchImpl.retiredNonces() : []);
    const foreign = [...new Set((text.match(MARKER) || []).filter((mark) => mark !== nonce))];
    if (foreign.length) {
      const named = foreign.slice(0, 3)
        .map((mark) => (retired.has(mark) ? `${mark} (retired)` : `${mark} (never issued)`));
      missing.push(`${foreign.length} marker(s) on screen that are not this frame's: ${named.join(", ")}`);
    }
  }
  const drewRoster = count === 0 || missing.length === 0;
  return { bytes: text.length, drewRoster, missing, renderNs };
}

async function timeFrames(processCount, nonceFor) {
  const fetchImpl = fakeFetch(processCount, nonceFor);
  // One warm frame first: the first call pays module init and JIT, which is not what a steady
  // redraw costs.
  let warm = await drawOnce(fetchImpl, processCount);

  let bytes = warm.bytes;
  let rejected = warm.drewRoster ? 0 : 1;
  // WHICH CLAUSE FIRED, not just how many frames failed. "REJECTED 41 frame(s) that drew no roster"
  // is the same sentence whether the width bound caught it, an identity was missing or a foreign
  // marker was on screen -- so a mutation that was killed could not be told from one killed for a
  // reason nobody intended, which is a mistake this project has made and written down. Distinct
  // reasons only: forty-one frames failing the same way is one fact.
  const reasons = new Set(warm.drewRoster ? [] : warm.missing);
  // THE SUM OF THE RENDERS, not the wall time of the loop. The loop also mints tokens and parses
  // frames, and neither is a cost the console pays.
  let renderNs = 0;
  for (let i = 0; i < FRAMES; i += 1) {
    const frame = await drawOnce(fetchImpl, processCount);
    bytes += frame.bytes;
    renderNs += frame.renderNs;
    if (!frame.drewRoster) {
      rejected += 1;
      for (const reason of frame.missing) reasons.add(reason);
    }
  }
  const ms = renderNs / 1e6 / FRAMES;
  return { ms, bytesPerFrame: Math.round(bytes / (FRAMES + 1)), rejected, reasons: [...reasons] };
}

// THE TOKENS ARE GENERATED, NOT ENUMERATED, and that is the difference between the two arms.
// ` #0` through ` #40` was a KNOWN SET: a carrier holding all forty-one of them satisfied a
// membership test on every call without rendering. A token minted at run time cannot be held in
// advance, and the exclusivity check above refuses a frame carrying more than the current one.
const STATIC_TOKEN = freshToken();
const ARMS = [
  ["STATIC   (every frame the same text)", () => STATIC_TOKEN],
  ["CHANGING (every row novel every frame)", () => freshToken()],
];

// WHAT WAS ACTUALLY INVOKED, bound to the source it claims to come from. Review's standing
// objection to these figures is that an import line is one link: it says where the NAME came
// from and nothing about the OBJECT that ran. The receipt hashes the module's bytes AND the
// function object's own source, and checks that the second appears verbatim inside the first.
//
// A SEPARATE BLOCK FROM THE FRAME CHECK, deliberately. That one answers "is this frame this
// frame"; this one answers "is this function that function". Neither substitutes for the other,
// and folding them together is what let the first stand in for provenance it cannot establish.
const RECEIPT = await receiptFor(startDashboard, new URL("../lib/dashboard.mjs", import.meta.url).href);

let failures = 0;
const LF = String.fromCharCode(10);
const rows = [];
const header = (`one frame at 132x40, averaged over ${FRAMES} (plus one warm-up, discarded)`);
for (const [label, nonceFor] of ARMS) {
  rows.push(`${LF}${label}`);
  rows.push("  processes    ms/frame    bytes written    frames/s one core could draw");
  for (const count of [10, 20, 40, 80]) {
    const { ms, bytesPerFrame, rejected, reasons } = await timeFrames(count, nonceFor);
    // HELD, NOT PRINTED. A refusal after the rows cannot retract them, and review demonstrated
    // exactly that: 328 empty calls, eight numeric rows on stdout, "nothing is published", exit 0.
    rows.push(`  ${String(count).padStart(9)}  ${ms.toFixed(2).padStart(9)}  `
      + `${String(bytesPerFrame).padStart(15)}  ${Math.round(1000 / ms).toString().padStart(28)}`);
    if (rejected) {
      failures += rejected;
      process.stderr.write(`  ${label} / ${count} processes: REJECTED ${rejected} frame(s) that `
        + `drew no roster${LF}`);
      for (const reason of reasons) process.stderr.write(`      because: ${reason}${LF}`);
    }
  }
}

// NOTHING REACHES stdout UNLESS EVERY FRAME DREW ITS ROSTER. A refusal printed after the rows
// cannot retract them: review ran the exact body with 328 empty calls and got eight numeric rows,
// "nothing is published", and exit 0 -- so an automated caller saw a successful run with figures in
// it. That was this script carrying over its sibling's DISCLAIMER instead of its GATING.
if (failures === 0 && RECEIPT.declaredHere) {
  console.log(header);
  for (const row of rows) console.log(row);
  console.log(`${LF}Every frame carried this frame's identity and content inside its viewport, and`
    + ` the figures are the bracketed cost of startDashboard alone -- token generation and frame`
    + ` checking are outside the clock.`);
  console.log("");
  for (const line of receiptLines(RECEIPT)) console.log(line);
  console.log("  observed    a published frame carries THIS frame's token on every visible row, and");
  console.log("              the only source of that token is the injected fetch -- so publication");
  console.log("              already implies the collaborators were called inside the bracket. A separate");
  console.log("              counter for that was removed: it guarded a condition the frame check admits");
  console.log("              nothing through, and it put an increment inside the clock.");
  console.log("  NOT PROVEN  that this function was the one called. Nothing in-process can say so:");
  console.log("              a caller could hold this receipt and invoke something else. What is");
  console.log("              established is that the imported object IS the module's own body.");
} else {
  if (!RECEIPT.declaredHere) {
    process.stderr.write(`${LF}NOTHING IS PUBLISHED: the function this file imported as `
      + `${RECEIPT.name} does not appear in ${RECEIPT.module}, so the figures would describe `
      + `something other than that module's renderer${LF}`);
  }
  process.stderr.write(
    `${LF}NOTHING IS PUBLISHED: ${failures} frame(s) timed without drawing the roster, so those`
    + ` samples measured something other than a render. Per-arm rejections are above.${LF}`,
  );
  process.exitCode = 1;
}
