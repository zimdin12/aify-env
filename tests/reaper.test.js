#!/usr/bin/env node
// Forgetting processes that are gone, on evidence rather than on notification.
//
// The rule here was paid for: a spawn once sat "running" for 97 minutes because the single function
// that marks a terminal dead is one of about twenty-six writers and was simply never called on that
// path. Cleanup that must hold for ALL paths keys on the observed state, never on an event having
// fired. So the reaper does not wait to be told; it looks.
//
// The second rule is the one that stops a reaper becoming the incident. "I could not tell whether this
// pid is alive" is not "it is dead". Reaping on no evidence loses track of a live process, which is
// strictly worse than the leak it was trying to fix — so unknown entries are KEPT and COUNTED, and a
// count that stays above zero is something doctor can surface rather than something nobody sees.

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyProcesses, Reaper } from "../lib/reaper.mjs";
import { ProcessRegistry } from "../lib/process-registry.mjs";

const entry = (id, pid) => ({ id, pid, service: "s", terminal: false });

test("a pid that is not alive is DEAD", () => {
  const result = classifyProcesses([entry("a", 10)], () => false);
  assert.deepEqual(result.dead.map((e) => e.id), ["a"]);
  assert.deepEqual(result.alive, []);
  assert.deepEqual(result.unknown, []);
});

test("a pid that is alive is kept", () => {
  const result = classifyProcesses([entry("a", 10)], () => true);
  assert.deepEqual(result.alive.map((e) => e.id), ["a"]);
  assert.deepEqual(result.dead, []);
});

test("a probe that THROWS makes the entry UNKNOWN, never dead", () => {
  // The whole safety property. Treating "could not tell" as dead loses a live process from the one
  // place that is supposed to know about it, which is worse than the leak.
  const result = classifyProcesses([entry("a", 10)], () => { throw new Error("EPERM"); });
  assert.deepEqual(result.unknown.map((e) => e.id), ["a"]);
  assert.deepEqual(result.dead, []);
});

test("a probe returning something that is not a boolean is UNKNOWN", () => {
  for (const answer of [undefined, null, "yes", 1]) {
    const result = classifyProcesses([entry("a", 10)], () => answer);
    assert.deepEqual(result.dead, [], `${JSON.stringify(answer)} must not read as dead`);
    assert.deepEqual(result.unknown.map((e) => e.id), ["a"]);
  }
});

test("an entry with no usable pid is UNKNOWN, not dead", () => {
  for (const pid of [0, -1, null, undefined, NaN]) {
    const result = classifyProcesses([{ id: "a", pid, service: "s" }], () => false);
    assert.deepEqual(result.dead, [], `pid ${String(pid)} must not read as dead`);
  }
});

test("a mixed set is split three ways in one pass", () => {
  const alive = new Set([11]);
  const result = classifyProcesses(
    [entry("a", 11), entry("b", 12), entry("c", 13)],
    (pid) => { if (pid === 13) throw new Error("EPERM"); return alive.has(pid); },
  );
  assert.deepEqual(result.alive.map((e) => e.id), ["a"]);
  assert.deepEqual(result.dead.map((e) => e.id), ["b"]);
  assert.deepEqual(result.unknown.map((e) => e.id), ["c"]);
});

// ── the reaper over a real registry ──────────────────────────────────────────────

test("a process that died without anyone calling stop() is still forgotten", () => {
  // The 97-minute bug, in miniature: nothing fired, nobody was told, and the registry must still
  // converge on the truth.
  const registry = new ProcessRegistry();
  const dead = registry.add({ service: "s", pid: 999 });
  const reaper = new Reaper({ registry, isAlive: () => false });

  const swept = reaper.sweep();
  assert.deepEqual(swept.reaped, [dead.id]);
  assert.deepEqual(registry.list(), []);
});

test("a live process is left alone", () => {
  const registry = new ProcessRegistry();
  registry.add({ service: "s", pid: process.pid });
  const reaper = new Reaper({ registry, isAlive: () => true });
  reaper.sweep();
  assert.equal(registry.size, 1);
});

test("an UNKNOWN entry is kept and reported, not reaped", () => {
  const registry = new ProcessRegistry();
  registry.add({ service: "s", pid: 12345 });
  const reaper = new Reaper({ registry, isAlive: () => { throw new Error("EPERM"); } });

  const swept = reaper.sweep();
  assert.deepEqual(swept.reaped, []);
  assert.equal(swept.unknown.length, 1, "an unanswerable entry must be surfaced, not silently kept");
  assert.equal(registry.size, 1);
});

test("sweeping twice is safe and reaps nothing the second time", () => {
  const registry = new ProcessRegistry();
  registry.add({ service: "s", pid: 999 });
  const reaper = new Reaper({ registry, isAlive: () => false });
  assert.equal(reaper.sweep().reaped.length, 1);
  assert.equal(reaper.sweep().reaped.length, 0);
});

test("POSITIVE CONTROL: the default probe says THIS process is alive", () => {
  // Every case above injects an answer. If the real probe were broken — always throwing, always
  // false — all of them would still pass while the live reaper either reaped everything or nothing.
  const registry = new ProcessRegistry();
  registry.add({ service: "s", pid: process.pid });
  const reaper = new Reaper({ registry });
  assert.deepEqual(reaper.sweep().reaped, [], "the default probe called this very process dead");
});

test("NEGATIVE CONTROL: the default probe says an impossible pid is not alive", () => {
  // And it must be able to say no, or the control above proves only that it always says yes.
  const registry = new ProcessRegistry();
  const gone = registry.add({ service: "s", pid: 0x7ffffffe });
  const reaper = new Reaper({ registry });
  assert.deepEqual(reaper.sweep().reaped, [gone.id], "the default probe cannot detect a dead pid");
});
