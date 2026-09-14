#!/usr/bin/env node
// A subscriber that joins a long-running PTY is handed its screen, not a suffix that cannot rebuild it.
//
// THE DEFECT. The daemon keeps 64 KB of output. For any agent that has printed more, a new console got
// a truncated replay that `baselineIsSound` rightly refused, and waited for a RIS Claude never sends --
// so `p` showed nothing and `aify-env attach` painted a broken screen. The fix `screen-baseline.mjs`
// names: a checkpoint in the daemon.
//
// WHAT HAS TO BE PROVEN is not that a screen arrives but that it is the RIGHT screen at the RIGHT byte.
// The emulator parses asynchronously, so a snapshot taken carelessly describes some earlier moment and
// the live bytes after it repeat or skip. So output keeps flowing, and a resize happens, while the
// subscriber joins; the subscriber's rebuilt screen is compared cell text, row by row, with the
// daemon's emulator and with an oracle that saw the whole history. The negative controls show the
// comparison notices one chunk missing or one chunk twice.
//
// SYNTHETIC OUTPUT ONLY (`fixtures/claude-like-stream.mjs`), never a captured agent screen.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Runner } from "../lib/runner.mjs";
import { loadCheckpointFactory } from "../lib/screen-checkpoint.mjs";
import { ScreenEmulator } from "../lib/screen-emulator.mjs";
import { baselineIsSound } from "../lib/screen-baseline.mjs";
import { namedFrame, readFrames } from "../lib/sse-frames.mjs";
import { claudeLikeChunks } from "./fixtures/claude-like-stream.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LF = String.fromCharCode(10);
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(LF);
const SPEC = { service: "test-service", fileText: ALLOWED, command: "fake", args: [] };

function fakeTerminal({ cols, rows }) {
  const handlers = [];
  return {
    pid: 0, cols, rows,
    onData: (fn) => handlers.push(fn),
    emit(text) { for (const fn of handlers) fn(text); },
    onExit: () => {}, write: () => {}, kill: () => {},
    resize(c, r) { this.cols = c; this.rows = r; },
  };
}

/** A runner whose checkpoints are the real ones, with the last one built handed to the test. */
function runnerWithCheckpoints(terminal, extra = {}) {
  const made = [];
  const runner = new Runner({
    openTerminal: () => terminal,
    loadCheckpoint: async () => {
      const make = await loadCheckpointFactory();
      return make && ((geometry) => { const c = make(geometry); made.push(c); return c; });
    },
    ...extra,
  });
  return { runner, made };
}

/** Records what a subscriber is handed, in order, the way the route writes it. */
function recorder() {
  const events = [];
  return {
    events,
    handlers: {
      onMeta: (meta) => events.push({ kind: "meta", meta }),
      onOutput: (text) => events.push({ kind: "output", text }),
      onExit: () => events.push({ kind: "exit" }),
      onResize: ({ cols, rows }) => events.push({ kind: "resize", cols, rows }),
    },
  };
}

/** A subscriber's screen, rebuilt from exactly what it was handed. */
async function rebuild(events) {
  const [first] = events;
  assert.equal(first.kind, "meta", "the first thing a subscriber is handed must be meta");
  const screen = await ScreenEmulator.create({ cols: first.meta.cols, rows: first.meta.rows });
  for (const event of events.slice(1)) {
    if (event.kind === "output") await screen.write(event.text);
    if (event.kind === "resize") screen.resize(event);
  }
  return screen;
}

const tick = () => new Promise((r) => setImmediate(r));
/** Resolves once the checkpoint has parsed everything fed to it, whatever state its parser is in. */
const quiet = (checkpoint) => new Promise((r) => checkpoint.screen.term.write("", r));

test("POSITIVE CONTROL: all three optional packages are installed, so a checkpoint is being tested", async () => {
  assert.equal(typeof await loadCheckpointFactory(), "function");
});

/**
 * Drives the whole scenario once and hands back everything the assertions need.
 *
 * SHAPED SO THE COMPARISON CAN SEE A MISTAKE. A screen shows only its last rows, so a chunk dropped or
 * repeated early and then scrolled away is invisible at the end -- a first version of this test let
 * five mutants through exactly that way. So the subscriber joins with the parser mid-sequence, the
 * chunks that race the snapshot are the last lines drawn, and what follows only repaints one row.
 */
