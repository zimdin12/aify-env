// A3: the TUI shows what `aify-env doctor` shows.
//
// THE OPERATOR ASKED ON 2026-08-24 and it was still unmet on 09-02. The doctor existed and worked;
// the view could not call it, because there was nothing to call — the collection and the display
// both lived inside `bin/aify-env-doctor.mjs`, so the only consumer it could ever have was a
// terminal. `lib/environment-report.mjs` is the collector, and the script keeps the display: the
// seam that file's own header has always named ("A COLLECTOR AND A DISPLAY").
//
// THE EXTRACTION WAS PROVEN INERT BY OUTPUT, not by reading. `aify-env doctor` and
// `aify-env doctor --json` were captured against the operator's live host before the move and
// compared after: byte-identical text, deep-equal JSON.
//
// THE PANEL COSTS NO EXTRA REQUESTS. The collector asks for exactly the URLs the dashboard already
// asks for, so it is handed a `knock` that REPLAYS them. Asking twice would double the traffic of a
// view that refreshes on a timer, and could show a panel disagreeing with the rows above it because
// the two reads happened at different moments.
//
// AND THAT REPLAY IMMEDIATELY FOUND A REAL DEFECT, which is why `test_the_status_travels` exists.
// The dashboard's `knock` returned `{ok, body}` and dropped the HTTP status. `looksLikeEnvironment`
// requires a 2xx, so a status of `undefined` reads as 0: the first render of this panel reported the
// environment FAILED and its processes UNANSWERED, on a host whose next panel listed the four
// processes that environment owned. A reader that holds a fact and hands on less than it holds is a
// lossy reader, and the two halves of one screen contradicted each other.

import { test } from "node:test";
import assert from "node:assert/strict";

import { collectSnapshot, knock } from "../lib/dashboard.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const ENDPOINT = "http://127.0.0.1:9";

/** A healthy environment's `/health`, in the shape `looksLikeEnvironment` insists on. */
const HEALTHY = {
  status: "healthy",
  version: "0.6.0",
  build: "abc",
  processes: [{ id: "p1", pid: 7, service: "aify-comms", terminal: true, label: "sc-lead", startedAtMs: Date.now() }],
  unknown: [],
  terminals: { available: true, reason: "" },
  // A claiming plugin, because a host with none legitimately FAILS the claiming check -- spawns
  // would go nowhere. The fixture describes a healthy host, so it has one.
  plugins: [{ service: "aify-comms", claiming: true }],
  history: { startedTotal: 1, lastExitAtMs: null },
};

function fetchReturning(body, { status = 200 } = {}) {
  return async () => ({ status, json: async () => body });
}

async function snapshot({ fetchImpl = fetchReturning(HEALTHY), registry = "" } = {}) {
  return collectSnapshot({
    endpoint: ENDPOINT,
    registryPath: "unused",
    fetchImpl,
    readFile: () => registry,
    nowMs: () => 1_700_000_000_000,
    // SEALED. Left to the default this reads the operator's real `~/.aify`, and every assertion here
    // would be decided by whatever that host happens to hold.
    readCredentialStore: async () => ({ names: [] }),
  });
}

function render(snap) {
  const out = renderDashboard(snap, { columns: 140, colour: false });
  return Array.isArray(out) ? out.join("\n") : String(out);
}

test("THE STATUS TRAVELS — a lossy knock reports a healthy environment as failed", async () => {
  // THE DEFECT THIS FOUND. Without `status`, `looksLikeEnvironment` sees 0, the environment check
  // fails, and processes/claiming go unanswered — on a host that is answering perfectly.
  const answer = await knock(`${ENDPOINT}/health`, { fetchImpl: fetchReturning(HEALTHY) });
  assert.equal(answer.ok, true);
  assert.equal(answer.status, 200, "the knock dropped the HTTP status it had in hand");
});

test("the view carries the doctor's verdicts", async () => {
  const snap = await snapshot();
  const ids = snap.checks.map((c) => c.id);
  for (const required of ["terminal", "registry", "environment", "processes"]) {
    assert.ok(ids.includes(required), `no ${required} check reached the view: ${ids}`);
  }
});

test("A HEALTHY HOST READS HEALTHY, not failed", async () => {
  // The end-to-end form of the status defect: every check about the environment must pass when the
  // environment is answering, or the panel contradicts the process table below it.
  const snap = await snapshot();
  const byId = Object.fromEntries(snap.checks.map((c) => [c.id, c.state]));
  assert.equal(byId.environment, "passed", "a live environment was reported as failed");
  assert.equal(byId.processes, "passed", "a live environment's processes were reported unanswered");
});

