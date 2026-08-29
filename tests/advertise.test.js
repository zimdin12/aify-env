// The advertisement is built from host facts, and says nothing about the service that receives it.
//
// Every function here is pure with its inputs handed in, so these run with no network, no clock and
// no filesystem -- the property `services.mjs` already buys by injecting its health knock.

import assert from "node:assert/strict";
import test from "node:test";

import {
  advertiseTo,
  advertisementTargets,
  capabilityFingerprint,
  environmentAdvertisement,
  environmentKind,
  environmentOs,
  installedHarnesses,
  machineIdFor,
  runtimeAvailability,
  shouldRedetect,
} from "../lib/advertise.mjs";

// ── what this host IS ────────────────────────────────────────────────────────────────────────

test("kind is read from the host, in the order the bridge reads it", () => {
  assert.equal(environmentKind({ platform: "linux", env: { AIFY_ENVIRONMENT_KIND: "custom" } }), "custom");
  assert.equal(environmentKind({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }), "wsl");
  assert.equal(environmentKind({ platform: "linux", env: { container: "podman" } }), "docker");
  assert.equal(environmentKind({ platform: "linux", env: {}, exists: (p) => p === "/.dockerenv" }), "docker");
  assert.equal(environmentKind({ platform: "win32", env: {} }), "windows");
  assert.equal(environmentKind({ platform: "darwin", env: {} }), "macos");
  assert.equal(environmentKind({ platform: "linux", env: {} }), "linux");
});

test("kind and os are DIFFERENT questions, and wsl is where that shows", () => {
  // A wsl host runs linux. Collapsing the two would advertise `os: wsl`, which is not an operating
  // system, and `kind: linux`, which loses the only thing that distinguishes the host.
  const env = { WSL_DISTRO_NAME: "Ubuntu" };
  assert.equal(environmentKind({ platform: "linux", env }), "wsl");
  assert.equal(environmentOs("linux"), "linux");
  assert.equal(environmentOs("win32"), "windows");
  assert.equal(environmentOs("darwin"), "macos");
});

// ── what this host CAN RUN ───────────────────────────────────────────────────────────────────

test("availability carries the reason, and an unfound runtime is not dropped", () => {
  const rows = runtimeAvailability([
    { client: "hermes", command: "hermes", found: false, path: null },
    { client: "claude", command: "claude", found: true, path: "/usr/bin/claude" },
  ]);
  assert.deepEqual(rows.map((r) => r.runtime), ["claude", "hermes"], "not sorted");
  assert.equal(rows[0].available, true);
  assert.equal(rows[0].unavailableReason, "");
  assert.equal(rows[1].available, false);
  assert.match(rows[1].unavailableReason, /not found on PATH/,
    "a bare `available: false` sends an operator looking at the service");
});

test("it FAILS CLOSED, inheriting the detector's own rule", () => {
  // "A probe that could not answer has not said yes." Anything but an explicit `found: true` is a no,
  // so an unreadable PATH advertises nothing rather than advertising everything.
  for (const found of [undefined, null, "true", 1, {}]) {
    const [row] = runtimeAvailability([{ client: "claude", command: "claude", found }]);
    assert.equal(row.available, false, `found=${JSON.stringify(found)} was treated as available`);
  }
});

test("client names travel as-is, because the vocabulary already has one owner", () => {
  // `service/contracts/vocabulary.json` maps claude->claude-code and omp->pi in BOTH languages, with
  // an agreement test on each side. Normalising here would be a third copy of that map.
  const rows = runtimeAvailability([{ client: "omp", command: "omp", found: true }]);
  assert.equal(rows[0].runtime, "omp");
  assert.notEqual(rows[0].runtime, "pi");
});

// ── the payload ──────────────────────────────────────────────────────────────────────────────

const FACTS = {
  hostname: "StevenZ-L",
  kind: "windows",
  os: "windows",
  machineId: "win32:stevenz-l",
  label: "Windows on StevenZ-L",
  cwdRoots: ["C:/Docker"],
  runtimes: runtimeAvailability([
    { client: "claude", command: "claude", found: true },
    { client: "hermes", command: "hermes", found: false },
  ]),
  terminal: true,
  version: "0.6.0",
  instance: "9f7b25b5",
};

test("the advertisement sends NO id — the service joins the facts itself", () => {
  // The whole reason this is safe to run beside a bridge. An advertiser building
  // `${kind}:${hostname}:default` would agree today and mint a duplicate environment the first time
  // either copy of that rule changed.
  const body = environmentAdvertisement(FACTS);
  assert.ok(!("id" in body), "the advertisement built an id");
  assert.equal(body.hostname, "StevenZ-L");
  assert.equal(body.kind, "windows");
});

test("the hostname keeps its casing, because the live rows were written that way", () => {
  const body = environmentAdvertisement({ ...FACTS, hostname: "StevenZ-L" });
  assert.equal(body.hostname, "StevenZ-L");
  assert.notEqual(body.hostname, "stevenz-l",
    "lowercasing mints a new id for every environment already registered");
});

