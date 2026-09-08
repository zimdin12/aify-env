// The one part of the console that touches the operator's terminal.
//
// RAW MODE IS BORROWED, NOT OWNED. A view that exits leaving the terminal raw hands back a shell that
// no longer echoes what is typed, and the fix is not obvious to anyone it happens to. So most of this
// file is about giving it back, on every path out.
//
// AND THE CONSOLE IS OPT-IN. `startDashboard` is called by a script with `--once`, by tests, and by the
// daemon's own startup banner. None of those owns a keyboard, and a view that opened a process stream
// because it happened to be imported would be doing IO nobody asked for.

import assert from "node:assert/strict";

const LF = String.fromCharCode(10);
import test from "node:test";
import { EventEmitter } from "node:events";

import { startDashboard } from "../lib/dashboard.mjs";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const CTRL_C = String.fromCharCode(3);
const ENTER = String.fromCharCode(13);

/** A stand-in for process.stdin that records what was done to it. */
class FakeInput extends EventEmitter {
  constructor({ isRaw = false } = {}) {
    super();
    this.isRaw = isRaw;
    this.calls = [];
  }

  setRawMode(on) { this.calls.push(`raw:${on}`); this.isRaw = on; return this; }
  resume() { this.calls.push("resume"); return this; }
  pause() { this.calls.push("pause"); return this; }
}

/** A daemon that answers the one call collectSnapshot makes, with the given processes. */
/**
 * The daemon's answers, including a REAL output stream for the console.
 *
 * THE STREAM MATTERS NOW. Input is gated on the follower being LIVE as well as on a pane frame
 * having rendered -- a pane showing "connecting", an exit notice or a failure is a rendered frame
 * and still not a place to type. A fake that answered `/output` with JSON left every follower stuck
 * at `connecting`, so a test about FORWARDING was exercising a stream that never opened.
 */
const fakeFetch = (processes) => async (url) => {
  if (String(url).includes("/output")) {
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      body: (async function* body() {
        // LEADS WITH `meta`, as the daemon does. Without it the stream reads as an unknown history,
        // the pane shows the refusal notice, and input is correctly declined -- so a fixture that
        // omits it is testing a configuration this version does not produce.
        yield encoder.encode(`event: meta${LF}data: ${JSON.stringify(
          { cols: 80, rows: 24, truncated: false, resized: false, replayBytes: 65536 })}${LF}${LF}`);
        yield encoder.encode(`data: ${JSON.stringify("ready")}${LF}${LF}`);
        // Held open, like the real one: a console stream ends when the process does.
        await new Promise(() => {});
      })(),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => (String(url).includes("/health")
      ? { version: "0.0.0", processes }
      : { processes }),
  };
};

const start = (input, extra = {}) => startDashboard({
  endpoint: "http://127.0.0.2:1",
  registryPath: "/nonexistent/services.json",
  write: () => {},
  clearScreen: false,
  intervalMs: 60_000,
  columns: 120,
  rows: 20,
  input,
  fetchImpl: fakeFetch([{ id: "p1", label: "one" }, { id: "p2", label: "two" }]),
  readFile: () => { throw new Error("no registry"); },
  ...extra,
});

test("WITHOUT `input` NO PROCESS STREAM IS OPENED", async () => {
  // The daemon banner and `--once` both land here, and neither owns a keyboard. Opening a console
  // stream for a script is IO nobody asked for.
  //
  // THIS TEST USED TO BE VACUOUS. It built a FakeInput, never passed it, and asserted nothing had
  // been done to it -- true no matter what the code did. A mutation removing the `input ?` guard
  // survived it, and that mutation makes every `--once` render subscribe to a process. So the
  // assertion is now about the CONSEQUENCE: which URLs were fetched.
  const asked = [];
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    fetchImpl: async (url) => {
      asked.push(String(url));
      return { ok: true, status: 200, json: async () => ({ processes: [{ id: "p1", label: "one" }] }) };
    },
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));
  stop();
  const streams = asked.filter((u) => u.includes("/output"));
  assert.deepEqual(streams, [], `a console stream was opened with no input: ${streams.join(", ")}`);
  // POSITIVE CONTROL: the snapshot request DID happen, so an empty stream list means "none opened"
  // rather than "nothing was fetched at all".
  assert.ok(asked.length > 0, "no request was made at all -- this test proves nothing");
});

