#!/usr/bin/env node
// A plugin sends ITS OWN service's key, whatever the registry says now (review of c1a4596, R1).
//
// A plugin kept on its old endpoint for its workers (P0 C8) outlives its registry entry. Its key was
// resolved from the registry's CURRENT first target, so after a repoint the old endpoint was sent the
// new service's key, and after a removal no key at all.
//
// The real chain runs here: pluginsForServices -> the aify-comms plugin -> CommsApi -> PluginHost ->
// pluginCredential -> credentialForTarget. Only `fetch` is replaced: it records which URL was sent
// which key, and holds the control long-polls open for the test to answer. The keys are synthetic.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { credentialForTarget } from "../lib/credential-resolve.mjs";
import { followRegistry, pluginCredential } from "../lib/plugin-bootstrap.mjs";
import { pluginsForServices } from "../lib/plugins/index.mjs";
import { PluginHost, PluginProcesses, ServicePlugins } from "../lib/service-plugins.mjs";

const NEWLINE = String.fromCharCode(10);
const ALLOWED = ["#!/bin/bash", 'HARNESS_WRAPPER_VERSION="0.6.0"', ""].join(NEWLINE);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(predicate, what) {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
const witness = (name, fn) => test(name, { timeout: 10_000 }, fn);

const OLD = "http://old.invalid";
const NEW = "http://new.invalid";
const comms = (endpoint, keyEnv) => ({ name: "aify-comms", endpoint, keyEnv: [keyEnv], credentialRef: "" });
// Not a service this host has a plugin for, and FIRST in the registry: the target the old resolver used.
const unrelated = { name: "some-other-service", endpoint: "http://other.invalid", keyEnv: ["KEY_OTHER"], credentialRef: "" };

/** The network: records every request's URL and key; control long-polls wait for the test. */
function fakeNetwork(launch) {
  const net = { sent: [], polls: [] };
  const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
  net.fetch = async (url, init) => {
    net.sent.push({ url, key: init?.headers?.["X-API-Key"] ?? null });
    if (url.endsWith("/environments/heartbeat")) return reply({ claimer: { accepted: true } });
    if (url.endsWith("/terminals/controls/claim")) {
      return new Promise((resolve) => net.polls.push({ answer: (controls) => resolve(reply({ controls })) }));
    }
    if (url.includes("/launch")) return reply({ launch });
    return reply({});
  };
  net.answer = async (controls) => {
    await until(() => net.polls.some((p) => !p.answered), "an open control long-poll");
    const open = net.polls.find((p) => !p.answered);
    open.answered = true;
    open.answer(controls);
  };
  return net;
}

function fakeRunner() {
  const running = new Set();
  return {
    running,
    async start() { running.add("proc-1"); return { id: "proc-1", pid: 4242 }; },
    subscribe(id, onOutput, onExit) { this.exit = () => { running.delete(id); onExit?.(0, ""); }; return () => {}; },
    write() {}, resize() {}, relabel() {}, screenText: () => null, canStream: () => true,
    async stop(id) { running.delete(id); },
    list: () => [...running].map((id) => ({ id, pid: 4242 })),
  };
}

// EVERY PLUGIN IS STOPPED AT THE END, the ones followRegistry started included: a plugin left running
// keeps its timers, and a file that cannot exit stalls a mutation run past every per-test timeout.
const live = [];
const registries = [];
const realFetch = globalThis.fetch;
after(async () => {
  await Promise.all(live.map((plugin) => plugin.stop().catch(() => {})));
  await Promise.all(registries.map((registry) => registry.stopAll().catch(() => {})));
  globalThis.fetch = realFetch;
});

/**
 * A daemon's worth of plugin wiring, holding one worker, with `credential` as the host's resolver.
 * `keys` is the environment the resolver reads: change it and the next request must carry the change.
 */
async function heldWorkerSetup({ credential } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aify-own-key-"));
  const launcher = path.join(root, "claude-aify");
  fs.writeFileSync(launcher, ALLOWED);
  const net = fakeNetwork({ terminalId: "term-1", agentId: "a", runtime: "claude-code", command: launcher, argv: [launcher], cwd: root, env: { AIFY_AGENT_ID: "a" } });
  globalThis.fetch = net.fetch;
  const keys = { KEY_OLD: "old-service-key", KEY_NEW: "new-service-key", KEY_OTHER: "other-service-key" };
  const runner = fakeRunner();
  const host = new PluginHost({
    processes: new PluginProcesses(runner),
    credential: credential || ((service) => pluginCredential(service, (target) => credentialForTarget(target, { env: keys, root }))),
  });
  const shared = {
    cwdRoots: async () => [root], advertisement: async () => ({ hostname: "h", kind: "test" }),
    windows: process.platform === "win32", readFile: () => ALLOWED,
    setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeoutImpl: clearTimeout,
  };
  const build = (services) => pluginsForServices(services, shared);
  const registry = new ServicePlugins();
  registries.push(registry);
  const [plugin] = build([unrelated, comms(OLD, "KEY_OLD")]).plugins;
  live.push(plugin);
  assert.equal(registry.register(plugin), "");
  await plugin.start(host);
  await net.answer([{ id: "ctl-start", terminalId: "term-1", action: "start" }]);
  await until(() => runner.running.size === 1, "the worker to start");
  return { net, keys, registry, host, build, plugin };
}

/** Change the registry while a long-poll is open, and answer it so the plugin can decide. */
async function follow(setup, services) {
  await until(() => setup.net.polls.some((p) => !p.answered), "an open control long-poll");
  const following = followRegistry({ registry: setup.registry, host: setup.host, services, build: setup.build });
  await setup.net.answer([]);
  return following;
}

/** The keys sent to one endpoint after a mark in the record. */
const keysTo = (net, endpoint, from = 0) => [...new Set(net.sent.slice(from).filter((s) => s.url.startsWith(endpoint)).map((s) => s.key))];

async function laterRequestsTo(net, endpoint) {
  const mark = net.sent.length;
  await net.answer([]);
  await until(() => net.sent.slice(mark).some((s) => s.url.startsWith(endpoint)), `a request to ${endpoint}`);
  return keysTo(net, endpoint, mark);
}

witness("A REPOINT: the held plugin keeps sending the old endpoint its own key, never the new service's", async () => {
  const setup = await heldWorkerSetup();
  assert.deepEqual(keysTo(setup.net, OLD), ["old-service-key"], "control: before any change, the old service's key, though another target is first");
  const out = await follow(setup, [unrelated, comms(NEW, "KEY_NEW")]);
  assert.deepEqual(out.held, [{ name: "aify-comms", held: 1 }]);
  assert.deepEqual(await laterRequestsTo(setup.net, OLD), ["old-service-key"]);
  assert.deepEqual(keysTo(setup.net, NEW), [], "nothing was sent to the new endpoint while the name is held");
});

witness("A REMOVAL: the held plugin still authenticates to the endpoint it serves", async () => {
  const setup = await heldWorkerSetup();
  const out = await follow(setup, [unrelated]);
  assert.deepEqual(out.held, [{ name: "aify-comms", held: 1 }]);
  assert.deepEqual(await laterRequestsTo(setup.net, OLD), ["old-service-key"]);
});

witness("A ROTATION reaches a held plugin: the key is read per request, never kept", async () => {
  const setup = await heldWorkerSetup();
  await follow(setup, [unrelated, comms(NEW, "KEY_NEW")]);
  setup.keys.KEY_OLD = "old-service-key-rotated";
  assert.deepEqual(await laterRequestsTo(setup.net, OLD), ["old-service-key-rotated"]);
});

witness("NEGATIVE CONTROL: a resolver that reads the CURRENT registry is caught by the same observation", async () => {
  // The defect, planted: the host ignores which plugin asks and resolves whatever the registry names
  // now, as `advertisingTargets[0]` did. The repoint witness's own observation must see it.
  let current = [unrelated, comms(OLD, "KEY_OLD")];
  const keys = { KEY_OLD: "old-service-key", KEY_NEW: "new-service-key", KEY_OTHER: "other-service-key" };
  const setup = await heldWorkerSetup({
    credential: () => pluginCredential(current.find((s) => s.name === "aify-comms") || null,
      (target) => credentialForTarget(target, { env: keys, root: os.tmpdir() })),
  });
  current = [unrelated, comms(NEW, "KEY_NEW")];
  await follow(setup, current);
  assert.deepEqual(await laterRequestsTo(setup.net, OLD), ["new-service-key"], "the planted defect sends the new key to the old endpoint");
});

witness("THE DAEMON'S OWN WIRING hands the asking plugin's entry to the resolver: its source, run", async () => {
  // bin/aify-env.mjs is never imported (it runs the daemon), so its resolver and the host's credential
  // property are taken out and run with the real pluginCredential and a recording store reader.
  const daemon = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");
  const begin = daemon.indexOf("async function resolvePluginCredential(");
  const end = daemon.indexOf(NEWLINE + "}", begin);
  const property = daemon.split(NEWLINE).filter((line) => line.includes("credential: async (service) =>"));
  assert.ok(begin > 0 && end > begin, "the daemon's resolver must remain identifiable");
  assert.equal(property.length, 1, "the host's credential property must remain identifiable");
  const resolved = [];
  const context = {
    pluginCredential,
    credentialForTarget: async (target) => { resolved.push(target.name); return { value: `key-for-${target.name}` }; },
    credentialReading: () => ({}),
  };
  const { runInNewContext } = await import("node:vm");
  const host = runInNewContext(`${daemon.slice(begin, end + 2)}; ({ ${property[0].trim()} })`, context);
  assert.equal(await host.credential(comms(OLD, "KEY_OLD")), "key-for-aify-comms");
  assert.equal(await host.credential(null), "", "no entry, no key");
  assert.deepEqual(resolved, ["aify-comms"]);
});

witness("pluginCredential: the entry's own key, and nothing for no entry", async () => {
  const seen = [];
  const resolve = async (target) => { seen.push(target.name); return { state: "ok", value: `key-for-${target.name}` }; };
  assert.equal(await pluginCredential(comms(OLD, "KEY_OLD"), resolve), "key-for-aify-comms");
  assert.equal(await pluginCredential(null, resolve), "", "no entry, no key: never another service's");
  assert.equal(await pluginCredential({ name: "aify-comms", endpoint: "" }, resolve), "", "an entry with no endpoint names no target");
  assert.deepEqual(seen, ["aify-comms"]);
});
