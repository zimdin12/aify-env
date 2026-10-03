// `aify-env agents import`, `attach` and `run` ask the environment that is running, including a `herdr-aify env`
// daemon on the port the OS picked. Each knew only the default port and said "no environment answered" beside a
// running daemon (2026-10-04). These drive `findEnvEndpoint`, which all three call, against a temporary home
// holding a receipt and a fake fetch: no real port is touched. Which commands call it is held below by reading
// their source, since running them would start or attach to real processes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chooseEnvEndpoint, findEnvEndpoint } from "../lib/serving-endpoint.mjs";

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
  assert.equal(await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl }), DAEMON);
});

test("a receipt whose address answers as another daemon is not taken", async () => {
  const fetchImpl = answering({ [DAEMON]: { pid: 7, instance: "someone-else" } });
  assert.equal(await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl }), DEFAULT, "falls back to the default");
});

test("CONTROLS: a named endpoint wins, and an environment at the default port is kept", async () => {
  const fetchImpl = answering({ [DAEMON]: { pid: 4242, instance: "inst-1" }, [DEFAULT]: { pid: 1, instance: "default" } });
  assert.equal(await findEnvEndpoint({ env: { AIFY_ENV_ENDPOINT: "http://127.0.0.1:5555" }, home: homeWithReceipt(), fetchImpl }),
    "http://127.0.0.1:5555");
  assert.equal(await findEnvEndpoint({ env: {}, home: homeWithReceipt(), fetchImpl }), DEFAULT);
});

test("chooseEnvEndpoint: a named endpoint is taken without asking anything", async () => {
  const fetchHealth = async () => assert.fail("a named endpoint needs no knock");
  assert.equal(await chooseEnvEndpoint({ named: "http://127.0.0.1:5555", defaultEndpoint: DEFAULT, fetchHealth }), "http://127.0.0.1:5555");
});

test("EVERY CLIENT COMMAND asks through it, and none keeps its own default-port constant", () => {
  const bin = fileURLToPath(new URL("../bin/", import.meta.url));
  for (const command of ["aify-env-agents.mjs", "aify-env-attach.mjs", "aify-env-run.mjs"]) {
    const source = fs.readFileSync(path.join(bin, command), "utf8");
    assert.match(source, /await findEnvEndpoint\(\)/, `${command} asks through findEnvEndpoint`);
    assert.doesNotMatch(source, /127\.0\.0\.1:8802/, `${command} keeps no default-port constant of its own`);
  }
});
