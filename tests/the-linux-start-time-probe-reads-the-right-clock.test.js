#!/usr/bin/env node
// The reaper's Linux start-time probe, tested against real procfs text.
//
// R9-M7, external review 2026-09-06. `processStartedAt` read `statSync('/proc/<pid>').ctimeMs` and
// called it "the DIRECTORY's creation, which is the process's". procfs does not stamp its inodes
// that way: the reviewer measured pid 1's ctime as 440,701 SECONDS before the machine's own boot
// time. So the comparison against START_TIME_TOLERANCE_MS could never hold, the probe fails SAFE,
// and a reused pid was never refused -- orphans leaked with nothing reported.
//
// AND NOTHING TESTED IT. Every reaper test injects `startedAtOf`, so six of them passed while the
// real probe was wrong. That is the shape this repo keeps meeting: the seam is covered and the thing
// behind it is not.
//
// The fix makes the probe a PURE parser over the two files it needs, so it runs on any platform
// rather than only on the one it is for. The fixtures below are real `/proc` text.

import assert from "node:assert/strict";
import test from "node:test";

import { LINUX_USER_HZ, linuxProcessStartedAt } from "../lib/orphan-reap.mjs";

const LF = String.fromCharCode(10);

/** A real `/proc/<pid>/stat` line. Fields after `)` are state, ppid, ... with starttime 22nd overall. */
function statLine({ comm = "node", startTicks = 0 } = {}) {
  const after = [
    "S", "1", "1", "0", "-1", "4194560", "1234", "0", "0", "0",   // fields 3-12
    "10", "5", "0", "0", "20", "0", "12", "0",                     // 13-20
    String(startTicks),                                            // 21? -> see below
  ];
  // Field 22 is `starttime`. After the closing paren the first token is field 3, so starttime must
  // land at index 19. The array above places it at index 18, so pad one to keep the numbering honest
  // rather than fudging the parser.
  after.splice(18, 0, "0");
  return `4242 (${comm}) ${after.join(" ")} 0 0 0${LF}`;
}

const bootStat = (btime) => [
  "cpu  1 2 3 4 5 6 7 8 9 0",
  "intr 12345",
  "ctxt 67890",
  `btime ${btime}`,
  "processes 4321",
  "",
].join(LF);

function reader({ stat, boot }) {
  return (path) => {
    if (String(path).endsWith("/stat") && String(path).startsWith("/proc/4242")) return stat;
    if (String(path) === "/proc/stat") return boot;
    throw new Error(`unexpected read: ${path}`);
  };
}

test("POSITIVE CONTROL: the fixture really does put starttime in field 22", () => {
  // If the fixture mis-numbered the fields, every assertion below would be about the wrong number and
  // would still pass consistently. Count them the way the kernel does.
  const line = statLine({ startTicks: 777 });
  const close = line.lastIndexOf(")");
  const fields = line.slice(close + 1).trim().split(/\s+/);
  assert.equal(fields[19], "777", `starttime is not at index 19; fields were ${JSON.stringify(fields)}`);
});

test("the start time is boot time plus starttime ticks", () => {
  const btime = 1_700_000_000;
  const at = linuxProcessStartedAt(4242, reader({
    stat: statLine({ startTicks: 500 }),
    boot: bootStat(btime),
  }));
  assert.equal(at, (btime + 500 / LINUX_USER_HZ) * 1000);
});

test("A COMM CONTAINING SPACES AND PARENS DOES NOT SHIFT THE FIELDS", () => {
  // The trap that makes a naive whitespace split wrong. A process can be named anything, and the
  // kernel does not escape it -- `(a b) c)` is a legal comm.
  const at = linuxProcessStartedAt(4242, reader({
    stat: statLine({ comm: "my (weird) proc", startTicks: 900 }),
    boot: bootStat(1_700_000_000),
  }));
  assert.equal(at, (1_700_000_000 + 9) * 1000, "the comm field shifted the parse");
});

test("A START TIME IS AFTER BOOT, WHICH IS THE PROPERTY THE OLD PROBE FAILED", () => {
  // The measured symptom: pid 1's ctime read 440,701 seconds BEFORE btime. Whatever this returns has
  // to be at or after the boot it is measured from, or the tolerance comparison is meaningless.
  const btime = 1_700_000_000;
  for (const ticks of [0, 1, 100, 10_000, 8_640_000]) {
    const at = linuxProcessStartedAt(4242, reader({ stat: statLine({ startTicks: ticks }), boot: bootStat(btime) }));
    assert.ok(at >= btime * 1000, `starttime ${ticks} produced ${at}, before boot at ${btime * 1000}`);
  }
});

test("an unreadable or malformed source answers null rather than a wrong number", () => {
  // The probe fails safe by design; what matters is that it says so instead of inventing a time.
  const throwing = () => { throw new Error("ENOENT"); };
  assert.equal(linuxProcessStartedAt(4242, throwing), null);
  assert.equal(linuxProcessStartedAt(4242, reader({ stat: "no parens here", boot: bootStat(1) })), null);
  assert.equal(
    linuxProcessStartedAt(4242, reader({ stat: statLine({ startTicks: 1 }), boot: "cpu 1 2 3" })),
    null,
    "a /proc/stat with no btime line cannot date anything",
  );
});
