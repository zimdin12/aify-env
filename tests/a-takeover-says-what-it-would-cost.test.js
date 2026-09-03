#!/usr/bin/env node
// Starting aify-env when one is already running ends that one's agents. So it asks first.
//
// THE INCIDENT. Twice on 2026-09-01 a start killed five agents, three of them mid-work. The second
// time was the operator's own, and their reason is the whole problem: "i had to start because i
// needed to see what is going on." Observing the fleet required the one action that destroys it, and
// nothing warned them either time.
//
// WHY NOT JUST KEEP THEM ALIVE. Adoption was built and does not work here. Measured with both
// controls in one run: a child spawned `detached: false` -- which is what the runner does -- dies when
// its parent is SIGKILLed, while a `detached: true` child survives. node-pty has no `detached` option,
// and on Windows the child is bound to a ConPTY the daemon owns, so a PTY-backed agent cannot outlive
// it. Agents use the PTY path because a visible TUI is a hard requirement. The one case that matters
// is the one that cannot be rescued, so the remedy is to stop doing it by accident.
//
// The incumbent already publishes what it owns on /health. Asking costs a request that was already
// being made to identify it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { sealedDaemonEnv } from "./_sealed-daemon-env.mjs";
import { workLostToSupersession, showViewInsteadOfRefusing } from "../lib/environment-checks.mjs";
import { freePort } from "./_free-port.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "bin", "aify-env.mjs");

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function sealed(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-${label}-`));
  return {
    dir,
    record: path.join(dir, "owned.json"),
    env: sealedDaemonEnv({
      AIFY_ENV_PROCESS_RECORD: path.join(dir, "owned.json"),
      AIFY_SERVICE_REGISTRY: path.join(dir, "no-registry.json"),
    }),
  };
}

function longLauncher(dir) {
  const file = path.join(dir, "long-aify");
  fs.writeFileSync(file, ["#!/usr/bin/env bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', "sleep 120", ""]
    .join(String.fromCharCode(10)));
  return file;
}

const start = (env, port, extra = []) =>
  spawn(process.execPath, [ENTRY, "--port", String(port), ...extra], { env, stdio: ["ignore", "pipe", "pipe"] });

function waitFor(child, pattern, ms = 20000) {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`never saw ${pattern}: ${seen}`)), ms);
    const onData = (chunk) => {
      seen += chunk.toString();
      if (pattern.test(seen)) { clearTimeout(timer); resolve(seen); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}

/** Start a daemon and give it one long-running process. Returns its pid and the launcher's. */
async function environmentWithWork(box, port) {
  const launcher = longLauncher(box.dir);
  const daemon = start(box.env, port);
  await waitFor(daemon, /listening/);
  const created = await fetch(`http://127.0.0.1:${port}/processes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "test", launcher, args: [], cwd: box.dir, label: "sc-architect" }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(created.status, 201, `could not start a process: ${created.status}`);
  const { pid } = await created.json();
  assert.ok(alive(pid), "nothing was running, so this test would prove nothing");
  return { daemon, workerPid: pid };
}

// -- the decision, without starting anything -------------------------------------------------------

test("an idle environment is not in the way", () => {
  assert.deepEqual(workLostToSupersession([]), []);
});

test("running processes are what a takeover would cost", () => {
  const running = [{ pid: 10, service: "aify-comms", label: "sc-architect" }];
  assert.deepEqual(workLostToSupersession(running), running);
});

test("--force is the operator saying they meant it", () => {
  // CONTRADICTION ARM. Without this, "always refuse" would satisfy the test above and make a stuck
  // environment impossible to replace -- which is worse than the problem, because the escape hatch is
  // the only thing that makes refusing-by-default safe.
  assert.deepEqual(workLostToSupersession([{ pid: 10 }], { force: true }), []);
});

