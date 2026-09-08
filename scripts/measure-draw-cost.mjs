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

import { fileURLToPath } from "node:url";

import { startDashboard } from "../lib/dashboard.mjs";

// `fileURLToPath`, not `.pathname`: on Windows the latter yields a leading-slash "/C:/..."
// that `readFile` cannot open, and the registry read fails into an empty service list --
// which silently removed a probe from the count this script exists to make.
const REGISTRY_PATH = fileURLToPath(new URL("./measure-draw-cost.registry.json", import.meta.url));
const ENDPOINT = "http://127.0.0.1:8802";
const FRAMES = 40;

/** A process row shaped like the ones a real roster carries. `nonce` makes the text novel. */
function processRow(i, nonce) {
  return {
    id: `proc-${i}`,
    label: `agent-${i}`,
    title: `claude — working on something ${i}${nonce}`,
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
  return async () => {
    const body = health(processCount, nonceFor(frame));
    frame += 1;
    const text = JSON.stringify(body);
    return { ok: true, status: 200, json: async () => body, text: async () => text, body: null };
  };
}

async function drawOnce(fetchImpl, count) {
  let text = "";
  await startDashboard({
    endpoint: ENDPOINT, registryPath: REGISTRY_PATH,
    write: (t) => { text += t; }, clearScreen: false, once: true,
    columns: 132, rows: 40, fetchImpl,
    // SEALED. `collectSnapshot` reads the host's real credential store by default, so without this
    // the number below is decided partly by whatever this machine happens to hold -- an ambient
    // input, and one an injected fetch does not close. (External review of c74927a.)
    readCredentialStore: () => [],
  });
  // A FRAME IS ONLY A SAMPLE IF IT DREW THE ROSTER. This counted BYTES and nothing else, so a frame
  // that rendered an error banner, or a header and no rows, would time fast and read as an
  // improvement. Review found exactly this class twice in this repo's transport probes; applying it
  // here before it has to be found a third time.
  const drewRoster = count === 0 || text.includes("agent-0");
  return { bytes: text.length, drewRoster };
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

const ARMS = [
  ["STATIC   (every frame the same text)", () => ""],
  ["CHANGING (every row novel every frame)", (frame) => ` #${frame}`],
];

let failures = 0;
console.log(`one frame at 132x40, averaged over ${FRAMES} (plus one warm-up, discarded)`);
for (const [label, nonceFor] of ARMS) {
  console.log(`\n${label}`);
  console.log("  processes    ms/frame    bytes written    frames/s one core could draw");
  for (const count of [10, 20, 40, 80]) {
    const { ms, bytesPerFrame, rejected } = await timeFrames(count, nonceFor);
    console.log(
      `  ${String(count).padStart(9)}  ${ms.toFixed(2).padStart(9)}  ${String(bytesPerFrame).padStart(15)}`
      + `  ${Math.round(1000 / ms).toString().padStart(28)}`
      + (rejected ? `   REJECTED ${rejected} frame(s) that drew no roster` : ""),
    );
    if (rejected) failures += rejected;
  }
}

console.log(
  failures === 0
    ? `\nEvery frame drew the roster it was given, so the figures above are renders.`
    : `\nNOTHING ABOVE IS PUBLISHED: ${failures} frame(s) timed without drawing the roster, so those`
      + ` samples measured something other than a render.`,
);