test("the panel renders a passing count, and says so plainly when all pass", async () => {
  // TWO PROPERTIES, DELIBERATELY SPLIT. The count is asserted against REAL collected checks, because
  // that is the number an operator reads. The all-pass wording is asserted against supplied checks,
  // because making the fixture pass every check would mean fabricating the exact body shapes
  // `advertise-cred` and `claiming` want -- and a fixture invented to satisfy a check is a guess
  // dressed as evidence. The end-to-end health of what this fixture DOES describe is pinned by
  // "A HEALTHY HOST READS HEALTHY" above.
  const collected = await snapshot();
  const text = render(collected);
  assert.match(text, /HEALTH \d+\/\d+ passing/, "no health panel was rendered");
  const passing = collected.checks.filter((c) => c.state === "passed").length;
  assert.match(text, new RegExp(`HEALTH ${passing}/${collected.checks.length} passing`),
    "the count does not match the checks that were collected");

  const allPass = await snapshot();
  allPass.checks = [{ id: "terminal", state: "passed", detail: "fine" }];
  assert.match(render(allPass), /all checks pass/);
});

test("ONLY THE FAILURES ARE LISTED, because the panel is for what needs attention", async () => {
  // A full pass list is eight rows of noise on a screen whose job is to show what is wrong. The
  // count says the rest are fine and the doctor is there for the reader who wants every row.
  const snap = await snapshot();
  snap.checks = [
    { id: "terminal", state: "passed", detail: "fine" },
    { id: "registry", state: "failed", detail: "cannot read it" },
    { id: "claiming", state: "unanswered", detail: "nobody said" },
  ];
  const text = render(snap);
  assert.match(text, /HEALTH 1\/3 passing/);
  assert.match(text, /registry/);
  assert.match(text, /claiming/);
  assert.doesNotMatch(text, /\bfine\b/, "a passing check's detail was rendered as if it needed attention");
});

test("NOT COLLECTED is not the same as HEALTHY", async () => {
  // Rendering nothing would read as the second. This repo has produced that false green twice, in
  // `env-bridge` and `bridge-current`, and both times the fix was to say "no evidence" out loud.
  const snap = await snapshot();
  snap.checks = [];
  const text = render(snap);
  assert.match(text, /not collected/);
  assert.doesNotMatch(text, /all checks pass/);
});

test("a failing check is marked differently from an unanswered one", async () => {
  // They need different remedies. "Could not tell" is not "is broken", and a panel that renders them
  // the same is lying about one of them.
  const snap = await snapshot();
  snap.checks = [
    { id: "registry", state: "failed", detail: "cannot read it" },
    { id: "claiming", state: "unanswered", detail: "nobody said" },
  ];
  const text = render(snap);
  assert.match(text, /FAIL\s+registry/);
  assert.match(text, /\?\?\s+claiming/);
});

test("the view does not re-judge a verdict", async () => {
  // The state and the words are the doctor's. Two tools that can disagree about one host is the
  // failure this repo spent a night on in three other forms.
  const snap = await snapshot();
  snap.checks = [{ id: "invented", state: "failed", detail: "a detail only the doctor could write" }];
  const text = render(snap);
  assert.match(text, /a detail only the doctor could write/);
});

test("collecting the checks costs NO extra requests", async () => {
  // The panel is refreshed on a timer. Asking each endpoint twice would double this view's traffic
  // and let the panel disagree with the rows above it, because the two reads happened at different
  // moments.
  const urls = [];
  const counting = async (url) => {
    urls.push(String(url));
    return { status: 200, json: async () => HEALTHY };
  };
  await snapshot({ fetchImpl: counting });
  const health = urls.filter((u) => u === `${ENDPOINT}/health`);
  assert.equal(health.length, 1, `the environment was asked ${health.length} times: ${urls}`);
});

test("a check that throws leaves a view rather than no view", async () => {
  // A dashboard that cannot draw because a health check failed is worse than one with no health
  // panel. The processes table is the thing the operator opened this for.
  const snap = await snapshot({
    fetchImpl: async () => { throw new Error("no network at all"); },
  });
  const text = render(snap);
  assert.match(text, /HEALTH/, "the panel vanished instead of reporting what it could");
  assert.match(text, /PROCESSES/, "a failed health collection took the rest of the view with it");
});

// ── the collector on its own ────────────────────────────────────────────────────────────────────
//
// Reached through `collectSnapshot` above, which is how the view uses it. Driven DIRECTLY here
// because the two callers must not be able to drift: the doctor script and the dashboard both call
// this, and a change that suited one silently changes the other's report.

