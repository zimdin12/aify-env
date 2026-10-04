// `aify-env agents import`, `attach` and `run` ask the environment that is running, including a `herdr-aify env`
// daemon on the port the OS picked. Each knew only the default port and said "no environment answered" beside a
// running daemon (2026-10-04). And because they ACT on what they choose, they choose only from a complete look:
// choosing from the newest few receipts picked one daemon while a second matched just beyond them (review of
// 9a9023b). These drive `findEnvEndpoint`, which all three call, against a temporary home holding receipts and a
// fake fetch: no real port is touched. Which commands call it is held below by reading their source, since
// running them would start or attach to real processes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACTION_RECEIPT_LIMIT, chooseEnvEndpoint, findEnvEndpoint } from "../lib/serving-endpoint.mjs";

const DEFAULT = "http://127.0.0.1:8802";
const DAEMON = "http://127.0.0.1:49999";
const everyoneAlive = () => "alive";

/** A home whose herdr profile holds `receipts`, oldest first, each `{endpoint, pid, envInstance}`. */
function homeWith(receipts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-import-home-"));
  receipts.forEach((receipt, i) => {
    const dir = path.join(home, ".aify", "herdr", "invocations", `inv-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ready.json");
    fs.writeFileSync(file, JSON.stringify(receipt));
    const at = new Date(Date.now() - (receipts.length - i) * 1000);
    fs.utimesSync(file, at, at);
  });
  return home;
}
const homeWithReceipt = () => homeWith([{ endpoint: DAEMON, pid: 4242, envInstance: "inst-1" }]);

/** A fetch where only the named endpoints answer /health, with the identity given; records what it asked. */
const answering = (identities, asked = []) => async (url) => {
  asked.push(url);
  const base = Object.keys(identities).find((endpoint) => url === `${endpoint}/health`);
  if (!base) throw new Error("ECONNREFUSED");
  return { ok: true, json: async () => identities[base] };
};

test("nothing at the default port: the live daemon its receipt names is the one asked", async () => {
  const fetchImpl = answering({ [DAEMON]: { pid: 4242, instance: "inst-1" } });
  assert.deepEqual(await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl, state: everyoneAlive }),
    { endpoint: DAEMON, problem: "" });
});

test("a receipt whose address answers as another daemon is not taken", async () => {
  const fetchImpl = answering({ [DAEMON]: { pid: 7, instance: "someone-else" } });
  assert.deepEqual(await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl, state: everyoneAlive }),
    { endpoint: DEFAULT, problem: "" }, "falls back to the default");
});

test("CONTROLS: a named endpoint wins, and an environment at the default port is kept", async () => {
  const fetchImpl = answering({ [DAEMON]: { pid: 4242, instance: "inst-1" }, [DEFAULT]: { pid: 1, instance: "default" } });
  assert.equal((await findEnvEndpoint({ env: { AIFY_ENV_ENDPOINT: "http://127.0.0.1:5555" }, home: homeWithReceipt(),
    fetchImpl, state: everyoneAlive })).endpoint, "http://127.0.0.1:5555");
  assert.equal((await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl, state: everyoneAlive })).endpoint, DEFAULT);
});

test("chooseEnvEndpoint: a named endpoint is taken without asking anything", async () => {
  const fetchHealth = async () => assert.fail("a named endpoint needs no knock");
  assert.deepEqual(await chooseEnvEndpoint({ named: "http://127.0.0.1:5555", defaultEndpoint: DEFAULT, fetchHealth }),
    { endpoint: "http://127.0.0.1:5555", problem: "" });
});

test("a look with receipts left unread chooses nothing, even when one daemon answered among those read", async () => {
  const receipts = [{ endpoint: DAEMON, pid: 4242, envInstance: "inst-1", writtenMs: 2 }];
  const fetchHealth = async (url) => (url === DAEMON ? { pid: 4242, instance: "inst-1" } : null);
  const chosen = await chooseEnvEndpoint({ defaultEndpoint: DEFAULT, receipts, unread: 1, fetchHealth });
  assert.equal(chosen.endpoint, "");
  assert.match(chosen.problem, /1 older herdr-aify env receipt\(s\) were not read.*AIFY_ENV_ENDPOINT/);
});

test("two live daemons are named, not chosen between", async () => {
  const other = "http://127.0.0.1:50001";
  const home = homeWith([{ endpoint: other, pid: 11, envInstance: "b" }, { endpoint: DAEMON, pid: 4242, envInstance: "inst-1" }]);
  const fetchImpl = answering({ [DAEMON]: { pid: 4242, instance: "inst-1" }, [other]: { pid: 11, instance: "b" } });
  const chosen = await findEnvEndpoint({ env: {}, home, fetchImpl, state: everyoneAlive });
  assert.equal(chosen.endpoint, "");
  assert.match(chosen.problem, /2 herdr-aify env daemons answer/);
});

test("a daemon past the doctor's eight is found, and dead invocations cost no probe", async () => {
  // The operator's host held 24 invocations; the live one need not be among the newest eight.
  const dead = Array.from({ length: 20 }, (_, i) => ({ endpoint: `http://127.0.0.1:${40000 + i}`, pid: 1000 + i, envInstance: `d${i}` }));
  const home = homeWith([{ endpoint: DAEMON, pid: 4242, envInstance: "inst-1" }, ...dead]);
  const asked = [];
  const fetchImpl = answering({ [DAEMON]: { pid: 4242, instance: "inst-1" } }, asked);
  const chosen = await findEnvEndpoint({ env: {}, home, fetchImpl, state: (pid) => (pid === 4242 ? "alive" : "gone") });
  assert.deepEqual(chosen, { endpoint: DAEMON, problem: "" });
  assert.deepEqual(asked, [`${DEFAULT}/health`, `${DAEMON}/health`], "only the default and the live receipt are probed");
  assert.ok(21 <= ACTION_RECEIPT_LIMIT, "control: the population fits the limit, so the look was complete");
});

test("EVERY CLIENT COMMAND asks through it, refuses on its problem, and keeps no default-port constant", () => {
  const bin = fileURLToPath(new URL("../bin/", import.meta.url));
  for (const command of ["aify-env-agents.mjs", "aify-env-attach.mjs", "aify-env-run.mjs"]) {
    const source = fs.readFileSync(path.join(bin, command), "utf8");
    assert.match(source, /await findEnvEndpoint\(\)/, `${command} asks through findEnvEndpoint`);
    assert.match(source, /\.problem\b/, `${command} acts on an unresolved answer`);
    assert.doesNotMatch(source, /127\.0\.0\.1:8802/, `${command} keeps no default-port constant of its own`);
  }
});

// A LOOK THAT DID NOT HAPPEN IS NOT "NONE" (review of 3f1e1ec): a listing, stat or read that failed, or a process
// whose state is unknown, each returned the default with an empty problem, which attach and run then act on.
const failing = (code, onlyFor) => (target) => {
  if (!onlyFor || String(target).includes(onlyFor)) throw Object.assign(new Error(code), { code });
};
const ioWith = (overrides) => ({ ...fs, ...overrides });
const nobodyAnswers = answering({});

test("a listing that failed for a reason other than absence is a problem, not the default", async () => {
  const chosen = await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl: nobodyAnswers, state: everyoneAlive,
    io: ioWith({ readdirSync: failing("EACCES") }) });
  assert.deepEqual(chosen.endpoint, "");
  assert.match(chosen.problem, /1 herdr-aify env receipt\(s\) could not be read.*AIFY_ENV_ENDPOINT/);
});