test("WITH `input` a process stream IS opened, which is what makes the test above mean something", async () => {
  const asked = [];
  const input = new FakeInput();
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    input,
    fetchImpl: async (url) => {
      asked.push(String(url));
      return {
        ok: true,
        status: 200,
        body: null,
        json: async () => ({ processes: [{ id: "p1", label: "one" }] }),
      };
    },
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));
  // OPEN THE CONSOLE FIRST, through the real key path. The pane defaults to hidden and a hidden pane
  // opens no stream -- deliberately, because a stream nobody is reading is an HTTP connection and a
  // growing buffer for a pane that is not on screen. Pressing `p` here makes this test stronger than
  // it was: it now proves the whole chain from a keystroke to an opened stream, rather than assuming
  // the stream opens by itself.
  input.emit("data", "p");
  await new Promise((r) => setImmediate(r));
  stop();
  assert.ok(asked.some((u) => u.includes("/processes/p1/output")),
    `no stream was opened after opening the console: ${asked.join(", ")}`);
});

test("with `input` the terminal goes raw, and stop() GIVES IT BACK", async () => {
  const input = new FakeInput({ isRaw: false });
  const { stop } = await start(input);
  assert.ok(input.calls.includes("raw:true"), "raw mode was never entered");
  stop();
  assert.ok(input.calls.includes("raw:false"), "raw mode was never restored");
  assert.equal(input.isRaw, false);
});

test("A TERMINAL ALREADY IN RAW MODE IS LEFT IN IT", async () => {
  // We borrowed nothing, so we return nothing. Turning it off would break whatever set it -- the
  // caller may be a wrapper that owns the mode for its own reasons.
  const input = new FakeInput({ isRaw: true });
  const { stop } = await start(input);
  stop();
  assert.ok(!input.calls.includes("raw:false"), "raw mode was turned off for a caller that owned it");
});

test("stop() removes the listener, so a late keypress cannot reach a stopped view", async () => {
  const input = new FakeInput();
  const { stop } = await start(input);
  assert.equal(input.listenerCount("data"), 1);
  stop();
  assert.equal(input.listenerCount("data"), 0);
});

test("stop() is safe to call twice", async () => {
  const input = new FakeInput();
  const { stop } = await start(input);
  stop();
  assert.doesNotThrow(() => stop());
});

test("a quit key calls onQuit rather than exiting from inside the library", async () => {
  // lib/ owns no lifecycle on purpose: the daemon's interrupt has to be able to stop its managed
  // processes rather than being pre-empted by a view's exit handler.
  let quit = 0;
  const input = new FakeInput();
  const { stop } = await start(input, { onQuit: () => { quit += 1; } });
  input.emit("data", CTRL_C);
  stop();
  assert.equal(quit, 1);
});

test("keys meant for a process are HANDED BACK, not written from inside the view", async () => {
  // Writing into a PTY is the daemon's business. A view asks.
  const sent = [];
  const input = new FakeInput();
  const { stop } = await start(input, { onInput: (target, data) => sent.push([target?.id, data]) });
  input.emit("data", ENTER);   // attach -- which OPENS the follower and resets readiness with it
  // A FRAME HAS TO LAND FIRST, and this await is the test being honest rather than a workaround.
  // Input is gated on a pane frame having actually RENDERED -- not on the layout permitting one --
  // so a synchronous burst outruns the screen and is refused. At human typing speed the draw
  // triggered by the attach lands long before the next keystroke; this reproduces that, and a burst
  // that beats the frame is exactly the case the gate exists to refuse.
  // Long enough for the stream to OPEN, not just for a microtask: `start()` is deliberately not
  // awaited by the session (a render loop must not block on a connection), so the follower reaches
  // `streaming` a few tasks later.
  // LONGER NOW, and the reason is a real gate rather than a slow machine: attaching opens a follower,
  // which resets readiness, so the frame that restores it is the one drawn AFTER the attach -- and
  // the stream has to reach `streaming` before input is live at all.
  await new Promise((r) => setTimeout(r, 120));
  input.emit("data", "hello");
  stop();
  assert.deepEqual(sent, [["p1", "hello"]]);
});

test("moving the selection does not call onInput", async () => {
  // An arrow key is three bytes. Routing it to the process would type escape sequences at an agent.
  const sent = [];
  const input = new FakeInput();
  const { stop } = await start(input, { onInput: (target, data) => sent.push([target?.id, data]) });
  input.emit("data", DOWN);
  stop();
  assert.deepEqual(sent, []);
});

