// `aify-env agents import` asks the environment that is running, including a `herdr-aify env` daemon on the port
// the OS picked. It knew only the default port and said "the environment did not answer" beside a running daemon
// (2026-10-04). These drive `importEndpoint`, which the command's main calls, against a temporary home holding a
// receipt and a fake fetch: no real port is touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importEndpoint } from "../bin/aify-env-agents.mjs";
import { chooseEnvEndpoint } from "../lib/serving-endpoint.mjs";

const DEFAULT = "http://127.0.0.1:8802";
const DAEMON = "http://127.0.0.1:49999";

function homeWithReceipt() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aify-import-home-"));
  const dir = path.join(home, ".aify", "herdr", "invocations", "inv-1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ready.json"), JSON.stringify({ endpoint: DAEMON, pid: 4242, envInstance: "inst-1" }));
  return home;
}

/** A fetch where only the named endpoints answer /health, with the identity given. */
const answering = (identities) => async (url) => {
  const base = Object.keys(identities).find((endpoint) => url === `${endpoint}/health`);
  if (!base) throw new Error("ECONNREFUSED");
  return { ok: true, json: async () => identities[base] };
};

test("nothing at the default port: the live daemon its receipt names is the one asked", async () => {
  const fetchImpl = answering({ [DAEMON]: { pid: 4242, instance: "inst-1" } });
  assert.equal(await importEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl }), DAEMON);
});

test("a receipt whose address answers as another daemon is not taken", async () => {
  const fetchImpl = answering({ [DAEMON]: { pid: 7, instance: "someone-else" } });
  assert.equal(await importEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl }), DEFAULT, "falls back to the default");
});

test("CONTROLS: a named endpoint wins, and an environment at the default port is kept", async () => {
  const fetchImpl = answering({ [DAEMON]: { pid: 4242, instance: "inst-1" }, [DEFAULT]: { pid: 1, instance: "default" } });
  assert.equal(await importEndpoint({ env: { AIFY_ENV_ENDPOINT: "http://127.0.0.1:5555" }, home: homeWithReceipt(), fetchImpl }),
    "http://127.0.0.1:5555");
  assert.equal(await importEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl }), DEFAULT);
});

test("chooseEnvEndpoint: a named endpoint is taken without asking anything", async () => {
  const fetchHealth = async () => assert.fail("a named endpoint needs no knock");
  assert.equal(await chooseEnvEndpoint({ named: "http://127.0.0.1:5555", defaultEndpoint: DEFAULT, fetchHealth }), "http://127.0.0.1:5555");
});