test("no runtime CAPABILITY flag is advertised", () => {
  // nativeResume, interrupt, streaming, contextReset and the rest describe how a SERVICE drives a
  // runtime. Carrying them would put aify-comms' semantics in the tier that owns processes.
  const body = environmentAdvertisement(FACTS);
  const asText = JSON.stringify(body);
  for (const flag of ["nativeResume", "bridgeResume", "cliAttach", "interrupt", "streaming",
                      "tokenTelemetry", "costTelemetry", "contextReset", "modes"]) {
    assert.ok(!asText.includes(flag), `the advertisement carried ${flag}`);
  }
});

test("terminalRuntimes is the available subset, not a second list to keep in step", () => {
  const body = environmentAdvertisement(FACTS);
  assert.deepEqual(body.terminalRuntimes, ["claude"]);
  const none = environmentAdvertisement({ ...FACTS, terminal: false });
  assert.equal(none.terminal, false);
  assert.equal(none.pty, false);
});

// ── the fingerprint ──────────────────────────────────────────────────────────────────────────

test("the fingerprint is stable under reordering", () => {
  const a = environmentAdvertisement(FACTS);
  const b = environmentAdvertisement({
    ...FACTS,
    cwdRoots: [...FACTS.cwdRoots].reverse(),
    runtimes: [...FACTS.runtimes].reverse(),
  });
  assert.equal(capabilityFingerprint(a), capabilityFingerprint(b));
});

test("the fingerprint moves when a runtime appears or its reason changes", () => {
  const before = capabilityFingerprint(environmentAdvertisement(FACTS));
  const after = capabilityFingerprint(environmentAdvertisement({
    ...FACTS,
    runtimes: runtimeAvailability([
      { client: "claude", command: "claude", found: true },
      { client: "hermes", command: "hermes", found: true },
    ]),
  }));
  assert.notEqual(before, after, "a harness appearing did not change the fingerprint");
});

test("the fingerprint IGNORES the instance, or it would report a change every beat", () => {
  // Its one job is "did the PATH walk find anything new". A value that varies per process makes
  // every beat look like a change, which is the opposite of the point.
  const a = capabilityFingerprint(environmentAdvertisement(FACTS));
  const b = capabilityFingerprint(environmentAdvertisement({ ...FACTS, instance: "different" }));
  assert.equal(a, b);
});

// ── when to walk PATH again ──────────────────────────────────────────────────────────────────

test("re-detection is due at the interval, and always on the first pass", () => {
  assert.equal(shouldRedetect({ lastDetectedAt: 0, now: 1000, intervalMs: 500 }), true, "first pass");
  assert.equal(shouldRedetect({ lastDetectedAt: 1000, now: 1400, intervalMs: 500 }), false);
  assert.equal(shouldRedetect({ lastDetectedAt: 1000, now: 1500, intervalMs: 500 }), true, "at the boundary");
  assert.equal(shouldRedetect({ lastDetectedAt: 1000, now: 9999, intervalMs: 500 }), true);
  assert.equal(shouldRedetect({ lastDetectedAt: 1000, now: Number.NaN, intervalMs: 500 }), false,
    "an unreadable clock must not trigger a walk on every beat");
});

// ── where it goes ────────────────────────────────────────────────────────────────────────────

test("targets are built from the registry, one per service", () => {
  assert.deepEqual(
    advertisementTargets([
      { name: "aify-comms", endpoint: "http://127.0.0.1:8800" },
      { name: "other", endpoint: "http://127.0.0.1:9000/" },
      { name: "broken", endpoint: "" },
    ]),
    [
      "http://127.0.0.1:8800/api/v1/environments/heartbeat",
      "http://127.0.0.1:9000/api/v1/environments/heartbeat",
    ],
  );
});

test("one unreachable service does not stop the others being told", () => {
  // aify-env's own rule for the health knock: "it knocks, and it reports what came back — including
  // 'nothing came back', which is its own answer and not a failure."
  return advertiseTo({
    targets: ["http://a/x", "http://b/x", "http://c/x"],
    body: {},
    post: async (url) => {
      if (url.startsWith("http://b")) throw new Error("ECONNREFUSED");
      return { status: 200 };
    },
  }).then((results) => {
    assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
    assert.match(results[1].error, /ECONNREFUSED/);
  });
});

test("a non-2xx is reported as a failure rather than swallowed", () => {
  return advertiseTo({
    targets: ["http://a/x"],
    body: {},
    post: async () => ({ status: 401 }),
  }).then(([result]) => {
    assert.equal(result.ok, false);
    assert.equal(result.status, 401, "the status is kept — 401 is the answer once API_KEY is on");
  });
});

// -- which harnesses aify-wrapper was installed for --------------------------------------------

const WRAPPER = `#!/usr/bin/env bash\nHARNESS_WRAPPER_VERSION="0.6.0"\nexec claude "$@"\n`;

test("a harness counts when its launcher carries the contract marker", () => {
  assert.deepEqual(
    installedHarnesses([
      { file: "/home/me/.local/bin/claude-aify", text: WRAPPER },
      { file: "/home/me/.local/bin/hermes-aify", text: WRAPPER },
    ]).map((row) => row.client),
    ["claude", "hermes"],
  );
});