test("a list that is not a list does not manufacture work", () => {
  // NEGATIVE CONTROL. Reaching this at all means the shape check already passed, which required the
  // array -- so treating junk as "something is running" could only make a reachable incumbent
  // unkillable, and nothing here can strand what the caller has not already accepted.
  for (const junk of [undefined, null, "two", 3, {}]) {
    assert.deepEqual(workLostToSupersession(junk), [], `${JSON.stringify(junk)} invented work`);
  }
});

// -- and the same decision reached by a real second start ------------------------------------------

test("a second start REFUSES while the first is running agents, and touches nothing", async () => {
  const PORT = await freePort();
  const box = sealed("refuse");
  const { daemon, workerPid } = await environmentWithWork(box, PORT);
  let second = null;
  try {
    second = start(box.env, PORT);
    const said = await waitFor(second, /Taking over would END/);
    const code = await new Promise((resolve) => second.on("exit", resolve));

    assert.equal(code, 69, "a refusal must not look like a successful start");
    assert.match(said, /sc-architect/, "the refusal does not say WHICH agent is in the way");
    assert.match(said, /--force/, "the refusal does not say how to proceed anyway");
    assert.match(said, /aify-env tui/, "the refusal does not offer the way to look without disturbing");

    // NOTHING WAS TOUCHED. Both halves: the incumbent still serves, and its work is still running.
    assert.ok(alive(daemon.pid), "the incumbent was killed by a start that claimed to refuse");
    assert.ok(alive(workerPid), "the agent was killed by a start that claimed to refuse");
    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(8000),
    })).json();
    assert.equal(health.pid, daemon.pid, "the incumbent is no longer the one serving");
  } finally {
    if (second) second.kill();
    daemon.kill();
    if (alive(workerPid)) { try { process.kill(workerPid, "SIGKILL"); } catch { /* already gone */ } }
  }
});

// ── A4: and then it SHOWS you the environment it refused to replace ──────────────────────────────
//
// The operator, 2026-08-24: "bare `aify-env` opens the tui". Their reason for starting a second one
// was *"i had to start because i needed to see what is going on"* -- so refusing and then naming a
// second command to type is one step short of the thing they wanted, taken at the moment they are
// already frustrated.
//
// THE CONDITION IS UNCHANGED and that is the decision, not an implementation detail. This fires only
// where a takeover was ALREADY refused: an incumbent with running agents. An IDLE environment is
// still superseded by a bare run, so "restart aify-env to pick up new code" keeps working -- and
// attaching whenever anything answered would have turned that restart into a silent no-op, which is
// the failure shape this project has spent a night removing.

test("THE VIEW OPENS ONLY IN A TERMINAL, and only when the dashboard is wanted", () => {
  // THE TRUE BRANCH, which no spawned test can reach: proving it needs a real TTY and a child gets a
  // pipe. Left as an `if` in the entry script, the only arm under test would be the one that changes
  // nothing -- so the decision is a predicate and this is where it is judged.
  assert.equal(showViewInsteadOfRefusing({ isTty: true }), true);
  assert.equal(showViewInsteadOfRefusing({ isTty: true, noDashboard: "1" }), false,
    "an operator who turned the dashboard off got one anyway");
  assert.equal(showViewInsteadOfRefusing({ isTty: false }), false,
    "a pipe was handed a screen full of escapes");
});

test("nothing but a real terminal counts as one", () => {
  // NEGATIVE CONTROLS. `process.stdout.isTTY` is `undefined` on a pipe, not `false`, and a truthy
  // check on a string or an object would open a view into a log. Both defaults fail closed.
  for (const notATty of [undefined, null, 0, "", "false", "yes", {}, 1, "1"]) {
    assert.equal(showViewInsteadOfRefusing({ isTty: notATty }), false,
      `${JSON.stringify(notATty)} was treated as a terminal`);
  }
  assert.equal(showViewInsteadOfRefusing(), false, "no argument at all opened a view");
});

test("only the exact opt-out opts out", () => {
  // A view suppressed by any truthy value would make `AIFY_NO_DASHBOARD=0` mean "no dashboard",
  // which is the opposite of what an operator typing it intends.
  assert.equal(showViewInsteadOfRefusing({ isTty: true, noDashboard: "0" }), true);
  assert.equal(showViewInsteadOfRefusing({ isTty: true, noDashboard: "" }), true);
  assert.equal(showViewInsteadOfRefusing({ isTty: true, noDashboard: " 1 " }), false,
    "a padded value is what an env file produces and must still opt out");
});