test("a handler that throws does not take the view down", async () => {
  const input = new FakeInput();
  const { stop } = await start(input, { onQuit: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => input.emit("data", CTRL_C));
  stop();
});


test("A CONFIRMED ACTION REACHES onAction, through the real key path", async () => {
  // The end of the chain, driven the way an operator drives it: keystrokes into the live view, and a
  // handler that would be the thing actually killing a worker. Nothing between here and `keys.mjs` is
  // mocked, so the confirmation cannot be bypassed by a seam this test invented.
  const performed = [];
  const input = new FakeInput();
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    input,
    // THE CALLER DECLARES WHAT IT CAN DO. The menu offers attach alone by default, so a test that
    // exercises `stop` has to say its caller can perform one -- exactly as `daemon-view.mjs` does.
    actions: ["attach", "restart", "stop"],
    onAction: (p) => performed.push(p),
    fetchImpl: async () => ({
      ok: true, status: 200, body: null,
      json: async () => ({ processes: [{ id: "p1", label: "alpha" }, { id: "p2", label: "bravo" }] }),
    }),
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));

  const DOWN_ = String.fromCharCode(27) + "[B";
  input.emit("data", DOWN_);          // select bravo
  input.emit("data", "m");            // open the menu
  input.emit("data", DOWN_);          // restart
  input.emit("data", DOWN_);          // stop
  input.emit("data", String.fromCharCode(13));
  assert.deepEqual(performed, [], "a stop reached the handler before it was confirmed");

  input.emit("data", "y");
  await new Promise((r) => setImmediate(r));
  stop();

  assert.equal(performed.length, 1, `expected one action, got ${performed.length}`);
  assert.equal(performed[0].action, "stop");
  assert.equal(performed[0].process.id, "p2", "the action named the wrong agent");
});

test("NEGATIVE CONTROL: with no handler the menu is inert and nothing throws", async () => {
  // The honest default while handlers are being built: the operator sees what is coming, nothing
  // happens, and nothing pretends to have happened. A `data` listener that threw here would take the
  // whole view down on a keypress.
  const input = new FakeInput();
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    write: () => {},
    clearScreen: false,
    intervalMs: 60_000,
    input,
    fetchImpl: async () => ({
      ok: true, status: 200, body: null,
      json: async () => ({ processes: [{ id: "p1", label: "alpha" }] }),
    }),
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setImmediate(r));
  assert.doesNotThrow(() => {
    input.emit("data", "m");
    input.emit("data", String.fromCharCode(13));
  });
  stop();
});


test("A FRAME THAT WAS NEVER WRITTEN IS NOT CACHED AS DRAWN", async () => {
  // REVIEW'S CACHE COUNTEREXAMPLE. `frameUpdate` diffs against `previousLines`, and caching those
  // lines BEFORE the write meant a FAILED frame still recorded them as on screen -- so re-entering
  // the same state produced no bytes at all, and the readiness that the failure revoked came straight
  // back with nothing having been drawn. An intention is not a frame.
  let failNext = false;
  const written = [];
  const input = new FakeInput();
  const { stop } = await startDashboard({
    endpoint: "http://127.0.0.2:1",
    registryPath: "/nonexistent/services.json",
    clearScreen: true,
    intervalMs: 60_000,
    columns: 120,
    rows: 20,
    input,
    write: (text) => {
      if (failNext) throw new Error("the terminal refused the write");
      written.push(text);
    },
    fetchImpl: fakeFetch([{ id: "p1", label: "one" }]),
    readFile: () => { throw new Error("no registry"); },
  });
  await new Promise((r) => setTimeout(r, 60));
  const before = written.length;
  assert.ok(before > 0, "nothing was ever drawn, so this test proves nothing");

  // A frame that throws: the cache must not remember it.
  failNext = true;
  input.emit("data", "p");
  await new Promise((r) => setTimeout(r, 60));
  failNext = false;

  // The very next draw of the SAME state must therefore produce bytes again.
  input.emit("data", "p");
  input.emit("data", "p");
  await new Promise((r) => setTimeout(r, 60));
  stop();
  assert.ok(written.length > before,
    "a state whose frame failed produced no bytes on re-entry, so the cache had recorded it as drawn");
});

console.log("dashboard-console-input.test.js: all assertions passed");