async function lateJoin() {
  const ESC = String.fromCharCode(27);
  const terminal = fakeTerminal({ cols: 60, rows: 30 });
  const { runner, made } = runnerWithCheckpoints(terminal);
  const oracle = await ScreenEmulator.create({ cols: 60, rows: 30 });
  const handle = await runner.start(SPEC);
  const next = claudeLikeChunks({ seed: 11, size: 150, rows: 30 });
  const emit = (chunk) => {
    terminal.emit(chunk);
    void oracle.write(chunk);
  };
  const produce = (count) => { for (let i = 0; i < count; i += 1) emit(next()); };
  const resize = (cols, rows) => {
    assert.deepEqual(runner.resize(handle.id, cols, rows), { ok: true });
    oracle.term.write("", () => oracle.resize({ cols, rows }));
  };

  // MORE THAN THE REPLAY HOLDS, so a replay would be refused and only a checkpoint can be sound.
  produce(600);
  await tick();
  produce(20);
  resize(44, 28);          // queued behind unparsed bytes: the ordering hazard
  produce(20);
  emit(`\r\n${ESC}[3`);      // the subscriber joins with the parser inside an escape sequence
  const checkpoint = made[0];
  const lagAtJoin = checkpoint.lag;
  const replayWouldBeSound = baselineIsSound(runner.streamMeta(handle.id), false);

  const { events, handlers } = recorder();
  const stop = runner.subscribeScreen(handle.id, handlers);
  // RACING THE SNAPSHOT: none of this can have been parsed when the subscriber asked.
  emit("1mjoined here\r\n");
  produce(2);
  resize(50, 29);
  produce(3);
  // STILL PRODUCING while the snapshot is outstanding, as a spinner does: one row, repainted.
  for (let spin = 0; !events.length; spin += 1) {
    emit(`\r${ESC}[2Kthinking ${spin}`);
    await new Promise((r) => setTimeout(r, 2));
  }
  emit("\r\nlive after the checkpoint");
  await quiet(checkpoint);
  await new Promise((r) => oracle.term.write("", r));
  return { runner, handle, checkpoint, oracle, events, stop, lagAtJoin, replayWouldBeSound };
}

test("A LATE SUBSCRIBER'S SCREEN MATCHES THE DAEMON'S, cell for cell, while output keeps flowing", async () => {
  const run = await lateJoin();
  try {
    assert.equal(run.replayWouldBeSound, false, "the replay was sound anyway, so the checkpoint was not needed");
    assert.ok(run.lagAtJoin > 0, "the emulator had caught up when the subscriber joined, so the race was not exercised");
    assert.equal(run.events[0].meta.checkpoint, true, "the subscriber was not handed a checkpoint");
    assert.ok(run.events.some((e) => e.kind === "resize"), "no resize raced the snapshot, so held resizes were not tested");
    assert.ok(run.events.filter((e) => e.kind === "output").length > 5, "no live bytes followed the checkpoint");

    const client = await rebuild(run.events);
    assert.deepEqual(client.rows(), run.checkpoint.screen.rows(), "the subscriber's screen differs from the daemon's");
    assert.deepEqual(run.checkpoint.screen.rows(), run.oracle.rows(), "the daemon's screen differs from the whole history");
    assert.ok(client.rows().some((row) => /ed here/.test(row)), `the raced chunks are not on screen, so equality proves nothing about them: ${client.rows().join("\n")}`);
  } finally {
    run.stop();
    await run.runner.stop(run.handle.id);
  }
});

test("NEGATIVE CONTROL: the comparison detects one live chunk missing, or one delivered twice", async () => {
  const run = await lateJoin();
  try {
    const daemon = run.checkpoint.screen.rows();
    // The first chunk delivered after the screen itself: one that raced the snapshot.
    const raced = run.events.findIndex((e, i) => i > 1 && e.kind === "output");
    assert.equal(run.events[1].kind, "output", "the checkpointed screen was not the first output");
    assert.ok(raced > 1, "nothing followed the checkpoint, so there is nothing to drop");

    const gap = run.events.filter((_, i) => i !== raced);
    assert.notDeepEqual((await rebuild(gap)).rows(), daemon, "a missing chunk went unnoticed");

    const twice = [...run.events.slice(0, raced + 1), run.events[raced], ...run.events.slice(raced + 1)];
    assert.notDeepEqual((await rebuild(twice)).rows(), daemon, "a duplicated chunk went unnoticed");
  } finally {
    run.stop();
    await run.runner.stop(run.handle.id);
  }
});

test("A RESIZE BEFORE THE FIRST BYTE IS PARSED IS APPLIED AFTER THOSE BYTES, not ahead of them", async () => {
  // The measured case from `screen-emulator.test.js`: text at column 61 of an 80-column screen, then a
  // resize to 40. Applied in order, the row reflows away; applied first, an `O` survives at column 40.
  const terminal = fakeTerminal({ cols: 80, rows: 5 });
  const { runner, made } = runnerWithCheckpoints(terminal);
  const handle = await runner.start(SPEC);
  const oracle = await ScreenEmulator.create({ cols: 80, rows: 5 });
  const ESC = String.fromCharCode(27);
  const text = `${ESC}[1;61HOLD`;
  terminal.emit(text);
  runner.resize(handle.id, 40, 5);
  await oracle.write(text);
  oracle.resize({ cols: 40, rows: 5 });
  await quiet(made[0]);
  assert.deepEqual(made[0].screen.rows(), oracle.rows());
  await runner.stop(handle.id);
});

