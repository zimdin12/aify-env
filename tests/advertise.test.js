// The advertisement is built from host facts, and says nothing about the service that receives it.
//
// Every function here is pure with its inputs handed in, so these run with no network, no clock and
// no filesystem -- the property `services.mjs` already buys by injecting its health knock.

import assert from "node:assert/strict";
import test from "node:test";

import {
  advertiseTo,
  advertisementTargets,
  acceptanceKey,
  advertisementHealth,
  credentialFor,
  attemptsByService,
  credentialReadiness,
  advertisementStaleMs,
  advertisingToService,
  MISSED_BEATS_BEFORE_STALE,
  capabilityFingerprint,
  environmentAdvertisement,
  environmentKind,
  environmentOs,
  advertisingEnabled,
  installedHarnesses,
  isAdvertising,
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
      // The registry NAME travels with the endpoint. Without it "am I advertising?" is only
      // answerable for the daemon as a whole, so a success to one service stood another's bridge
      // down for a beat it never received.
      // `credentialRef` travels for the same reason and with the same trap: read off the rebuilt
      // object instead of carried, it is undefined for every service -- which reads exactly like
      // "this service stores no credential", the state the carrier exists to stop being invisible.
      { name: "aify-comms", url: "http://127.0.0.1:8800/api/v1/environments/heartbeat", keyEnv: [], credentialRef: "" },
      { name: "other", url: "http://127.0.0.1:9000/api/v1/environments/heartbeat", keyEnv: [], credentialRef: "" },
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

test("NO label travels, because it is the operator's name and not a host fact", () => {
  // This tier would generate "windows on StevenZ-L" and overwrite a "Windows on StevenZ-L" somebody
  // typed, on every beat. The service preserves a label a caller does not mention, so omitting it is
  // how the operator's choice survives an advertiser that never knew it.
  const body = environmentAdvertisement(FACTS);
  assert.ok(!("label" in body), "the advertisement carried a label it invented");
});

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

// -- who describes this host ---------------------------------------------------------------------

test("advertising means armed AND with somewhere to post", () => {
  // THE BRIDGE STANDS DOWN ON THIS, so both halves matter. Armed with no target is the case that
  // would strand a host: the bridge omits its runtimes believing this daemon covers them, and nobody
  // sends any.
  assert.equal(isAdvertising({ enabled: true, targets: ["http://a/x"] }), true);
  assert.equal(isAdvertising({ enabled: true, targets: [] }), false, "armed, but telling nobody");
  assert.equal(isAdvertising({ enabled: false, targets: ["http://a/x"] }), false);
  assert.equal(isAdvertising({}), false);
  assert.equal(isAdvertising(), false);
});

test("a target list that is not a list is not a target", () => {
  // Fails closed: anything unreadable here would otherwise make the bridge stand down for nobody.
  for (const targets of [null, undefined, "http://a/x", 1, {}]) {
    assert.equal(isAdvertising({ enabled: true, targets }), false,
      `targets=${JSON.stringify(targets)} was counted as somewhere to post`);
  }
});

test("advertising is ON unless a host says otherwise", () => {
  // Default-on since the bridge learned to stand down. It was opt-in only while both tiers could
  // advertise at once, which is the collision that no longer exists.
  for (const unset of [undefined, null, "", "   "]) {
    assert.equal(advertisingEnabled(unset), true, `${JSON.stringify(unset)} turned it off`);
  }
  for (const on of ["1", "true", "yes", "anything"]) assert.equal(advertisingEnabled(on), true);
});

test("and an explicit off hands the job back to the bridge", () => {
  for (const off of ["0", "false", "no", "off", "FALSE", " Off "]) {
    assert.equal(advertisingEnabled(off), false, `${off} did not turn it off`);
  }
});

// ── advertising is judged on ACCEPTED beats, not on having somewhere to post ────────
//
// THE DEFECT. `isAdvertising` was `enabled && targets.length > 0` and consulted no result at all,
// so a target answering 401/404/500/nothing still reported `advertising: true`. The aify-comms
// bridge STANDS DOWN on that flag, so a service that never received one advertisement could end up
// described by nobody while both tiers reported healthy. The four tests below are the four cases
// the reviewer named as required before this can be called fixed.

const HEARTBEAT = "/api/v1/environments/heartbeat";
const A = { name: "aify-comms", url: `http://a.invalid${HEARTBEAT}` };
const B = { name: "other-service", url: `http://b.invalid${HEARTBEAT}` };
const STALE_MS = advertisementStaleMs(30_000);

const healthWith = (accepted, { now = 1_000_000, targets = [A, B] } = {}) =>
  advertisementHealth({ enabled: true, targets, acceptedAt: new Map(accepted), now, staleMs: STALE_MS });

test("a 200 makes this service advertised", () => {
  const health = healthWith([[acceptanceKey(A), 1_000_000]]);
  assert.equal(advertisingToService(health, "aify-comms"), true);
  assert.equal(health.advertising, true);
});

test("a 401 or 500 does NOT -- the bridge must keep describing the host", () => {
  // Nothing was accepted, so nothing is recorded. This is the case that stood a bridge down for a
  // beat the service refused.
  const health = healthWith([]);
  assert.equal(advertisingToService(health, "aify-comms"), false);
  assert.equal(health.advertising, false, "no accepted beat means not advertising, to anyone");
  // POSITIVE CONTROL: the same reader DOES report true when a beat was accepted, so the falses
  // above are a real absence rather than a reader that always says no.
  assert.equal(advertisingToService(healthWith([[acceptanceKey(A), 1_000_000]]), "aify-comms"), true);
});

test("an accepted beat EXPIRES, so a daemon that stops being heard resumes the bridge", () => {
  const accepted = [[acceptanceKey(A), 1_000_000]];
  assert.equal(advertisingToService(healthWith(accepted, { now: 1_000_000 + STALE_MS - 1 }), "aify-comms"), true,
    "inside the window it is still advertised");
  assert.equal(advertisingToService(healthWith(accepted, { now: 1_000_000 + STALE_MS + 1 }), "aify-comms"), false,
    "past the window the bridge must take the job back");
});

test("success to ANOTHER service does not stand this one down", () => {
  // The reason the registry name travels with the endpoint at all.
  const health = healthWith([[acceptanceKey(B), 1_000_000]]);
  assert.equal(advertisingToService(health, "other-service"), true);
  assert.equal(advertisingToService(health, "aify-comms"), false,
    "aify-comms was never told, so its bridge must keep advertising");
  assert.equal(health.advertising, true, "the daemon IS advertising -- just not to aify-comms");
});

test("a future acceptance stamp does not count as fresh", () => {
  // A clock skew or a bad write would otherwise satisfy `<= staleMs` for ever and stand a bridge
  // down permanently -- the same asymmetry the delivery ceiling had to close.
  assert.equal(advertisingToService(healthWith([[acceptanceKey(A), 9_000_000]], { now: 1_000_000 }), "aify-comms"), false);
});

test("disabled means not advertising, whatever was accepted", () => {
  const health = advertisementHealth({
    enabled: false, targets: [A], acceptedAt: new Map([[acceptanceKey(A), 1_000_000]]),
    now: 1_000_000, staleMs: STALE_MS,
  });
  assert.equal(health.advertising, false);
});

test("targets keep their registry name so a result can be attributed", () => {
  const targets = advertisementTargets([
    { name: "aify-comms", endpoint: "http://a.invalid/" },
    { name: "other-service", endpoint: "http://b.invalid" },
  ]);
  assert.deepEqual(targets.map((t) => t.name), ["aify-comms", "other-service"]);
  assert.deepEqual(targets.map((t) => t.url), [A.url, B.url]);
});

test("the staleness window is derived from the beat interval, not a second constant", () => {
  assert.equal(advertisementStaleMs(30_000), 30_000 * MISSED_BEATS_BEFORE_STALE);
  assert.equal(advertisementStaleMs(1_000), 1_000 * MISSED_BEATS_BEFORE_STALE);
});

// ── the advertisement carries a credential when one is configured ──────────────────
//
// `postAdvertisement` sent no key at all, so the moment an operator turned `API_KEY` on every
// advertisement 401'd. Paired with the flag that reported success regardless, the bridge stood down
// for beats nobody ever accepted. The registry declares WHERE a key lives, never what it is: it is
// a shared file readable by everything on the host.

test("the key is resolved from the environment by the names the registry declares", () => {
  const target = { name: "aify-comms", url: A.url, keyEnv: ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"] };
  assert.equal(credentialFor(target, { AIFY_API_KEY: "sk-second" }), "sk-second");
  // First non-empty name wins, matching the order the service's own reader uses.
  assert.equal(
    credentialFor(target, { CLAUDE_MCP_API_KEY: "sk-first", AIFY_API_KEY: "sk-second" }), "sk-first");
});

test("no declared names, or names nothing set, means no credential -- not an empty one", () => {
  assert.equal(credentialFor({ url: A.url, keyEnv: [] }, { AIFY_API_KEY: "sk" }), "");
  assert.equal(credentialFor({ url: A.url, keyEnv: ["AIFY_API_KEY"] }, {}), "");
  assert.equal(credentialFor({ url: A.url, keyEnv: ["AIFY_API_KEY"] }, { AIFY_API_KEY: "   " }), "",
    "whitespace is not a credential");
  // POSITIVE CONTROL: the same resolver DOES find a real one, so the empties above are real
  // absences rather than a resolver that never returns anything.
  assert.equal(credentialFor({ url: A.url, keyEnv: ["AIFY_API_KEY"] }, { AIFY_API_KEY: "sk" }), "sk");
});

test("advertiseTo hands each target's own credential to the poster", async () => {
  const seen = [];
  await advertiseTo({
    targets: [
      { name: "aify-comms", url: A.url, keyEnv: ["AIFY_API_KEY"] },
      { name: "other-service", url: B.url, keyEnv: ["OTHER_KEY"] },
    ],
    body: {},
    env: { AIFY_API_KEY: "sk-comms", OTHER_KEY: "sk-other" },
    post: async (url, _body, key) => { seen.push([url, key]); return { status: 200 }; },
  });
  assert.deepEqual(seen, [[A.url, "sk-comms"], [B.url, "sk-other"]],
    "each service must get ITS OWN key, never another's");
});

test("a target with no key still gets its advertisement", async () => {
  // An unkeyed service is a supported configuration and must not be skipped.
  const seen = [];
  const results = await advertiseTo({
    targets: [{ name: "aify-comms", url: A.url, keyEnv: [] }],
    body: {}, env: {},
    post: async (url, _body, key) => { seen.push([url, key]); return { status: 200 }; },
  });
  assert.deepEqual(seen, [[A.url, ""]]);
  assert.equal(results[0].ok, true);
});

test("the registry gives targets their key NAMES, and never a key value", () => {
  const targets = advertisementTargets([
    { name: "aify-comms", endpoint: "http://a.invalid", keyEnv: ["AIFY_API_KEY"] },
  ]);
  assert.deepEqual(targets[0].keyEnv, ["AIFY_API_KEY"]);
  // The registry is a shared file. A value in it would be a secret shared with everything on the
  // host, so nothing in this pipeline may carry one.
  assert.equal(JSON.stringify(targets).includes("sk-"), false);
});

// ── two services can share one endpoint, and must not share an acceptance ──────────
//
// THE COLLISION. Acceptance was keyed by URL while health was keyed by service NAME, so two
// registry names pointing at one endpoint read a single stamp: A gets a 2xx, B gets a 401, and
// BOTH render fresh. They can carry different credentials, which is precisely when one succeeds
// and the other does not — so the collision is not hypothetical, it is the case that produces it.

test("one accepted and one refused on the SAME endpoint: only the accepted NAME is fresh", async () => {
  const shared = "http://shared.invalid/api/v1/environments/heartbeat";
  const targets = [
    { name: "aify-comms", url: shared, keyEnv: ["GOOD_KEY"] },
    { name: "other-service", url: shared, keyEnv: ["BAD_KEY"] },
  ];
  const accepted = new Map();
  const results = await advertiseTo({
    targets,
    body: {},
    env: { GOOD_KEY: "sk-good", BAD_KEY: "sk-bad" },
    // The endpoint accepts one credential and refuses the other, which is the whole point of
    // per-service keys.
    post: async (_url, _body, key) => ({ status: key === "sk-good" ? 200 : 401 }),
  });
  for (const result of results) {
    if (result.ok) accepted.set(acceptanceKey(result), 1_000_000);
  }

  const health = advertisementHealth({
    enabled: true, targets, acceptedAt: accepted, now: 1_000_000,
    staleMs: advertisementStaleMs(30_000),
  });
  assert.equal(advertisingToService(health, "aify-comms"), true, "the accepted service is described");
  assert.equal(advertisingToService(health, "other-service"), false,
    "a REFUSED service was reported as described because it shares an endpoint with an accepted one");
});

test("an acceptance does not survive the service being renamed or moved", () => {
  // Both parts are in the key, so a change to either invalidates. A stale acceptance under an old
  // identity would report a service as described when nothing had told it under its new one.
  const accepted = new Map([[acceptanceKey({ name: "aify-comms", url: A.url }), 1_000_000]]);
  const opts = { enabled: true, acceptedAt: accepted, now: 1_000_000, staleMs: advertisementStaleMs(30_000) };

  const sameIdentity = advertisementHealth({ ...opts, targets: [{ name: "aify-comms", url: A.url }] });
  assert.equal(advertisingToService(sameIdentity, "aify-comms"), true, "control: the key matches");

  const renamed = advertisementHealth({ ...opts, targets: [{ name: "aify-comms-2", url: A.url }] });
  assert.equal(advertisingToService(renamed, "aify-comms-2"), false, "a rename must invalidate");

  const moved = advertisementHealth({ ...opts, targets: [{ name: "aify-comms", url: B.url }] });
  assert.equal(advertisingToService(moved, "aify-comms"), false, "a moved endpoint must invalidate");
});

test("no two distinct identities can collapse onto one acceptance key", () => {
  // COLLISION-FREE BY CONSTRUCTION. The first version joined the parts with a newline and asserted
  // in a comment that neither could contain one -- a guarantee claimed rather than held, since
  // nothing validates a registry key or an endpoint against newlines. Encoding both lengths removes
  // the assumption instead of restating it, so these adversarial pairs stay distinct whatever a
  // registry happens to contain.
  const identities = [
    // THE PAIR THAT ACTUALLY COLLIDES under a `join("\n")`: both flatten to `a\nb\nc`. My first
    // version of this list used shapes that merely CONTAINED a newline, and a mutation back to the
    // delimiter left all of them green -- an adversarial-looking test that adversary never reached.
    { name: "a", url: "b\nc" },
    { name: "a\nb", url: "c" },

    { name: "a", url: "b" },
    { name: "a\nb", url: "" },
    { name: "", url: "a\nb" },
    { name: "a", url: "" },
    { name: "", url: "a" },
    { name: "a\"", url: "b" },
    { name: "a", url: "\"b" },
    { name: "a\\", url: "b" },
  ];
  const keys = identities.map(acceptanceKey);
  assert.equal(
    new Set(keys).size, identities.length,
    `two distinct identities produced the same key: ${JSON.stringify(keys)}`,
  );
  // POSITIVE CONTROL: the SAME identity must still produce the SAME key, or nothing would ever
  // match and every service would read as never-accepted.
  assert.equal(acceptanceKey({ name: "a", url: "b" }), acceptanceKey({ name: "a", url: "b" }));
});

// ---------------------------------------------------------------------------------------------
// The advertisement credential. It comes from this daemon's own process environment and NOTHING on
// the host puts it there -- the aify-comms bridge does not start this daemon. So with `API_KEY` set
// on that service and no key here, every beat is refused, `advertising` stays false, the bridge
// correctly keeps describing the host, and the whole chain is silent. These make it visible.

test("credentialReadiness reports WHETHER a key is held, never the key", () => {
  const targets = [{ name: "aify-comms", url: "http://a", keyEnv: ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"] }];
  const held = credentialReadiness(targets, { AIFY_API_KEY: "s3cret-value" });
  assert.equal(held["aify-comms"].hasCredential, true);
  // The value must not appear anywhere in what is reported. `/health` is unauthenticated, and a
  // length or a prefix would each narrow a search that a boolean does not.
  assert.ok(!JSON.stringify(held).includes("s3cret-value"), "the key itself reached the report");
  assert.deepEqual(held["aify-comms"].keyEnv, ["CLAUDE_MCP_API_KEY", "AIFY_API_KEY"]);
});

test("a variable that is set but EMPTY is not a credential", () => {
  const targets = [{ name: "aify-comms", url: "http://a", keyEnv: ["AIFY_API_KEY"] }];
  // Whitespace is what an operator leaves behind by starting to set one and stopping. It would be
  // sent as a header and refused, which is the failure this reports, not a credential.
  assert.equal(credentialReadiness(targets, { AIFY_API_KEY: "   " })["aify-comms"].hasCredential, false);
  assert.equal(credentialReadiness(targets, { AIFY_API_KEY: "" })["aify-comms"].hasCredential, false);
  // POSITIVE CONTROL: the same reader says true for a real value, so the falses above are a real
  // absence rather than a reader that always says no.
  assert.equal(credentialReadiness(targets, { AIFY_API_KEY: "k" })["aify-comms"].hasCredential, true);
});

test("a target whose registry entry declares NO key variable can never be given one", () => {
  const targets = [{ name: "legacy", url: "http://a", keyEnv: [] }];
  assert.equal(credentialReadiness(targets, { AIFY_API_KEY: "k" }).legacy.hasCredential, false);
});

test("attemptsByService keeps the last outcome per service, and NO response body", () => {
  const targets = [{ name: "aify-comms", url: "http://a", keyEnv: [] }];
  const attempts = new Map([[acceptanceKey(targets[0]),
    { at: 1234, ok: false, status: 401, error: "" }]]);
  const out = attemptsByService(targets, attempts);
  assert.deepEqual(out["aify-comms"], { at: 1234, ok: false, status: 401, error: "" });
  // A service's error TEXT is its own and could carry anything, including something it should not
  // have said. Only a status number and this daemon's own transport error travel.
  assert.deepEqual(Object.keys(out["aify-comms"]).sort(), ["at", "error", "ok", "status"]);
});

test("a target never beaten to is NULL, not a zeroed attempt", () => {
  // A zeroed row would read as "tried and got nothing", which is evidence this daemon does not have.
  const targets = [{ name: "aify-comms", url: "http://a", keyEnv: [] }];
  assert.equal(attemptsByService(targets, new Map())["aify-comms"], null);
  // POSITIVE CONTROL: the same reader returns a record when one exists.
  const seen = new Map([[acceptanceKey(targets[0]), { at: 5, ok: true, status: 200, error: "" }]]);
  assert.equal(attemptsByService(targets, seen)["aify-comms"].ok, true);
});

test("attempts are keyed by SERVICE identity, so two services on one endpoint do not share one", () => {
  // The same collision `acceptanceKey` exists to prevent, in the second map that now uses it.
  const targets = [
    { name: "aify-comms", url: "http://shared", keyEnv: [] },
    { name: "other", url: "http://shared", keyEnv: [] },
  ];
  const attempts = new Map([[acceptanceKey(targets[0]), { at: 1, ok: true, status: 200, error: "" }]]);
  const out = attemptsByService(targets, attempts);
  assert.equal(out["aify-comms"].ok, true);
  assert.equal(out.other, null, "an acceptance for one service was read for another");
});

test("THE BEAT USES THE INJECTED RESOLVER, which is what makes the store deliver", async () => {
  // The delivery join. Everything else in the carrier is scaffolding around this: a key that reaches
  // `credentialForTarget` and not `post` is a key that was never sent, and the service would refuse
  // the beat exactly as it did before any of this existed.
  //
  // A mutation dropping the resolver survived until this test, because every other case here goes
  // through the environment-only default.
  const seen = [];
  const post = async (url, body, key) => { seen.push(key); return { status: 200 }; };
  await advertiseTo({
    targets: [{ name: "aify-comms", url: "http://x", keyEnv: [] }],
    body: {}, post, env: {},
    credential: async () => "from-the-store",
  });
  assert.deepEqual(seen, ["from-the-store"]);
});

test("and WITHOUT one it still reads the environment, so existing callers are untouched", async () => {
  const seen = [];
  const post = async (url, body, key) => { seen.push(key); return { status: 200 }; };
  await advertiseTo({
    targets: [{ name: "aify-comms", url: "http://x", keyEnv: ["AIFY_API_KEY"] }],
    body: {}, post, env: { AIFY_API_KEY: "from-the-environment" },
  });
  assert.deepEqual(seen, ["from-the-environment"]);
});