test("A KEYSTROKE REDRAWS WITHOUT ASKING THE DAEMON ANYTHING", async () => {
  // Every branch of the key handler used to end in a full collect, so moving the cursor one row
  // re-asked for the whole world before the screen moved. MEASURED at 1 + N requests per keystroke,
  // N being the registered services -- 2 on a host running aify-comms, and it grows with the
  // registry. A key changes the SELECTION, which no request can report.
  //
  // THE ROSTER IT DRAWS MAY BE UP TO `intervalMs` OLD, deliberately. That is what the refresh timer
  // is for, and it is what every other terminal view shows between refreshes.
  const health = [];
  const input = new FakeInput();
  const view = await start(input, {
    fetchImpl: async (url) => {
      if (!String(url).includes("/output")) health.push(String(url));
      return fakeFetch([{ id: "p1", label: "one" }, { id: "p2", label: "two" }])(url);
    },
  });
  await new Promise((r) => setImmediate(r));

  const afterFirstFrame = health.length;
  assert.ok(afterFirstFrame > 0, "the first frame asked the daemon nothing; the probe is not wired");

  for (let i = 0; i < 5; i += 1) input.emit("data", DOWN);
  await new Promise((r) => setImmediate(r));

  assert.equal(health.length, afterFirstFrame,
    `five keystrokes issued ${health.length - afterFirstFrame} request(s); a key changes the `
    + "selection and the daemon has nothing to say about it");

  // AND A RESIZE, which is the same claim about geometry rather than selection. A mutant that made
  // this path collect again SURVIVED until it was asserted -- four call sites were changed and only
  // two were covered.
  view.resize({ columns: 100, rows: 30 });
  await new Promise((r) => setImmediate(r));
  assert.equal(health.length, afterFirstFrame,
    `a resize issued ${health.length - afterFirstFrame} request(s); the geometry changed, not the `
    + "roster");
  view.stop();
});

test("THE REFRESH TIMER STILL COLLECTS, which is the only thing that ever asks", async () => {
  // NEGATIVE CONTROL for the test above. If redraws had simply stopped collecting altogether, that
  // test would pass and the view would show its first frame for ever. Something must still ask.
  const health = [];
  const input = new FakeInput();
  const { stop } = await start(input, {
    intervalMs: 5,
    fetchImpl: async (url) => {
      if (!String(url).includes("/output")) health.push(String(url));
      return fakeFetch([{ id: "p1", label: "one" }])(url);
    },
  });
  const afterFirstFrame = health.length;
  await new Promise((r) => setTimeout(r, 60));
  stop();
  assert.ok(health.length > afterFirstFrame,
    "the refresh timer asked the daemon nothing; the view would show its first frame for ever");
});

test("INPUT IS REFUSED WHILE THE FRAME ON SCREEN STILL SAYS CONNECTING", async () => {
  // The stream is held closed so a frame is drawn while the follower is CONNECTING, then opened
  // with no redraw in between. That is the exact window: status says streaming, the screen does not.
  let openTheStream;
  const gate = new Promise((resolve) => { openTheStream = resolve; });
  const frames = [];
  const sent = [];
  const input = new FakeInput();

  const { stop } = await start(input, {
    write: (text) => frames.push(text),
    onInput: (target, data) => sent.push([target?.id, data]),
    fetchImpl: async (url) => {
      if (String(url).includes("/output")) await gate;
      return fakeFetch([{ id: "p1", label: "one" }, { id: "p2", label: "two" }])(url);
    },
  });

  input.emit("data", ENTER);                       // attach; the follower's fetch is held
  await new Promise((r) => setTimeout(r, 60));     // a frame lands, drawn while connecting

  const drawnWhileConnecting = frames.join("");
  assert.ok(drawnWhileConnecting.includes("connecting"),
    "the pane never rendered a connecting frame; this test is not reproducing its own scenario");

  openTheStream();
  await new Promise((r) => setTimeout(r, 60));     // the stream opens. NOTHING redraws.

  input.emit("data", "SYNTHETIC_TYPED");
  stop();

  assert.deepEqual(sent, [],
    "a keystroke reached the process while the last frame written still said connecting; the "
    + "operator is typing at a screen that has not caught up");
});

test("AND INPUT OPENS ONCE A STREAMING FRAME HAS ACTUALLY BEEN DRAWN", async () => {
  // POSITIVE CONTROL for the refusal above. Without it, a gate that refused input for ever would
  // pass that test, and the console would simply stop accepting keys.
  const sent = [];
  const input = new FakeInput();
  const { stop } = await start(input, {
    onInput: (target, data) => sent.push([target?.id, data]),
  });
  input.emit("data", ENTER);
  await new Promise((r) => setTimeout(r, 120));    // the stream opens AND a frame is drawn from it
  input.emit("data", "hello");
  stop();
  assert.deepEqual(sent, [["p1", "hello"]],
    "input never became live even after a streaming frame was drawn");
});

