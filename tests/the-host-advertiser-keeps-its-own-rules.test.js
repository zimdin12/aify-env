// lib/host-advertiser.mjs keeps the three rules bin/aify-env.mjs's advertising code kept when it lived there, and which
// three tests pinned as that file's text: the view guard sits inside the beat, a throwing pass is a log line, and the
// plugins follow only a registry that parses. They are held here as behaviour; what the daemon hands the advertiser is
// still read from its source, because importing it starts a daemon. Health against real services is
// the-daemon-really-advertises.test.js (a spawned daemon: 401, 500, accepted, credentials).

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { HostAdvertiser } from "../lib/host-advertiser.mjs";
import { BootFixture } from './fixtures/daemon-boot.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();

const REGISTRY = JSON.stringify({ version: 1, services: { svc: { endpoint: "http://127.0.0.2:1/mcp/sse", advertise: true } } });
const DAEMON = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");

/** An advertiser over a registry text, a recorded transport and a host whose facts can throw. */
function advertiser({ registry = REGISTRY, stopped = () => false, host = null, onServices = () => {} } = {}) {
  const r = { reads: 0, posts: [], logs: [], said: [] };
  r.advertiser = new HostAdvertiser({
    enabled: true, everyMs: 30_000, redetectMs: 300_000, stopped, onServices,
    readRegistry: () => { r.reads += 1; if (registry === null) throw new Error("ENOENT"); return registry; },
    host: host ?? (() => ({ hostname: "h", kind: "windows", os: "windows", machineId: "win32:h", terminal: true, terminalReason: "",
      version: "0.9.9", instance: "b", codeOnDisk: null, launchRoots: ["C:/w"] })),
    harnesses: () => [], pathFor: () => "/api/v1/environments", credentialReading: () => ({ env: {}, root: "C:/nowhere" }),
    credential: async () => "", env: {},
    post: async (url) => { r.posts.push(url); return { ok: true, status: 204 }; },
    say: (line) => r.said.push(line),
  });
  return r;
}

test("A VIEW REFUSES THE BEAT ITSELF, not only the timer: a beat fired before the view was marked describes nothing", async () => {
  // R9-M9: a view is marked inside the daemon's error handler, after module evaluation has already fired the first beat.
  const control = advertiser();
  await control.advertiser.beat();
  assert.equal(control.posts.length, 1, "CONTROL: a live host beats");
  const view = advertiser({ stopped: () => true });
  await view.advertiser.beat();
  assert.deepEqual([view.reads, view.posts.length], [0, 0], "a process running nothing described the host");
  assert.match(DAEMON, /stopped: \(\) => viewOnly \|\| boot\.cancelled,/, "the entry keeps the advertiser's own view/cancellation guard");
});

test("A PASS THAT THROWS IS A LOG LINE, never an unhandled rejection that ends the daemon and its workers", async () => {
  const thrown = advertiser({ host: () => { throw new Error('no host facts'); } });
  const logs = [], unhandled = [], boot = new BootFixture(); let starts = 0, cleared = 0, failure;
  const actualStart = thrown.advertiser.start.bind(thrown.advertiser);
  thrown.advertiser.start = options => { starts++; return actualStart({ ...options,
    setIntervalImpl: () => ({}), clearIntervalImpl: () => cleared++ }); };
  boot.options.advertiser = thrown.advertiser; boot.options.log = line => logs.push(line);
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    failure = await boot.boot().then(() => null, error => error);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    await boot.session.stop('advertising');
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual({ failed: Boolean(failure), starts, cleared, unhandled: unhandled.length,
    logged: logs.some(line => line.includes('advertise failed: no host facts')) },
  { failed: false, starts: 1, cleared: 1, unhandled: 0, logged: true });
});

test('a cancelled boot refuses future advertiser beats before reading the registry', async () => {
  const boot = new BootFixture(), r = advertiser({ stopped: () => boot.session.cancelled });
  await r.advertiser.beat();
  assert.deepEqual({ reads: r.reads, posts: r.posts.length }, { reads: 1, posts: 1 });
  boot.session.cancel(); await r.advertiser.beat();
  assert.deepEqual({ reads: r.reads, posts: r.posts.length }, { reads: 1, posts: 1 }, 'the cancelled pass creates no new read or post');
});

test("THE PLUGINS FOLLOW ONLY A REGISTRY THAT PARSES: a broken or absent one leaves them as they are", async () => {
  for (const [registry, expected] of [['{"version":1,"services":{}}', [[]]], ["{", []], ["", []], [null, []]]) {
    const followed = [];
    const r = advertiser({ registry, onServices: (services) => followed.push(services) });
    await r.advertiser.beat();
    assert.deepEqual(followed, expected, JSON.stringify(registry));
  }
  assert.match(DAEMON, /onServices: \(services\) => \{ if \(!boot\.cancelled\) boot\.followServices\?\.\(services\); \},/,
    'the unmoved advertiser callback forwards registry reads only while this boot is open');
});
