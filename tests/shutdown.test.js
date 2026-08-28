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
      // ENTRY, not completion. The ordering tests below need to know when a stop BEGAN: a shutdown
      // that writes every line first and only then starts stopping satisfies "named before it
      // finished" while destroying the property that line actually carries.
      events.push(`entered-stop:${id}`);
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
  // ONE teardown, whatever else happens. Two would stop each process twice and clear the record from
  // under the first, which is the reason the guard exists at all.
  assert.equal(events.filter((e) => e === "stopped:a").length, 1);
  assert.equal(events.filter((e) => e === "entered-stop:a").length, 1);
});

// THERE IS NO TEST FOR "a double-tap before the stops were issued is ignored", because there is no
// such window. A gate on that was written, and its test failed on the first run: everything from
// `beforeStop()` to the last `runner.stop()` call runs synchronously in one turn of the loop, so a
// second signal is never delivered in between. The gate was removed rather than have a condition
// that is always true.
test("a second signal AFTER the stops were issued exits instead of being swallowed", async () => {
  // WHAT THE OPERATOR ACTUALLY DID, twice: Ctrl+C, nothing, Ctrl+C again, nothing, kill the terminal.
  // Killing the terminal is the worst available outcome -- the managed processes survive AND the
  // owned record dies with the window, so nothing can ever reap them. The reflex is already correct;
  // it just had no effect.
  const { events, shutdown } = harness({ stopDelayMs: 20 });
  const first = shutdown("SIGINT");
  // Let the first reach the point where the stops have been asked for.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await shutdown("SIGINT");
  assert.ok(
    events.includes("exit:0"),
    "the second signal was swallowed, so the only way out is still killing the terminal",
  );
  assert.ok(
    events.some((e) => e.startsWith("wrote:") && e.includes("KEEPING the owned record")),
    "the early exit must say the record is kept: an operator who thinks it was cleared has no reason "
      + "to expect the next instance to reap anything",
  );
  assert.ok(
    !events.includes("record-cleared"),
    "the record was cleared on the escape path, which turns a slow shutdown into a permanent orphan",
  );
  await first;
});

test("stops are entered one at a time, so a synchronous wedge still names its process", async () => {
  // THE REGRESSION THIS EXISTS TO CATCH, and it was mine. Bounding the shutdown with a deadline meant
  // tracking each stop's settlement, and the first version wrote that as
  // `Promise.resolve().then(() => runner.stop(id))`. That defers every call to a microtask, so all N
  // `stopping pN` lines print before the first stop begins -- and the screen stops being able to say
  // WHICH process wedged, which is the one thing the previous fix bought.
  //
  // The existing ordering test could not see it: it compares each line against that process's OWN
  // completion, and batching satisfies that too. This compares ACROSS processes.
  const { events, shutdown } = harness({ stopDelayMs: 5 });
  await shutdown("SIGINT");
  const namedB = events.findIndex((e) => e.startsWith("wrote:") && e.includes("stopping b"));
  const enteredA = events.indexOf("entered-stop:a");
  assert.ok(enteredA >= 0 && namedB >= 0, "the harness did not record both events");
  assert.ok(
    enteredA < namedB,
    "every process was named before any stop began. A stop that blocks the event loop then shows all "
      + "the lines and identifies nothing, which is exactly the report that could not be acted on.",
  );
});