test("COLLECTION IS PURE OF THE HOST — every input is injected", async () => {
  // Nothing here may read an environment variable, open a file, or hold a clock. The proof is that
  // it produces a full report from fakes alone: if any real reader were still wired in, this would
  // observe the machine it runs on and the assertions below would be decided by that host.
  const checks = await collectEnvironmentChecks({
    endpoint: "http://example.invalid",
    knock: async () => ({ ok: false, error: "nothing there" }),
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ available: true, reason: "" }),
    readCredentialStore: async () => ({ names: [] }),
  });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c.state]));
  assert.equal(byId.environment, "failed", "an endpoint answering nothing is a FACT, not a mystery");
  assert.equal(byId.processes, "unanswered", "no environment answered, so what it owns is unknown");
});

test("an absent environment is FAILED and its contents UNANSWERED, never zero", async () => {
  // The distinction is load-bearing and the reason both states exist: "0 processes owned" is what a
  // healthy idle host looks like, so reporting it when nothing answered turns an absent environment
  // into a calm one.
  const checks = await collectEnvironmentChecks({
    endpoint: "http://example.invalid",
    knock: async () => ({ ok: false, error: "connection refused" }),
    readRegistry: () => ({ text: "" }),
    terminalSupport: () => ({ available: false, reason: "no pty" }),
    readCredentialStore: async () => ({ names: [] }),
  });
  const processes = checks.find((c) => c.id === "processes");
  assert.equal(processes.state, "unanswered");
  assert.doesNotMatch(String(processes.detail), /0 process/);
});

test("the checks arrive in READING order", async () => {
  // A set would lose it, and the order is the report: terminal and registry are this host's own
  // answers, the environment comes next, and what it owns can only follow it.
  const checks = await collectEnvironmentChecks({
    endpoint: "http://example.invalid",
    knock: async () => ({ ok: false, error: "x" }),
    readRegistry: () => ({ text: "" }),
    terminalSupport: () => ({ available: true, reason: "" }),
    readCredentialStore: async () => ({ names: [] }),
  });
  const ids = checks.map((c) => c.id);
  assert.ok(ids.indexOf("environment") < ids.indexOf("processes"),
    `what an environment owns was reported before whether it exists: ${ids}`);
  assert.ok(ids.indexOf("terminal") < ids.indexOf("environment"), `unexpected order: ${ids}`);
});

// ── the SERVICES row does not repeat its own endpoint column ─────────────────────────────────
//
// From the operator's own screen, 2026-09-04:
//
//   ●  ok  aify-comms  http://127.0.0.1:8800  http://127.0.0.1:8800 reports healthy version 0.6.1 …
//
// `probeService` builds that sentence with the address in front, and is right to: `aify-env doctor`
// prints the same string with no endpoint column. Here the row has already drawn it.
//
// IT COSTS INFORMATION, NOT DECORATION. `table` hands the LAST column the leftover width and clips
// it, so the version and build -- what somebody checking a deploy is reading the row for -- are cut
// first while the duplicate address survives ahead of them.

test("THE DETAIL DROPS AN ENDPOINT THE ROW ALREADY SHOWS", () => {
  const out = renderDashboard({
    version: "0.6.2",
    endpoint: "http://127.0.0.1:8802",
    terminals: { available: true, reason: "" },
    services: [{
      name: "aify-comms",
      endpoint: "http://127.0.0.1:8800",
      state: "passed",
      detail: "http://127.0.0.1:8800 reports healthy version 0.6.1 build b7d77fdf",
    }],
    processes: [],
    traffic: { requests: 0, bytesOut: 0 },
  }, { columns: 140, color: false }).join("\n");

  assert.match(out, /reports healthy version 0\.6\.1 build b7d77fdf/, "the useful half was lost");
  assert.equal(
    (out.match(/http:\/\/127\.0\.0\.1:8800/g) || []).length, 1,
    "the endpoint is still printed twice on one row",
  );
});

test("an endpoint INSIDE a sentence is left alone, not mangled", () => {
  // The unanswered wording is "no answer from <endpoint>: <error>". Cutting the address there would
  // leave "no answer from : ECONNREFUSED" -- a duplicate traded for a mangling.
  const out = renderDashboard({
    version: "0.6.2",
    endpoint: "http://127.0.0.1:8802",
    terminals: { available: true, reason: "" },
    services: [{
      name: "other-svc",
      endpoint: "http://127.0.0.1:9999",
      state: "unanswered",
      detail: "no answer from http://127.0.0.1:9999: ECONNREFUSED",
    }],
    processes: [],
    traffic: { requests: 0, bytesOut: 0 },
  }, { columns: 140, color: false }).join("\n");

  assert.match(out, /no answer from http:\/\/127\.0\.0\.1:9999: ECONNREFUSED/,
    "a sentence carrying the address mid-string was cut");
});
