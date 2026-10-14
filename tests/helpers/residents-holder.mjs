// A real process contending for the residents role of a temp home, for the B1 tests. Never a daemon, never the real
// home: the aify home is the first argument and must be under the OS temp directory.
//
//   node residents-holder.mjs <aifyHome> role [pauseMs]
//       acquire; print {held, reason, generation}; with pauseMs, then block this process's event loop that long (a
//       paused holder) and print "resumed" with whether it still holds; then wait to be killed or for stdin to close.
//   node residents-holder.mjs <aifyHome> turn <agentId> <lifetime> <pid> <writtenAtUs> <firedAtUs>
//       hold the role as a daemon does (lib/daemon-residents.mjs), with an OS probe that verifies <pid>, apply one
//       turn-start at <firedAtUs> as the residents hook route would, print the outcome, then wait to be killed.
import os from "node:os";
import path from "node:path";

import { DaemonResidents } from "../../lib/daemon-residents.mjs";
import { ResidentsRole } from "../../lib/residents-role.mjs";

const [aifyHome, mode, ...rest] = process.argv.slice(2);
if (!path.resolve(aifyHome).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase())) {
  process.stdout.write(`${JSON.stringify({ refused: "not a temp home" })}\n`);
  process.exit(2);
}
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

if (mode === "role") {
  const role = new ResidentsRole({ aifyHome });
  const taken = await role.acquire();
  say({ ...taken, generation: role.generation });
  const pauseMs = Number(rest[0] || 0);
  if (pauseMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
    say({ resumed: true, holds: role.holds() });
  }
} else if (mode === "turn") {
  const [agentId, lifetime, pid, writtenAtUs, firedAtUs] = rest;
  const answer = { alive: true, createdAtUs: Number(writtenAtUs) - 1, commandLine: `node "${process.execPath}"` };
  const residents = new DaemonResidents({ aifyHome, url: "http://127.0.0.1:1", pid: process.pid,
    probe: (pids) => new Map(pids.map((p) => [p, p === Number(pid) ? answer : { alive: false, createdAtUs: null, commandLine: null }])),
    nowUs: () => Number(firedAtUs) + 1000 });
  const held = await residents.acquire();
  const entered = residents.enter();
  const applied = entered ? entered.host.applyEvent({ agentId, lifetime, kind: "turn-start", firedAtUs: Number(firedAtUs) },
    { guard: entered.op.guard }) : null;
  entered?.op.done();
  say({ held, generation: residents.report().generation, applied });
}