test("a stop that throws SYNCHRONOUSLY does not strand the processes after it", async () => {
  // Calling `runner.stop` inline rather than inside a `.then` puts its synchronous throw on the map's
  // own stack. Without a guard it escapes, the teardown dies there, and every process after the
  // thrower is left running -- worse than the deferred version this replaced.
  const events = [];
  const shutdown = createShutdown({
    runner: {
      list: () => [{ id: "a" }, { id: "b" }],
      stop: (id) => {
        events.push(`entered-stop:${id}`);
        if (id === "a") throw new Error("ConPTY refused");
        events.push(`stopped:${id}`);
      },
    },
    closeServer: () => {},
    clearOwned: () => events.push("record-cleared"),
    exit: (code) => events.push(`exit:${code}`),
    write: () => {},
  });
  await shutdown("SIGINT");
  assert.ok(events.includes("stopped:b"), "a synchronous throw on the first stop stranded the second");
  assert.ok(events.includes("exit:0"), "a synchronous throw prevented the exit");
  // It FINISHED, badly. That is not a wedge, so the record is safe to clear -- same rule as a
  // rejecting stop.
  assert.ok(events.includes("record-cleared"), "a stop that threw was mistaken for one that wedged");
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

// ---- a stop that never returns must not become a shutdown that never ends -----------------------
//
// THE OPERATOR HIT THIS TWICE. Ctrl+C printed `SIGINT: stopping 3 managed process(es)`, then the
// three `stopping pN` lines, and then nothing at all until they killed the terminal. This file
// already recorded the mechanism -- "`Promise.allSettled` guards against a rejection, not against a
// call that never returns -- so a hang here is a hang forever" -- and named it without bounding it.
//
// THE PASTE NARROWED IT. All three `stopping pN` lines appeared. Each is written BEFORE its own
// `runner.stop()` call and the map runs synchronously, so a synchronous wedge on the first process
// would have suppressed lines two and three. It did not: every stop was entered and at least one
// never came back. That rules out the synchronous-block theory the old comment leaned on, and it is
// what makes a timeout the right instrument -- a timer cannot fire if the loop is blocked, and here
// the loop is not blocked.

test("a stop that never resolves still exits, and says which process wedged", async () => {
  const written = [];
  const exits = [];
  let cleared = 0;
  const shutdown = createShutdown({
    runner: {
      list: () => [{ id: "p1", pid: 11 }, { id: "p2", pid: 22 }],
      // p1 settles; p2 never does -- the shape the operator saw.
      stop: (id) => (id === "p1" ? Promise.resolve() : new Promise(() => {})),
    },
    clearOwned: () => { cleared += 1; },
    exit: (code) => exits.push(code),
    write: (line) => written.push(line),
    stopDeadlineMs: 5,
  });

  await shutdown("SIGINT");

  assert.deepStrictEqual(exits, [0], "the shutdown did not exit; this is the hang");
  const text = written.join("");
  assert.match(text, /p2 \(in \w[\w-]*\) did not confirm/,
    "the wedged process must be named WITH the call it is sitting in: which of the two blocking "
      + "calls it wedged in is the difference between an actionable report and another round of "
      + "guessing");
  assert.doesNotMatch(text, /p1 did not confirm/, "a process that DID stop was reported as stuck");
  assert.strictEqual(
    cleared, 0,
    "the owned record was cleared while a process was still unaccounted for -- that turns a slow "
      + "shutdown into an orphan no later instance can find",
  );
});

test("when every stop returns, the record is cleared and nothing is reported stuck", async () => {
  // The control. A shutdown that always reported a wedge, or never cleared the record, would pass
  // the case above while breaking the ordinary path this file's other tests describe.
  const written = [];
  const exits = [];
  let cleared = 0;
  const shutdown = createShutdown({
    runner: { list: () => [{ id: "p1", pid: 11 }], stop: () => Promise.resolve() },
    clearOwned: () => { cleared += 1; },
    exit: (code) => exits.push(code),
    write: (line) => written.push(line),
    stopDeadlineMs: 5,
  });

  await shutdown("SIGINT");

  assert.deepStrictEqual(exits, [0]);
  assert.strictEqual(cleared, 1, "a clean shutdown must still clear the owned record");
  assert.doesNotMatch(written.join(""), /did not confirm/);
});

test("a stop that REJECTS is not a wedge", async () => {
  // A refusal is an answer. Treating it as unfinished would keep the owned record for a process that
  // was accounted for, and orphan-reap the next instance into work it does not need to do.
  const written = [];
  let cleared = 0;
  const shutdown = createShutdown({
    runner: { list: () => [{ id: "p1", pid: 11 }], stop: () => Promise.reject(new Error("gone")) },
    clearOwned: () => { cleared += 1; },
    exit: () => {},
    write: (line) => written.push(line),
    stopDeadlineMs: 5,
  });

  await shutdown("SIGINT");

  assert.strictEqual(cleared, 1, "a rejected stop was treated as still outstanding");
  assert.doesNotMatch(written.join(""), /did not confirm/);
});


// ---------------------------------------------------------------------------------------------
// WHICH CALL IT WEDGED IN.
//
// `runner.stop()` makes two calls that can block the event loop. `killTree` no longer does.
// `child.kill()` is node-pty's ConPTY kill and still can -- its console-list helper's AttachConsole
// is unbounded, and no JS timer fires while it runs, so the deadline cannot save that one. When it
// happens the screen stops and there is nothing to distinguish it from the case that IS bounded.
//
// So the phase line is written BEFORE the call it names. Announcing afterwards is worthless for
// exactly the case that matters: the line never runs.

test("the teardown names each blocking call BEFORE making it", async () => {
  const written = [];
  const shutdown = createShutdown({
    runner: {
      list: () => [{ id: "p1", pid: 11 }],
      stop: async (_id, { phase } = {}) => {
        phase?.("console-kill");
        written.push("<the blocking call>");
        phase?.("tree-kill");
        phase?.("done");
      },
    },
    clearOwned: () => {},
    exit: () => {},
    write: (line) => written.push(line.trim()),
  });
  await shutdown("SIGINT");

  const announced = written.findIndex((line) => line.includes("p1 console-kill"));
  const called = written.indexOf("<the blocking call>");
  assert.ok(announced >= 0, "the blocking call was made without being named");
  assert.ok(
    announced < called,
    "the phase was announced AFTER the call it names. A call that blocks the loop never reaches "
      + "the line after it, so that ordering reports nothing for the only case it exists for",
  );
});

test("a teardown that works does not narrate its last phase", async () => {
  // "done" is for the record the timeout reads, not for the screen. A line per phase per process
  // would be four processes of noise on every clean exit, and a screen nobody reads is the same
  // failure as a screen that says nothing.
  const written = [];
  const shutdown = createShutdown({
    runner: {
      list: () => [{ id: "p1", pid: 11 }],
      stop: async (_id, { phase } = {}) => { phase?.("console-kill"); phase?.("tree-kill"); phase?.("done"); },
    },
    clearOwned: () => {},
    exit: () => {},
    write: (line) => written.push(line.trim()),
  });
  await shutdown("SIGINT");
  assert.ok(!written.some((line) => line.includes("done")), "the completed phase was printed");
});

test("the phase reported for a wedged process is the last one it ENTERED", async () => {
  // Not the first, and not a guess. A process that got through the console kill and hung in the
  // tree kill must not be reported as stuck in the console kill -- that would send the next
  // investigation at the call that worked.
  const written = [];
  const shutdown = createShutdown({
    runner: {
      list: () => [{ id: "p1", pid: 11 }],
      stop: (_id, { phase } = {}) => {
        phase?.("console-kill");
        phase?.("tree-kill");
        return new Promise(() => {});
      },
    },
    clearOwned: () => {},
    exit: () => {},
    write: (line) => written.push(line),
    stopDeadlineMs: 5,
  });
  await shutdown("SIGINT");
  assert.match(
    written.join(""), /p1 \(in tree-kill\) did not confirm/,
    "the wedged process was reported against a phase it had already left",
  );
});

test("a stop that ignores the phase hook is still reported, as starting", async () => {
  // The hook is optional and every other caller omits it. A runner that never calls it must not
  // make the timeout message throw or read as empty.
  const written = [];
  const shutdown = createShutdown({
    runner: { list: () => [{ id: "p1", pid: 11 }], stop: () => new Promise(() => {}) },
    clearOwned: () => {},
    exit: () => {},
    write: (line) => written.push(line),
    stopDeadlineMs: 5,
  });
  await shutdown("SIGINT");
  assert.match(written.join(""), /p1 \(in starting\) did not confirm/);
});
