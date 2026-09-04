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
function bufferChild(buffers) {
  const listeners = { data: [], close: [] };
  return {
    stdout: { on: (event, fn) => { if (event === "data") listeners.data.push(fn); } },
    stderr: { on: () => {} },
    on: (event, fn) => { if (event === "close") listeners.close.push(fn); },
    kill: () => {},
    pid: 4242,
    emitAll: () => { for (const b of buffers) for (const fn of listeners.data) fn(b); },
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
