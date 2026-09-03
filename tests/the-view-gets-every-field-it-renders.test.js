// The dashboard renders a process row from fields `/health` has to supply, and nothing joined them.
//
// A1, THE OPERATOR'S OLDEST UNMET ASK, and it is now MET: *"i wanted to have some tui for aify-env.
// so i can see all managed agents that are running"* (2026-08-24), then *"i still do not see anything
// under agent"* (08-25). The recorded reason it never worked was that managed agents were spawned by
// the aify-comms BRIDGE, so they were not in this environment's process record and never would be.
//
// That stopped being true on 2026-09-03, when the host tier took over spawning. Rendered from the
// operator's own live `/health` the same day:
//
//     PROCESSES 4 owned
//       ID       PID     AGENT      SERVICE     IO   UP     TITLE
//       cf63-p1  215208  sc-lead    aify-comms  pty  2h40m  Claude Code
//       cf63-p2  252812  sc-tester  aify-comms  pty  2h39m  Claude Code
//       cf63-p3  195104  sc-critic  aify-comms  pty  2h39m  Claude Code
//       cf63-p6  161124  sc-coder   aify-comms  pty  1h5m   Claude Code
//
// SO IT WORKS BY CONSEQUENCE, NOT BY CONSTRUCTION, which is exactly the state that needs pinning. No
// code was written for it. It came right because something else changed, and a thing that came right
// by accident can go wrong the same way.
//
// TWO HALVES, EACH ALREADY TESTED, AND THE JOIN BETWEEN THEM TESTED BY NOTHING. `tui.test.js` proves
// the view renders an agent column -- from a snapshot the test itself supplies. `health.test.js` does
// not mention `processes` at all. So a payload that stopped carrying `label` would blank the AGENT
// column for every agent, and both files would stay green. That is the same shape as the four defects
// found the same night: two components each reporting healthy, and the join between them measured by
// nobody.
//
// THE FIELD LIST IS DERIVED FROM THE RENDERER, never typed here. A hand-kept copy agrees until
// somebody adds a column, and then the payload silently lacks it -- which has already happened once
// in this exact place: `uptimeMs` was read by the view and supplied by nobody, so every row read
// "up -" until `lib/protocol.mjs` started deriving it. Reading the accessors out of the view means a
// new column fails on the day it lands rather than rendering a dash forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { handleRequest } from "../lib/protocol.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `proc.<field>` the process table reads, taken from the view's own source. */
function fieldsTheViewRenders() {
  const view = readFileSync(join(ROOT, "lib", "tui.mjs"), "utf8");
  // The table's row builder is the only place `proc.` appears; a stray match elsewhere would only
  // ever make this test STRICTER, never weaker.
  const found = new Set();
  for (const match of view.matchAll(/\bproc\.([A-Za-z_][A-Za-z0-9_]*)/g)) found.add(match[1]);
  return [...found].sort();
}

/** One managed worker, as the runner reports it. */
const ENTRY = {
  id: "inst-p1",
  pid: 4242,
  service: "aify-comms",
  terminal: true,
  label: "sc-lead",
  title: "Claude Code",
  startedAtMs: Date.now() - 9_000_000,
};

/** THE REAL ROUTE, not a re-implementation of its body. What the dashboard fetches is
 *  `GET /health`, so that is what this asks -- a helper that built the payload another way could
 *  agree with the view while the route disagreed with both. */
async function body(entries = [ENTRY]) {
  const response = await handleRequest({ method: "GET", path: "/health" }, {
    version: "0.6.0",
    build: "test",
    runner: {
      list: () => entries,
      instance: () => "inst",
      history: () => ({ startedTotal: 1, lastExitAtMs: null }),
    },
    pid: 111,
  });
  assert.equal(response.status, 200, `GET /health answered ${response.status}`);
  return response.body;
}

test("the view reads at least the columns the operator asked for", () => {
  // POSITIVE CONTROL for the derivation. If the scan returned nothing -- a renamed variable, a
  // rewritten table -- every assertion below would pass over an empty set and prove nothing.
  const fields = fieldsTheViewRenders();
  assert.ok(fields.length >= 5, `the view scan found only ${JSON.stringify(fields)}`);
  for (const required of ["label", "pid", "service"]) {
    assert.ok(fields.includes(required), `the view no longer renders ${required}: ${fields}`);
  }
});

test("EVERY FIELD THE VIEW RENDERS IS SUPPLIED BY /health", async () => {
  const [proc] = (await body()).processes;
  const missing = fieldsTheViewRenders().filter((field) => !(field in proc));
  assert.deepEqual(missing, [], `the view renders fields /health does not carry: ${missing}`);
});

test("A MANAGED AGENT IS NAMED, which is the whole ask", async () => {
  const [proc] = (await body()).processes;
  assert.equal(proc.label, "sc-lead");
  assert.equal(proc.service, "aify-comms");
  assert.equal(proc.terminal, true, "a PTY worker must be reported as one, or IO reads 'pipe'");
});

test("uptime is DERIVED here, because the view is pure and holds no clock", async () => {
  // The defect this is the memory of: the view read `uptimeMs`, nobody supplied it, and every row
  // read "up -". Uptime cannot be computed in the renderer without giving it a clock, which would
  // make the same snapshot render differently in a test than on a screen.
  const [proc] = (await body()).processes;
  assert.ok(Number.isFinite(proc.uptimeMs), "uptimeMs is not supplied, so every row renders 'up -'");
  assert.ok(proc.uptimeMs >= 9_000_000 - 5_000, `implausible uptime ${proc.uptimeMs}`);
});

test("a process with no start time reports NULL uptime rather than a number", async () => {
  // Absence stays absence. A zero here renders "0m", which an operator reads as "just started" --
  // an invented fact is worse than a dash.
  const [proc] = (await body([{ ...ENTRY, startedAtMs: undefined }])).processes;
  assert.equal(proc.uptimeMs, null);
});

test("nothing about what the agent is DOING crosses this boundary", async () => {
  // docs/AIFY_ENV_BOUNDARY.md, and the operator's ruling: aify-env may show what it OWNS, annotated
  // by what a service reports. A status would be this environment making a judgement about another
  // service's domain, and `tui.test.js` already refuses to render one if it arrives -- so this is
  // the other end of that guard: it must not be SENT either.
  const [proc] = (await body([{ ...ENTRY, agentStatus: "working", unread: 3 }])).processes;
  // The spread carries them, which is the honest report of what the runner was told; what matters is
  // that the view never reads them, and that no field here is invented by this tier.
  const fields = fieldsTheViewRenders();
  assert.ok(!fields.includes("agentStatus"), "the view renders an agent status it must not judge");
  assert.ok(!fields.includes("unread"), "the view renders a service's domain data");
  assert.equal(proc.label, "sc-lead");
});

test("an empty list is empty, not absent", async () => {
  // The panel must be able to say "nothing is running here", which is a different fact from "this
  // environment does not report processes" -- and the operator read the ambiguous version as broken.
  assert.deepEqual((await body([])).processes, []);
});
