#!/usr/bin/env node
// Prove a REAL terminal works, in a process that is allowed to die of its own accord.
//
// Run by tests/pty-real.test.js rather than imported by it, and that is not fussiness. A node-pty
// child on Windows leaves a PipeWrap behind after it exits, so any process that spawns one never
// exits by itself. Import this into a test file and the whole file hangs — which is exactly what
// happened here the moment node-pty was installed, after eleven green tests that had only ever
// exercised the fallback.
//
// So: do the real thing, print a verdict, and exit explicitly. The explicit exit is the point, not a
// shortcut around one.

import { Runner, terminalSupport } from "../lib/runner.mjs";

const support = terminalSupport();
if (!support.available) {
  // Not a pass. The caller decides what to do about a host that cannot answer this.
  process.stdout.write(`${JSON.stringify({ ran: false, reason: support.reason })}\n`);
  process.exit(3);
}

const runner = new Runner();
const chunks = [];

const handle = await runner.start({
  service: "pty-smoke",
  fileText: 'HARNESS_WRAPPER_VERSION="0.6.0"',
  command: process.execPath,
  args: ["-e", "process.stdout.write('REAL-PTY-OUTPUT')"],
});

handle.onOutput((chunk) => chunks.push(chunk));
await handle.exited;

process.stdout.write(`${JSON.stringify({
  ran: true,
  terminal: handle.terminal,
  pid: handle.pid,
  output: chunks.join(""),
  ownedAfterExit: runner.list().length,
})}\n`);

// Explicit, because the handle node-pty leaves would otherwise keep this alive forever.
process.exit(0);
