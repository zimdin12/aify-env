// The one shutdown path, asserted without sending a signal.
//
// The integration test in orphans-die-with-the-environment.test.js proves the same rule against a real
// process, and SKIPS on Windows because TerminateProcess runs no handler there. That skip is why two
// contradictory SIGINT handlers lived in bin/aify-env.mjs unnoticed on the operator's own fleet: one
// stopped every managed process, the other closed the server and exited, and the second usually won
// the race to process.exit. The daemon exited leaving its agents running until the next start reaped
// them from the record -- the orphan window the rule exists to forbid.
//
// So the ORDER is tested here, cross-platform, with everything injected.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createShutdown } from "../lib/shutdown.mjs";

function harness({ stopDelayMs = 0, stopThrowsFor = null } = {}) {
  const events = [];
  const runner = {
    list: () => [{ id: "a" }, { id: "b" }],
    stop: async (id) => {
      if (stopDelayMs) await new Promise((resolve) => setTimeout(resolve, stopDelayMs));
      if (stopThrowsFor === id) {
        events.push(`stop-failed:${id}`);
        throw new Error(`cannot stop ${id}`);
      }
      events.push(`stopped:${id}`);
    },
  };
  const closeServer = () => events.push("server-closed");
  return {
    events,
    shutdown: createShutdown({
      runner,
      closeServer,
      clearOwned: () => events.push("record-cleared"),
      exit: (code) => events.push(`exit:${code}`),
      write: (line) => events.push(`wrote:${line.trim()}`),
    }),
  };
}

test("every managed process is stopped BEFORE the process exits", async () => {
  // The whole defect in one assertion: exiting first is what left agents running.
  const { events, shutdown } = harness({ stopDelayMs: 5 });
  await shutdown("SIGINT");
  const exitAt = events.indexOf("exit:0");
  assert.ok(exitAt >= 0, "shutdown never exited");
  assert.ok(events.indexOf("stopped:a") < exitAt, "process a was still running at exit");
  assert.ok(events.indexOf("stopped:b") < exitAt, "process b was still running at exit");
});

test("the server stops accepting before the processes are torn down", async () => {
  const { events, shutdown } = harness({ stopDelayMs: 5 });
  await shutdown("SIGTERM");
  assert.ok(
    events.indexOf("server-closed") < events.indexOf("stopped:a"),
    "new work could arrive while the environment was tearing down",
  );
});

test("the exit does not wait on server.close's callback", async () => {
  // A console holding an SSE stream never lets that callback fire. Hanging the exit on it means the
  // daemon never exits -- which is how the losing handler was written.
  const events = [];
  const shutdown = createShutdown({
    runner: { list: () => [{ id: "a" }], stop: async () => events.push("stopped:a") },
    closeServer: () => { /* returns without ever invoking a callback */ },
    clearOwned: () => events.push("record-cleared"),
    exit: (code) => events.push(`exit:${code}`),
  });
  await shutdown("SIGINT");
  assert.deepEqual(events, ["stopped:a", "record-cleared", "exit:0"]);
});

test("the record is cleared only after the stops were attempted", async () => {
  // Clearing first would erase the record of exactly the processes a crash mid-teardown would strand,
  // and the record is the ONLY mechanism on Windows.
  const { events, shutdown } = harness();
  await shutdown("SIGINT");
  assert.ok(events.indexOf("stopped:b") < events.indexOf("record-cleared"));
  assert.ok(events.indexOf("record-cleared") < events.indexOf("exit:0"));
});

test("one process that refuses to die does not strand the others", async () => {
  const { events, shutdown } = harness({ stopThrowsFor: "a" });
  await shutdown("SIGINT");
  assert.ok(events.includes("stop-failed:a"));
  assert.ok(events.includes("stopped:b"), "b was skipped because a threw");
  assert.ok(events.includes("exit:0"), "a failed stop must not prevent the exit");
});

test("a second signal does not start a second teardown", async () => {
  const { events, shutdown } = harness();
  await Promise.all([shutdown("SIGINT"), shutdown("SIGINT")]);
  assert.equal(events.filter((e) => e === "exit:0").length, 1);
  assert.equal(events.filter((e) => e === "stopped:a").length, 1);
});

test("it says how many processes it is taking with it", async () => {
  const { events, shutdown } = harness();
  await shutdown("SIGHUP");
  assert.ok(
    events.some((e) => e.startsWith("wrote:") && e.includes("SIGHUP") && e.includes("2 managed")),
    `no banner naming the signal and the count: ${JSON.stringify(events)}`,
  );
});

test("a server that was never listening is not a reason to leak processes", async () => {
  const events = [];
  const shutdown = createShutdown({
    runner: { list: () => [{ id: "a" }], stop: async () => events.push("stopped:a") },
    closeServer: () => { throw new Error("not running"); },
    clearOwned: () => {},
    exit: (code) => events.push(`exit:${code}`),
  });
  await shutdown("SIGINT");
  assert.deepEqual(events, ["stopped:a", "exit:0"]);
});

test("anything that must stop first stops before the processes do", async () => {
  // Today that is the live view: a frame landing mid-teardown paints a screen that is already untrue.
  const events = [];
  const shutdown = createShutdown({
    runner: { list: () => [{ id: "a" }], stop: async () => events.push("stopped:a") },
    beforeStop: () => events.push("view-stopped"),
    clearOwned: () => {},
    exit: (code) => events.push(`exit:${code}`),
  });
  await shutdown("SIGINT");
  assert.deepEqual(events, ["view-stopped", "stopped:a", "exit:0"]);
});

test("a decoration that fails to stop does not leave agents running", async () => {
  const events = [];
  const shutdown = createShutdown({
    runner: { list: () => [{ id: "a" }], stop: async () => events.push("stopped:a") },
    beforeStop: () => { throw new Error("the view is wedged"); },
    clearOwned: () => {},
    exit: (code) => events.push(`exit:${code}`),
  });
  await shutdown("SIGINT");
  assert.deepEqual(events, ["stopped:a", "exit:0"]);
});

test("each process is NAMED before it is stopped, so a wedged stop says which one", async () => {
  // `stop()` can block the event loop synchronously: node-pty's ConPTY kill forks a console-list
  // helper whose AttachConsole is unbounded. On such a run nothing after the call executes, so a line
  // written AFTER the stop never reaches the screen and the operator sees only "stopping N managed
  // process(es)" -- which is what "it froze at close again" has looked like twice.
  //
  // The ordering is the whole point. A test that only checked the line EXISTS would pass with the
  // write moved after the stop, where it is worthless.
  const { events, shutdown } = harness({ stopDelayMs: 5 });
  await shutdown("SIGINT");

  for (const id of ["a", "b"]) {
    const named = events.findIndex((e) => e.startsWith("wrote:") && e.includes(`stopping ${id}`));
    const stopped = events.indexOf(`stopped:${id}`);
    assert.ok(named >= 0, `${id} was stopped without being named; a wedge here reports nothing`);
    assert.ok(named < stopped, `${id} was named AFTER its stop, where a blocking stop never prints it`);
  }
});