test("the NAME is not the evidence — an unmarked file is not a wrapper", () => {
  // The whole reason this reads the marker instead of trusting the filename. Anything can be called
  // `pi-aify`; only a wrapper declares the contract.
  assert.deepEqual(installedHarnesses([{ file: "/bin/pi-aify", text: "#!/bin/sh\nexec pi \"$@\"\n" }]), []);
});

test("it FAILS CLOSED on a file it could not read", () => {
  for (const text of [undefined, null, 0, {}, Buffer?.from?.("x")]) {
    assert.deepEqual(installedHarnesses([{ file: "/bin/claude-aify", text }]), [],
      `text=${Object.prototype.toString.call(text)} was treated as installed`);
  }
});

test("a marker-carrying file that is not a launcher is ignored", () => {
  // `aify-comms` lives in the same directory and is a bridge launcher, not a harness. Only the
  // `<client>-aify` naming aify-wrapper renders makes a file a harness launcher.
  assert.deepEqual(installedHarnesses([{ file: "/bin/aify-comms", text: WRAPPER }]), []);
});

test("the shims beside a launcher do not become second harnesses", () => {
  // On Windows a wrapper ships with `.cmd` and `.ps1` siblings. Three files, one harness.
  const rows = installedHarnesses([
    { file: "C:\\bin\\codex-aify", text: WRAPPER },
    { file: "C:\\bin\\codex-aify.cmd", text: WRAPPER },
    { file: "C:\\bin\\codex-aify.ps1", text: WRAPPER },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client, "codex");
  assert.equal(rows[0].path, "C:\\bin\\codex-aify", "the first reachable copy must win, as PATH resolves");
});

test("the rows feed runtimeAvailability unchanged", () => {
  // The two halves are written to compose: this is the shape `detectHarnesses` produces in
  // aify-wrapper, so the availability builder needs no second input format.
  const rows = runtimeAvailability(installedHarnesses([{ file: "/bin/claude-aify", text: WRAPPER }]));
  assert.deepEqual(rows, [{ runtime: "claude", available: true, unavailableReason: "" }]);
});

// -- saying nothing, versus saying there is nothing ---------------------------------------------

test("an unset cwdRoots is OMITTED, not sent as an empty list", () => {
  // The receiving rule, in the service's own words about this field: null means it said nothing --
  // keep what we had; an empty ARRAY means it said there are none. aify-env owns no roots policy, so
  // sending `[]` every beat would erase the operator's configured roots. The key must be absent.
  const body = environmentAdvertisement({ ...FACTS, cwdRoots: undefined });
  assert.ok(!("cwdRoots" in body), "an advertiser with no roots policy still claimed there are none");
});

test("roots ARE sent when this host was given some", () => {
  const body = environmentAdvertisement({ ...FACTS, cwdRoots: ["C:/work"] });
  assert.deepEqual(body.cwdRoots, ["C:/work"]);
  const none = environmentAdvertisement({ ...FACTS, cwdRoots: [] });
  assert.deepEqual(none.cwdRoots, [], "an explicit empty list is a claim and must travel");
});

// -- the id the service COMPARES ----------------------------------------------------------------

test("machineIdFor reproduces the bridge's format", () => {
  assert.equal(machineIdFor({ platform: "win32", hostname: "StevenZ-L" }), "win32:stevenz-l");
  assert.equal(machineIdFor({ platform: "darwin", hostname: "Mac" }), "darwin:mac");
});

test("a WSL host gets `wsl`, not `linux`, or it collides with the Windows host beside it", () => {
  // Both live rows on the operator's machine share the hostname StevenZ-L. `wsl:stevenz-l` and
  // `win32:stevenz-l` are what keeps them apart; a plain platform tag would merge two environments.
  assert.equal(machineIdFor({ platform: "linux", hostname: "StevenZ-L", isWsl: true }), "wsl:stevenz-l");
  assert.equal(machineIdFor({ platform: "linux", hostname: "StevenZ-L", isWsl: false }), "linux:stevenz-l");
});

test("the environment names the host before os.hostname() does", () => {
  // Same order as the bridge, and for the same reason: the two disagree on some launch paths, and an
  // id that changes when you relaunch from a different shell is a new environment every time.
  const env = { AIFY_MACHINE_ID: "override", COMPUTERNAME: "FROM-ENV" };
  assert.equal(machineIdFor({ platform: "win32", hostname: "ignored", env }), "win32:override");
  assert.equal(machineIdFor({ platform: "win32", hostname: "ignored", env: { COMPUTERNAME: "FROM-ENV" } }),
    "win32:from-env");
});

test("a host it cannot name is `unknown-host`, never an empty half", () => {
  // `win32:` would be a well-formed-looking id that matches nothing and collides with every other
  // host that also could not answer.
  assert.equal(machineIdFor({ platform: "win32", hostname: "", env: {} }), "win32:unknown-host");
  assert.equal(machineIdFor({ platform: "win32", hostname: "   ", env: {} }), "win32:unknown-host");
});