test("THE CHECKPOINT IS DISPOSED WHEN THE PROCESS EXITS, and a later subscriber gets the replay", async () => {
  const terminal = fakeTerminal({ cols: 40, rows: 6 });
  let exit;
  terminal.onExit = (fn) => { exit = fn; };
  const { runner, made } = runnerWithCheckpoints(terminal);
  const handle = await runner.start(SPEC);
  terminal.emit("last words");
  exit({ exitCode: 0 });
  assert.equal(made[0].screen.disposed, true, "the emulator outlived its process");
  const { events, handlers } = recorder();
  runner.subscribeScreen(handle.id, handlers);
  await tick();
  assert.equal(events[0].meta.checkpoint, undefined);
  assert.equal(events[1].text, "last words");
  assert.equal(events.at(-1).kind, "exit");
  await runner.stop(handle.id);
});

test("A PROCESS THAT GOES QUIET INSIDE AN ESCAPE SEQUENCE STILL ANSWERS: the replay, after a bounded wait", async () => {
  // No clean boundary will ever come, so no checkpoint can be taken. Waiting for ever would hold the
  // subscriber with no meta and no bytes, which reads as a hung agent.
  const terminal = fakeTerminal({ cols: 40, rows: 6 });
  const { runner } = runnerWithCheckpoints(terminal);
  const handle = await runner.start(SPEC);
  const ESC = String.fromCharCode(27);
  terminal.emit(`before${ESC}[3`);
  const { events, handlers } = recorder();
  runner.subscribeScreen(handle.id, handlers);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(events[0]?.kind, "meta", "the subscriber was never answered");
  assert.equal(events[0].meta.checkpoint, undefined, "a checkpoint was taken mid-sequence");
  assert.equal(events[1].text, `before${ESC}[3`);
  await runner.stop(handle.id);
});

