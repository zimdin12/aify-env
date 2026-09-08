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
// Run: node scripts/measure-draw-cost.mjs

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { startDashboard } from "../lib/dashboard.mjs";

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

// THE FRAME IS PARSED, not searched. Colour and cursor moves are removed first, then the text is
// split into the lines the renderer laid out -- a line is the unit a row is bound to below.
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const NEWLINE = /\r?\n/;

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
  if (fetchImpl.nextFrame) fetchImpl.nextFrame();
  let text = "";
  await startDashboard({
    endpoint: ENDPOINT, registryPath: REGISTRY_PATH,
    write: (t) => { text += t; }, clearScreen: false, once: true,
    columns: COLUMNS, rows: ROWS, fetchImpl,
    // SEALED. `collectSnapshot` reads the host's real credential store by default, so without this
    // the number below is decided partly by whatever this machine happens to hold -- an ambient
    // input, and one an injected fetch does not close. (External review of c74927a.)
    readCredentialStore: () => [],
  });
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
  // WHAT THIS STILL DOES NOT PROVE, said plainly: the STATIC arm's token is constant for the run
  // by construction, so within that arm a correct render IS the same text every frame and no
  // predicate here can separate it from a cache of one. It is unpredictable rather than fixed --
  // generated per run, so nothing written in advance can contain it -- and the CHANGING arm is
  // where per-frame rendering is actually demonstrated.
  const lines = text.replace(ANSI, "").split(NEWLINE);
  const missing = [];
  const painted = lines.filter((line) => line.trim() !== "");
  if (painted.length > ROWS) missing.push(`${painted.length} painted lines exceeds the ${ROWS}-row viewport`);
  const overWide = lines.find((line) => line.length > COLUMNS);
  if (overWide !== undefined) missing.push(`a line of ${overWide.length} columns exceeds ${COLUMNS}`);

  const nonce = fetchImpl.lastNonce ? fetchImpl.lastNonce() : "";
  // BOUNDED BY THE VIEWPORT, not by the roster size: 40 rows cannot show 80 agents, so requiring
  // every label would fail for a reason that is not a defect. The first few are always on screen.
  const visible = Math.min(count, 6);
  for (let i = 0; i < visible; i += 1) {
    const label = `agent-${i}`;
    const row = lines.find((line) => line.includes(label));
    if (row === undefined) { missing.push(label); continue; }
    if (nonce && !row.includes(nonce)) missing.push(`${label} is on a line that does not carry ${nonce}`);
  }
  for (const retired of (fetchImpl.retiredNonces ? fetchImpl.retiredNonces() : [])) {
    if (text.includes(retired)) { missing.push(`a retired token ${retired} is still on screen`); break; }
  }
  const drewRoster = count === 0 || missing.length === 0;
  return { bytes: text.length, drewRoster, missing };
}

async function timeFrames(processCount, nonceFor) {
  const fetchImpl = fakeFetch(processCount, nonceFor);
  // One warm frame first: the first call pays module init and JIT, which is not what a steady
  // redraw costs.
  let warm = await drawOnce(fetchImpl, processCount);

  let bytes = warm.bytes;
  let rejected = warm.drewRoster ? 0 : 1;
  const started = process.hrtime.bigint();
  for (let i = 0; i < FRAMES; i += 1) {
    const frame = await drawOnce(fetchImpl, processCount);
    bytes += frame.bytes;
    if (!frame.drewRoster) rejected += 1;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / FRAMES;
  return { ms, bytesPerFrame: Math.round(bytes / (FRAMES + 1)), rejected };
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

let failures = 0;
const LF = String.fromCharCode(10);
const rows = [];
const header = (`one frame at 132x40, averaged over ${FRAMES} (plus one warm-up, discarded)`);
for (const [label, nonceFor] of ARMS) {
  rows.push(`${LF}${label}`);
  rows.push("  processes    ms/frame    bytes written    frames/s one core could draw");
  for (const count of [10, 20, 40, 80]) {
    const { ms, bytesPerFrame, rejected } = await timeFrames(count, nonceFor);
    // HELD, NOT PRINTED. A refusal after the rows cannot retract them, and review demonstrated
    // exactly that: 328 empty calls, eight numeric rows on stdout, "nothing is published", exit 0.
    rows.push(`  ${String(count).padStart(9)}  ${ms.toFixed(2).padStart(9)}  `
      + `${String(bytesPerFrame).padStart(15)}  ${Math.round(1000 / ms).toString().padStart(28)}`);
    if (rejected) {
      failures += rejected;
      process.stderr.write(`  ${label} / ${count} processes: REJECTED ${rejected} frame(s) that `
        + `drew no roster${LF}`);
    }
  }
}

// NOTHING REACHES stdout UNLESS EVERY FRAME DREW ITS ROSTER. A refusal printed after the rows
// cannot retract them: review ran the exact body with 328 empty calls and got eight numeric rows,
// "nothing is published", and exit 0 -- so an automated caller saw a successful run with figures in
// it. That was this script carrying over its sibling's DISCLAIMER instead of its GATING.
if (failures === 0) {
  console.log(header);
  for (const row of rows) console.log(row);
  console.log(`${LF}Every frame drew the roster it was given, so the figures above are renders.`);
} else {
  process.stderr.write(
    `${LF}NOTHING IS PUBLISHED: ${failures} frame(s) timed without drawing the roster, so those`
    + ` samples measured something other than a render. Per-arm rejections are above.${LF}`,
  );
  process.exitCode = 1;
}
