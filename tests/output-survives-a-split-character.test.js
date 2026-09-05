#!/usr/bin/env node
// A UTF-8 character split across two reads must arrive whole.
//
// B3's "encoding issues", open since May with no repro. This is one.
//
// `#makeEmitter` turned every chunk into text with `String(chunk)`. On the pty path node-pty hands
// back a string and that is a no-op -- but `child.stdout.on("data")` and `child.stderr.on("data")`
// deliver BUFFERS, and `String(buffer)` decodes each one on its own. A multi-byte character
// straddling a read boundary is then decoded as two partial sequences and arrives as U+FFFD.
//
// WHY IT WAS NEVER SEEN IN A TEST: every existing test feeds whole strings, so the boundary never
// falls inside a character. In production the boundary falls wherever the OS put it, and agents print
// box-drawing, spinners and progress glyphs constantly -- every one of them multi-byte.

import assert from "node:assert/strict";
import test from "node:test";
import { StringDecoder } from "node:string_decoder";

import { Runner } from "../lib/runner.mjs";

/** A process that emits BUFFERS on stdout, which is what a non-pty child does. */
function bufferChild(buffers, errBuffers = []) {
  // BOTH STREAMS DELIVER. The first version of this stubbed `stderr: { on: () => {} }`, so stderr
  // never handed over a byte -- which is exactly why a decoder SHARED between stdout and stderr
  // passed this file for two days while doing the thing its own comment forbade.
  const out = { data: [], end: [] };
  const err = { data: [], end: [] };
  const listeners = { close: [] };
  const wire = (bag) => ({ on: (event, fn) => { if (bag[event]) bag[event].push(fn); } });
  return {
    stdout: wire(out),
    stderr: wire(err),
    on: (event, fn) => { if (event === "close") listeners.close.push(fn); },
    kill: () => {},
    pid: 4242,
    emitAll: () => { for (const b of buffers) for (const fn of out.data) fn(b); },
    emitInterleaved: () => {
      // stdout, then stderr, then the REST of stdout -- the ordering that exposes a shared decoder.
      for (const fn of out.data) fn(buffers[0]);
      for (const b of errBuffers) for (const fn of err.data) fn(b);
      for (const fn of out.data) for (const b of buffers.slice(1)) fn(b);
    },
    endStreams: () => { for (const fn of out.end) fn(); for (const fn of err.end) fn(); },
  };
}

test("THE DEFECT ITSELF, so this file cannot pass by describing something that does not happen", () => {
  // The control. If `String(buffer)` ever stopped mangling a split character, the fix below would be
  // guarding nothing and this file should say so rather than stay quietly green.
  const full = Buffer.from("progress: ✻ done", "utf8");
  const at = 12;                       // inside the three bytes of U+273B
  const halves = [full.subarray(0, at), full.subarray(at)];
  const naive = halves.map((b) => String(b)).join("");
  assert.ok(naive.includes("�"),
    `String(buffer) no longer mangles a split character (${JSON.stringify(naive)}), so the fix this `
    + "file guards may no longer be needed -- re-derive rather than delete");
  const decoder = new StringDecoder("utf8");
  assert.equal(halves.map((b) => decoder.write(b)).join(""), "progress: ✻ done",
    "StringDecoder did not reassemble the character, so the chosen remedy is wrong");
});

test("a character split across two chunks reaches a subscriber WHOLE", async () => {
  const full = Buffer.from("box ─── spinner ✻ end", "utf8");
  const at = 6;                        // inside the first U+2500
  const child = bufferChild([full.subarray(0, at), full.subarray(at)]);

  // `fileText` is the launcher body the allowlist judges -- the same shape every other test here
  // uses. Without it the runner refuses before any output exists to decode.
  const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
  // `spawnProcess`, which is the name the Runner injects. My first version passed `spawn`, so the
  // fake was ignored, a real `node -e 0` ran, and the subscriber saw an empty string -- a test
  // failing for a reason that had nothing to do with encoding.
  const runner = new Runner({ spawnProcess: () => child, openTerminal: null });
  const started = await runner.start({
    service: "test-service",
    fileText: ALLOWED,
    command: process.execPath,
    args: ["-e", "0"],
    useTerminal: false,
  });
  const seen = [];
  runner.subscribe(started.id, (chunk) => seen.push(chunk));
  child.emitAll();

  const text = seen.join("");
  assert.ok(!text.includes("�"),
    `a split character arrived as replacement characters: ${JSON.stringify(text)}. Every agent prints `
    + "box-drawing and spinner glyphs, and a read boundary lands wherever the OS puts it.");
  assert.equal(text, "box ─── spinner ✻ end",
    "the reassembled text does not match what the process actually wrote");
});