/** Subscribe, and resolve with what the subscriber was handed once it has been answered. */
async function joinAfter(runner, id, ms = 0) {
  const { events, handlers } = recorder();
  runner.subscribeScreen(id, handlers);
  const deadline = Date.now() + 3000;
  if (ms) await new Promise((r) => setTimeout(r, ms));
  while (!events.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  return events;
}

test("A SCROLL REGION OR A SHIFTED CHARSET IS NOT A CLEAN BOUNDARY: the serializer carries neither", async () => {
  // Replaying the bytes after a snapshot through a screen with no margins, or no line-drawing set,
  // draws a different screen than the daemon's. So a snapshot waits for them to be put back.
  const ESC = String.fromCharCode(27);
  for (const [label, set, reset] of [
    ["scroll margins", `${ESC}[2;5r`, `${ESC}[r`],
    ["line-drawing G0", `${ESC}(0`, `${ESC}(B`],
    ["shifted to G1", String.fromCharCode(14), String.fromCharCode(15)],
  ]) {
    const terminal = fakeTerminal({ cols: 40, rows: 8 });
    const { runner } = runnerWithCheckpoints(terminal);
    const handle = await runner.start(SPEC);
    terminal.emit(`before${set}`);
    const refused = await joinAfter(runner, handle.id, 1200);
    assert.equal(refused[0]?.kind, "meta", `${label}: the subscriber was never answered`);
    assert.equal(refused[0].meta.checkpoint, undefined, `${label}: a checkpoint was taken with it set`);
    // CONTROL: put back, the same checkpoint answers again -- so the refusal was that mode and nothing else.
    terminal.emit(`${reset}after`);
    const accepted = await joinAfter(runner, handle.id);
    assert.equal(accepted[0].meta.checkpoint, true, `${label}: no checkpoint once it was reset`);
    await runner.stop(handle.id);
  }
});

test("A SCREEN TOO BIG TO HOLD LETS THE CHECKPOINT GO: one resize must not cost the daemon a gigabyte", async () => {
  const terminal = fakeTerminal({ cols: 40, rows: 8 });
  const { runner, made } = runnerWithCheckpoints(terminal);
  const handle = await runner.start(SPEC);
  terminal.emit("hello");
  // CONTROL: an ordinary resize keeps it.
  assert.deepEqual(runner.resize(handle.id, 200, 60), { ok: true });
  assert.equal((await joinAfter(runner, handle.id))[0].meta.checkpoint, true);
  assert.deepEqual(runner.resize(handle.id, 10_000, 10_000), { ok: true });
  assert.equal(made[0].screen.disposed, true, "the checkpoint kept a 10,000 x 10,000 screen");
  const events = await joinAfter(runner, handle.id);
  assert.equal(events[0].meta.checkpoint, undefined);
  assert.equal(events[1].text, "hello");
  await runner.stop(handle.id);
});

test("A PROCESS THAT EXITS WHILE A SNAPSHOT IS OUTSTANDING: the subscriber gets the replay and the exit", async () => {
  const terminal = fakeTerminal({ cols: 40, rows: 6 });
  let exit;
  terminal.onExit = (fn) => { exit = fn; };
  const { runner } = runnerWithCheckpoints(terminal);
  const handle = await runner.start(SPEC);
  const ESC = String.fromCharCode(27);
  terminal.emit(`last${ESC}[3`);
  const { events, handlers } = recorder();
  runner.subscribeScreen(handle.id, handlers);
  exit({ exitCode: 3 });
  await tick();
  await tick();
  assert.deepEqual(events.map((e) => e.kind), ["meta", "output", "exit"]);
  assert.equal(events[0].meta.checkpoint, undefined);
  await runner.stop(handle.id);
});

test("WITHOUT A CHECKPOINT, A SUBSCRIBER GETS EXACTLY TODAY'S META AND REPLAY", async () => {
  for (const loadCheckpoint of [null, async () => null]) {
    const terminal = fakeTerminal({ cols: 50, rows: 8 });
    const runner = new Runner({ openTerminal: () => terminal, loadCheckpoint, replayBytes: 16 });
    const handle = await runner.start(SPEC);
    terminal.emit("0123456789abcdefGHIJ");
    const { events, handlers } = recorder();
    runner.subscribeScreen(handle.id, handlers);
    terminal.emit("live");
    assert.deepEqual(events, [
      { kind: "meta", meta: runner.streamMeta(handle.id) },
      { kind: "output", text: "456789abcdefGHIJ" },
      { kind: "output", text: "live" },
    ]);
    await runner.stop(handle.id);
  }
});

test("A PIPED PROCESS GETS NO CHECKPOINT: it has no screen", async () => {
  const { runner, made } = runnerWithCheckpoints(null, { openTerminal: null });
  const handle = await runner.start({ ...SPEC, command: process.execPath, args: ["-e", "process.stdout.write('piped')"] });
  await handle.exited;
  assert.equal(made.length, 0);
  await runner.stop(handle.id);
});

test("THE WIRE CARRIES checkpoint, and only a literal true is one", () => {
  const parse = (payload) => readFrames("", namedFrame("meta", payload)).frames[0];
  const base = { cols: 80, rows: 24, truncated: true, resized: true, replayBytes: 65536 };
  assert.equal(parse({ ...base, checkpoint: true }).checkpoint, true);
  for (const value of [undefined, "true", 1, null]) {
    assert.equal(parse({ ...base, checkpoint: value }).checkpoint, false, `${JSON.stringify(value)} was read as a checkpoint`);
  }
});

test("A CHECKPOINT IS A SOUND BASELINE whatever the retained replay was", () => {
  assert.equal(baselineIsSound({ truncated: true, resized: true, checkpoint: true }, false), true);
  assert.equal(baselineIsSound({ truncated: true, resized: true, checkpoint: false }, false), false);
});

// ── the ABSENT arms, in a child process where a package genuinely cannot be resolved ─────────────

test("PHYSICAL ABSENCE: with any of the three packages missing there is no checkpoint factory", () => {
  const PACKAGES = ["@xterm/headless", "@xterm/addon-unicode11", "@xterm/addon-serialize"];
  const probe = (installed) => {
    const dir = mkdtempSync(path.join(tmpdir(), "aify-env-checkpoint-absent-"));
    for (const name of ["screen-checkpoint.mjs", "screen-emulator.mjs", "screen-style.mjs"]) {
      copyFileSync(path.join(HERE, "..", "lib", name), path.join(dir, name));
    }
    mkdirSync(path.join(dir, "node_modules", "@xterm"), { recursive: true });
    for (const name of installed) {
      symlinkSync(path.join(HERE, "..", "node_modules", name), path.join(dir, "node_modules", name), "junction");
    }
    const url = pathToFileURL(path.join(dir, "screen-checkpoint.mjs")).href;
    const script = `import("${url}").then(async (m) => console.log(typeof await m.loadCheckpointFactory()))`
      + `.catch((e) => console.log("threw " + e.message));`;
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, encoding: "utf8" }).trim();
  };
  // THE CONTROL: all three linked in resolves a factory, so the arms below fail for absence alone.
  assert.equal(probe(PACKAGES), "function", "the probe cannot find packages it was given");
  for (const missing of PACKAGES) {
    assert.equal(probe(PACKAGES.filter((name) => name !== missing)), "object", `a checkpoint was offered without ${missing}`);
  }
});