test("A PIPE KEEPS THE REFUSAL EXACTLY AS IT WAS — explanation, pointer, exit 69", async () => {
  // Escapes in a log are noise, a service manager parses this output, and anything reading the exit
  // status must keep reading the same one. `start()` pipes stdio, so every assertion in the refusal
  // test above is this case; what is added here is that the POINTER survives, because a reader with
  // no view is the only one who needs to be told the command that looks without disturbing.
  const PORT = await freePort();
  const box = sealed("piped");
  const { daemon, workerPid } = await environmentWithWork(box, PORT);
  let second = null;
  try {
    second = start(box.env, PORT);
    const said = await waitFor(second, /Taking over would END/);
    const code = await new Promise((resolve) => second.on("exit", resolve));
    assert.equal(code, 69, "a piped refusal stopped exiting 69");
    assert.match(said, /aify-env tui/, "the reader who gets no view lost the pointer to one");
    assert.doesNotMatch(said, /Showing it instead/, "a pipe was told a view it will never see");
    assert.ok(alive(daemon.pid) && alive(workerPid), "the refusal touched something");
  } finally {
    for (const pid of [second?.pid, daemon.pid]) { try { if (pid) process.kill(pid); } catch { /* gone */ } }
  }
});

test("AIFY_NO_DASHBOARD=1 keeps the old shape even in a terminal", async () => {
  // The opt-out already exists for the daemon's own view; it has to mean the same thing here, or an
  // operator who turned the dashboard off gets one anyway at the least welcome moment.
  const PORT = await freePort();
  const box = sealed("nodash");
  const { daemon, workerPid } = await environmentWithWork(box, PORT);
  let second = null;
  try {
    second = spawn(process.execPath, [ENTRY, "--port", String(PORT)], {
      env: { ...box.env, AIFY_NO_DASHBOARD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const said = await waitFor(second, /Taking over would END/);
    const code = await new Promise((resolve) => second.on("exit", resolve));
    assert.equal(code, 69);
    assert.doesNotMatch(said, /Showing it instead/);
    assert.ok(alive(daemon.pid) && alive(workerPid));
  } finally {
    for (const pid of [second?.pid, daemon.pid]) { try { if (pid) process.kill(pid); } catch { /* gone */ } }
  }
});

test("--force takes over anyway, which is what makes refusing safe", async () => {
  // The escape hatch, proven rather than assumed. A guard with no way past it turns one bad afternoon
  // into a permanently unusable command.
  const PORT = await freePort();
  const box = sealed("forced");
  const { daemon, workerPid } = await environmentWithWork(box, PORT);
  let second = null;
  try {
    second = start(box.env, PORT, ["--force"]);
    await waitFor(second, /superseding/);
    await waitFor(second, /listening/);
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.ok(!alive(daemon.pid), "--force did not take over");
    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(8000),
    })).json();
    assert.equal(health.pid, second.pid, "/health does not report the process that is actually serving");
  } finally {
    if (second) second.kill();
    daemon.kill();
    if (alive(workerPid)) { try { process.kill(workerPid, "SIGKILL"); } catch { /* already gone */ } }
  }
});

test("an idle environment is still superseded without ceremony", async () => {
  // THE CASE THAT MUST NOT REGRESS. Refusing whenever an environment exists would break every restart
  // of an idle one, which is the ordinary way this command is used.
  const PORT = await freePort();
  const box = sealed("idle");
  const first = start(box.env, PORT);
  let second = null;
  try {
    await waitFor(first, /listening/);
    second = start(box.env, PORT);
    await waitFor(second, /superseding/);
    await waitFor(second, /listening/);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(!alive(first.pid), "an idle environment was not superseded");
  } finally {
    if (second) second.kill();
    first.kill();
  }
});