test("a ready file that could not be looked at, or read, is a problem", async () => {
  for (const io of [ioWith({ statSync: failing("EACCES", "ready.json") }), ioWith({ readFileSync: failing("EBUSY", "ready.json") })]) {
    const chosen = await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl: nobodyAnswers, state: everyoneAlive, io });
    assert.deepEqual([chosen.endpoint, /could not be read/.test(chosen.problem)], ["", true], chosen.problem);
  }
  const home = homeWith([{ endpoint: "not-an-endpoint", pid: 4242, envInstance: "inst-1" }]);
  const corrupt = await findEnvEndpoint({ env: {}, home, fetchImpl: nobodyAnswers, state: everyoneAlive });
  assert.deepEqual([corrupt.endpoint, /could not be read/.test(corrupt.problem)], ["", true], "an invalid receipt too");
});

test("a receipt whose process state is unknown is a problem, and is not probed", async () => {
  const asked = [];
  const chosen = await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl: answering({}, asked), state: () => "unknown" });
  assert.equal(chosen.endpoint, "");
  assert.match(chosen.problem, /whether herdr-aify env pid 4242 still runs could not be told.*AIFY_ENV_ENDPOINT/);
  assert.deepEqual(asked, [`${DEFAULT}/health`]);
});

test("CONTROLS: no invocations folder, a folder with no ready file, and a gone pid are facts, not problems", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aify-import-home-"));
  assert.deepEqual(await findEnvEndpoint({ env: {}, home: empty, fetchImpl: nobodyAnswers, state: everyoneAlive }),
    { endpoint: DEFAULT, problem: "" }, "nothing ran here");
  const notReady = homeWithReceipt();
  fs.mkdirSync(path.join(notReady, ".aify", "herdr", "invocations", "never-ready"));
  fs.writeFileSync(path.join(notReady, ".aify", "herdr", "invocations", "stray-file"), "");
  assert.deepEqual(await findEnvEndpoint({ env: {}, home: notReady, fetchImpl: nobodyAnswers, state: () => "gone" }),
    { endpoint: DEFAULT, problem: "" }, "an invocation that never became ready, a stray file, and a dead daemon");
  const fetchImpl = answering({ [DAEMON]: { pid: 4242, instance: "inst-1" } });
  assert.deepEqual(await findEnvEndpoint({ env: {}, home: notReady, fetchImpl, state: everyoneAlive }),
    { endpoint: DAEMON, problem: "" }, "and the live one is still found beside them");
  // Linux answers a stray FILE's `<file>/ready.json` with ENOTDIR; Windows answers ENOENT, so it is injected here.
  assert.deepEqual(await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl: nobodyAnswers, state: everyoneAlive,
    io: ioWith({ statSync: failing("ENOTDIR", "ready.json") }) }), { endpoint: DEFAULT, problem: "" }, "ENOTDIR is not ready");
});