test("PANE PROGRESS IS COALESCED, so a chatty producer does not redraw per chunk", async () => {
  // A producer emitting hundreds of chunks must not cost hundreds of frames.
  //
  // THIS DRIVES THE REAL VIEW. An earlier version re-implemented the coalescing inline and counted
  // its own timer, which is a test of the copy: a mutant that removed the real one survived it.
  // Every chunk here carries DISTINCT text, so `frameUpdate` cannot suppress a redraw as unchanged
  // and the count reflects scheduling rather than deduplication.
  const CHUNKS = 200;
  const frames = [];
  const input = new FakeInput();
  const encoder = new TextEncoder();

  const view = await start(input, {
    paneRepaintMs: 50,
    write: (text) => frames.push(text),
    fetchImpl: async (url) => {
      if (!String(url).includes("/output")) {
        return fakeFetch([{ id: "p1", label: "one" }])(url);
      }
      return {
        ok: true,
        status: 200,
        body: (async function* body() {
          yield encoder.encode(`event: meta${LF}data: ${JSON.stringify(
            { cols: 80, rows: 24, truncated: false, resized: false, replayBytes: 65536 })}${LF}${LF}`);
          for (let i = 0; i < CHUNKS; i += 1) {
            yield encoder.encode(`data: ${JSON.stringify(`line-${i}${LF}`)}${LF}${LF}`);
          }
          await new Promise(() => {});
        })(),
      };
    },
  });

  input.emit("data", ENTER);                     // attach, which opens the stream
  await new Promise((r) => setTimeout(r, 250));  // several coalescing windows
  const drawn = frames.length;
  view.stop();

  assert.ok(drawn > 0, "nothing was drawn at all; the stream never reached the pane");
  assert.ok(drawn < CHUNKS / 4,
    `${CHUNKS} chunks became ${drawn} frames; progress is not being coalesced, and a producer at `
    + "full rate would redraw per chunk");
});

test("A SUPERSEDED FOLLOWER'S PROGRESS DRAWS NOTHING", async () => {
  // A stream still draining after the operator moved on keeps reporting progress. Acting on it
  // would draw one process's arrival into another process's pane. ConsoleSession binds each
  // callback to the follower that owns it and compares identity before passing it on.
  const { ConsoleSession } = await import("../lib/console-session.mjs");

  const followers = [];
  const drawn = [];
  const session = new ConsoleSession({
    onProgress: () => drawn.push(session.watchedId),
    makeFollower: (id) => {
      const follower = { id, status: "streaming", start: () => {}, stop: () => {}, pane: () => null };
      followers.push(follower);
      return follower;
    },
  });

  // The follower follows the SELECTION, and only when a pane could actually be drawn.
  session.noteViewport({ columns: 120 });
  const rows = [{ id: "p1", label: "one" }, { id: "p2", label: "two" }];
  // `paneHidden` defaults TRUE -- the console is opt-in -- and a hidden pane opens no follower.
  session.focus = { ...session.focus, paneHidden: false };
  session.syncProcesses(rows);
  session.focus = { ...session.focus, selected: 1 };
  session.syncProcesses(rows);
  assert.equal(followers.length, 2,
    `the session opened ${followers.length} follower(s); this test needs a superseded one`);

  followers[1].onProgress();
  assert.deepEqual(drawn, ["p2"], "the CURRENT follower's progress did not reach the view");

  followers[0].onProgress();          // the superseded one, still draining
  assert.deepEqual(drawn, ["p2"],
    "a superseded follower's progress reached the view; it would draw p1's output into p2's pane");
});

test("PROGRESS THAT ARRIVES AFTER stop() DRAWS NOTHING", async () => {
  // A stream can report progress while the view is tearing down, and a frame painted then lands
  // over whatever the shutdown is printing. Both the pending timer and the flag are checked.
  const frames = [];
  const input = new FakeInput();
  const view = await start(input, {
    paneRepaintMs: 5,
    write: (text) => frames.push(text),
  });
  input.emit("data", ENTER);
  await new Promise((r) => setTimeout(r, 60));

  view.stop();
  const afterStop = frames.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(frames.length, afterStop,
    "a frame was written after stop(); it would land over the shutdown output");
});