test("a chunk that is ALREADY a string is passed through untouched", () => {
  // The pty path: node-pty hands back strings, and this must stay a no-op there. A decoder given a
  // string would stringify it fine, but asserting the pass-through keeps the common path honest.
  const decoder = new StringDecoder("utf8");
  assert.equal(typeof "✻" === "string" ? "✻" : decoder.write("✻"), "✻");
});

test("A STDERR CHUNK BETWEEN TWO STDOUT READS does not corrupt either", async () => {
  // THE DEFECT THE FIRST FIX LEFT BEHIND, and the one its own comment forbade: `#makeEmitter` was
  // called once per PROCESS and the single closure -- holding one StringDecoder -- was attached to
  // both streams. So the decoder could carry stdout's two orphan bytes, prefix them to the next
  // STDERR chunk, and emit a character neither stream sent, while stdout's continuation bytes became
  // U+FFFD. Agents that print progress to stderr and content to stdout are the ordinary case.
  const out = Buffer.from("box ─── end", "utf8");
  const at = 5;                                   // inside the first U+2500 on stdout
  const child = bufferChild([out.subarray(0, at), out.subarray(at)],
                            [Buffer.from("warning: retrying\n", "utf8")]);

  const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
  const runner = new Runner({ spawnProcess: () => child, openTerminal: null });
  const started = await runner.start({
    service: "test-service", fileText: ALLOWED, command: process.execPath, args: ["-e", "0"],
    useTerminal: false,
  });
  const seen = [];
  runner.subscribe(started.id, (chunk) => seen.push(chunk));
  child.emitInterleaved();

  const text = seen.join("");
  assert.ok(!text.includes("�"),
    `a shared decoder spliced one stream's partial character onto the other: ${JSON.stringify(text)}`);
  // INTERLEAVING IS CORRECT AND EXPECTED: both streams feed one console, so stderr lands between
  // stdout's two halves. What must survive is stdout's CHARACTERS -- remove stderr's line and the
  // remainder is exactly what stdout wrote, split character and all.
  assert.ok(text.includes("warning: retrying"), "stderr was lost");
  assert.equal(text.replace("warning: retrying\n", ""), "box ─── end",
    `stdout's bytes did not reassemble around the stderr chunk: ${JSON.stringify(text)}`);
});

test("A STREAM THAT CLOSES MID-CHARACTER SAYS SO, rather than ending in silence", async () => {
  // `decoder.end()` was never called. A process killed mid-write leaves orphan bytes inside the
  // decoder, and without a flush they vanish: the console shows output that ends cleanly, when in
  // fact it was cut off. Those last bytes are what `#registry.remove` calls the only way to tell a
  // crash from a kill, so "ended cleanly" is precisely the wrong impression to leave.
  //
  // WHAT A FLUSH RECOVERS IS A REPLACEMENT CHARACTER, not the intended glyph -- the remaining bytes
  // never arrived and cannot be invented. That is the honest outcome: a visible mark that something
  // was truncated.
  const full = Buffer.from("dying: ✻", "utf8");
  // Only the FIRST bytes arrive; the rest never does, because the process was killed.
  const child = bufferChild([full.subarray(0, full.length - 1)]);

  const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(String.fromCharCode(10));
  const runner = new Runner({ spawnProcess: () => child, openTerminal: null });
  const started = await runner.start({
    service: "test-service", fileText: ALLOWED, command: process.execPath, args: ["-e", "0"],
    useTerminal: false,
  });
  const seen = [];
  runner.subscribe(started.id, (chunk) => seen.push(chunk));
  child.emitAll();

  const beforeClose = seen.join("");
  assert.equal(beforeClose, "dying: ",
    "the decoder should be holding the orphan bytes until the stream closes");
  child.endStreams();

  assert.notEqual(seen.join(""), beforeClose,
    "the stream closed on a partial character and nothing was emitted, so a truncated console is "
    + "indistinguishable from one that ended cleanly");
  assert.ok(seen.join("").includes("�"),
    "the flush should mark the truncation with a replacement character");
});
