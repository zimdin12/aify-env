#!/usr/bin/env node
// This host gets ONE kind and ONE machine id, whatever launched the process.
//
// THE DEFECT THIS PINS. `bin/aify-env.mjs` advertised `isWsl: kind === "wsl"`, and `environmentKind`
// derived WSL from `WSL_DISTRO_NAME`. That variable is present in interactive shells and absent in
// many child processes, so a WSL host that did not inherit it advertised `linux:<host>` -- while the
// aify-comms bridge on the SAME machine advertised `wsl:<host>`, because its `stablePlatformTag`
// reads /proc. aify-comms stopped trusting the variable on 2026-06-02, after one host registered
// under both spellings and a delivery loop could never claim runs for an agent recorded as the
// other. The two consumers here are the fields where that costs something: `machineId`, which the
// service arbitrates bridge supersession on, and `kind`, which the service joins into the
// environment id.
//
// WHY THE FILE SIGNAL SITS BELOW THE CONTAINER CHECK. A docker container running ON WSL2 reads
// "microsoft" in /proc/sys/kernel/osrelease as well -- it is the WSL2 kernel. Letting it speak
// earlier would relabel every such container `wsl`. The contradiction arm at the end is the only
// test here that notices if that ordering is changed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { hostIsWsl } from "../lib/host-wsl.mjs";
import { environmentKind, hostIdentityFacts, machineIdFor } from "../lib/advertise.mjs";

const reads = (text) => () => text;
const unreadable = () => { throw new Error("ENOENT"); };

test("the probe says YES on a WSL kernel", () => {
  assert.equal(hostIsWsl({ platform: "linux", readFile: reads("5.15.0-microsoft-standard-WSL2") }), true);
});

test("the probe says NO on an ordinary linux kernel", () => {
  // NEGATIVE CONTROL. A probe that cannot return false cannot return true either.
  assert.equal(hostIsWsl({ platform: "linux", readFile: reads("6.1.0-generic") }), false);
});

test("the probe is platform-gated", () => {
  assert.equal(hostIsWsl({ platform: "win32", readFile: reads("microsoft") }), false);
  assert.equal(hostIsWsl({ platform: "darwin", readFile: reads("microsoft") }), false);
});

test("an unreadable /proc fails CLOSED", () => {
  assert.equal(hostIsWsl({ platform: "linux", readFile: unreadable }), false);
});

test("THE REGRESSION: a WSL host with no WSL_DISTRO_NAME is `wsl`, not `linux`", () => {
  assert.equal(environmentKind({ platform: "linux", env: {}, isWsl: true }), "wsl");
});

test("without the probe that same host is `linux`, which is what shipped", () => {
  // The before-state, kept so the regression above is a comparison rather than an assertion.
  assert.equal(environmentKind({ platform: "linux", env: {}, isWsl: false }), "linux");
});

test("the variable still answers on its own", () => {
  assert.equal(environmentKind({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, isWsl: false }), "wsl");
});

test("an explicit kind still wins outright", () => {
  assert.equal(
    environmentKind({ platform: "linux", env: { AIFY_ENVIRONMENT_KIND: "custom" }, isWsl: true }),
    "custom");
});

test("WSL still beats container, which is a declared precedence", () => {
  assert.equal(
    environmentKind({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu", container: "podman" }, isWsl: true }),
    "wsl");
});

test("CONTRADICTION ARM: a docker container running ON WSL2 stays `docker`", () => {
  assert.equal(environmentKind({ platform: "linux", env: { container: "podman" }, isWsl: true }), "docker");
  assert.equal(
    environmentKind({ platform: "linux", env: {}, exists: (f) => f === "/.dockerenv", isWsl: true }),
    "docker");
});

test("the machine id follows the same probe, so kind and id cannot disagree", () => {
  // The pairing is the point: these two were computed from ONE derived boolean, and the derivation
  // was the broken half. Posed the same input they must land on the same tag.
  assert.equal(machineIdFor({ platform: "linux", hostname: "StevenZ-L", isWsl: true }), "wsl:stevenz-l");
  assert.equal(environmentKind({ platform: "linux", env: {}, isWsl: true }), "wsl");
  assert.notEqual(
    machineIdFor({ platform: "linux", hostname: "StevenZ-L", isWsl: true }),
    machineIdFor({ platform: "linux", hostname: "StevenZ-L", isWsl: false }),
    "the machine id stopped depending on the probe at all",
  );
});

// -- the three facts, from one probe ------------------------------------------------------------

test("hostIdentityFacts answers kind, os and machineId from ONE isWsl", () => {
  const facts = hostIdentityFacts({
    platform: "linux", hostname: "StevenZ-L", env: {}, isWsl: true,
  });
  assert.deepEqual(facts, { kind: "wsl", os: "linux", machineId: "wsl:stevenz-l" });
});

test("THE OLD SHAPE IS UNAVAILABLE: kind and machineId cannot disagree about WSL", () => {
  // The defect was `isWsl: kind === "wsl"` at the call site -- two fields, one derived from the
  // other, so a wrong kind silently produced a wrong machine id. Taking the probe once means the
  // only way to get an inconsistent pair is to call this twice with different inputs.
  for (const isWsl of [true, false]) {
    const { kind, machineId } = hostIdentityFacts({
      platform: "linux", hostname: "box", env: {}, isWsl,
    });
    assert.equal(
      kind === "wsl", machineId.startsWith("wsl:"),
      `isWsl=${isWsl} produced kind=${kind} with machineId=${machineId}`,
    );
  }
});

test("kind and os stay different questions here too", () => {
  // A WSL host RUNS linux. Reporting `os: "wsl"` would name a kind as an operating system.
  const facts = hostIdentityFacts({ platform: "linux", hostname: "box", env: {}, isWsl: true });
  assert.equal(facts.kind, "wsl");
  assert.equal(facts.os, "linux");
});

test("it carries the precedences rather than re-deciding them", () => {
  // Same answers as environmentKind, because it calls it. Asserted so a future inline copy fails.
  assert.equal(
    hostIdentityFacts({ platform: "linux", hostname: "b", env: { container: "podman" }, isWsl: true }).kind,
    environmentKind({ platform: "linux", env: { container: "podman" }, isWsl: true }));
  assert.equal(
    hostIdentityFacts({
      platform: "linux", hostname: "b", env: { AIFY_ENVIRONMENT_KIND: "custom" }, isWsl: true,
    }).kind,
    "custom");
});

test("a host with nothing set still gets a usable id shape", () => {
  // NEGATIVE-ISH CONTROL: the non-WSL path must still produce a <tag>:<host> pair, not an empty tag.
  const facts = hostIdentityFacts({ platform: "win32", hostname: "StevenZ-L", env: {}, isWsl: false });
  assert.equal(facts.kind, "windows");
  assert.equal(facts.machineId, "win32:stevenz-l");
});
