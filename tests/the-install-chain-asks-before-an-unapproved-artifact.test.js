// An artifact neither aify-wrapper's catalogue nor --approve covers used to refuse the run and ask for a rerun with
// --approve <digest>. In a terminal the chain now asks once, through the terminal (stdin carries the key), and a yes
// approves exactly that tuple for this run. --no-prompt, or no terminal, keeps the old refusal.
import assert from "node:assert/strict";
import { test } from "node:test";

import { EXIT_OK, EXIT_REFUSED, InstallChain, parseChainArgs } from "../lib/install-chain.mjs";
import { unapprovedArtifacts } from "../lib/install-chain-host.mjs";

const plan = (...extra) => parseChainArgs(["--connect", "aify-comms=http://comms.test:8800", "--client", "claude",
  "--secret", "aify-comms.credentialRef=/k", ...extra]);
const BRIDGE = { id: "comms-bridge", source: "zimdin12/aify-comms@cab3ab20", digest: "D1" };

function host({ unapproved = [BRIDGE], answer = "y" } = {}) {
  const calls = [];
  const asked = [];
  const io = {
    env: {}, said: [],
    say(line) { this.said.push(line); },
    ask: async () => "",
    askTerminal: async (question) => { asked.push(question); return answer; },
    unapproved: async (name, url, approve) => { calls.push(["unapproved", name, [...approve]]); return unapproved.filter((u) => !approve.includes(u.digest)); },
    publishedKey: async () => false,
    ensurePackages: async () => true,
    approvedInstaller: async (name, url, approve) => { calls.push(["approvedInstaller", [...approve]]); return { path: "/src/install.sh" }; },
    runInstaller: async () => 0,
    connect: async (c) => { calls.push(["connect", [...c.approve]]); return { status: 0, installed: {} }; },
    render: async () => 0,
    cliPresent: () => true,
    packageAssets: async (name, url, approve) => { calls.push(["packageAssets", [...approve]]); return null; },
    registryHash: async () => "R",
    keyEnv: async () => [],
  };
  return { io, calls, asked };
}

test("a yes in the terminal approves exactly that tuple for acquire and connect, asked once, naming it", async () => {
  const given = host();
  const { exit } = await new InstallChain(plan(), given.io).run();
  assert.equal(exit, EXIT_OK);
  assert.equal(given.asked.length, 1);
  assert.match(given.asked[0], /comms-bridge/);
  assert.match(given.asked[0], /zimdin12\/aify-comms@cab3ab20/);
  assert.match(given.asked[0], /D1/);
  assert.deepEqual(given.calls.find((c) => c[0] === "approvedInstaller"), ["approvedInstaller", ["D1"]]);
  assert.deepEqual(given.calls.find((c) => c[0] === "connect"), ["connect", ["D1"]]);
});

test("anything but yes refuses the run, names the artifact, and connects nothing", async () => {
  for (const answer of ["n", "", "maybe"]) {
    const given = host({ answer });
    const { exit, report } = await new InstallChain(plan(), given.io).run();
    assert.equal(exit, EXIT_REFUSED, `answer ${JSON.stringify(answer)}`);
    assert.ok(report.problems.some((p) => p.includes("comms-bridge") && p.includes("not approved")), report.problems.join("; "));
    assert.ok(!given.calls.some((c) => c[0] === "connect"));
  }
});

test("--no-prompt never asks and adds nothing, so connect refuses exactly as before", async () => {
  const given = host();
  await new InstallChain(plan("--no-prompt"), given.io).run();
  assert.equal(given.asked.length, 0);
  assert.deepEqual(given.calls.find((c) => c[0] === "connect"), ["connect", []]);
});

test("with no terminal to ask through, nothing is added and the old refusal stands", async () => {
  const given = host({ answer: null });
  await new InstallChain(plan(), given.io).run();
  assert.equal(given.asked.length, 1);
  assert.deepEqual(given.calls.find((c) => c[0] === "connect"), ["connect", []]);
});

test("CONTROL: an already approved artifact is not asked about", async () => {
  const given = host({ unapproved: [] });
  const { exit } = await new InstallChain(plan(), given.io).run();
  assert.equal(exit, EXIT_OK);
  assert.equal(given.asked.length, 0);
});

test("unapprovedArtifacts lists what neither the catalogue nor --approve covers, and skips a pending source", async () => {
  const spec = { artifacts: [
    { id: "a", kind: "file-set", source: { git: { repo: "o/a", revision: "r1" } } },
    { id: "b", kind: "package", source: { git: { repo: "o/b", revision: "r2" } } },
    { id: "c", kind: "file-set", source: { git: { repo: "o/c", revision: "r3" } } },
    { id: "d", kind: "package", source: { pending: "published later" } },
  ] };
  const p = { fetchSpec: async () => spec, validateSpec: () => ({ ok: true }), tupleDigest: (a) => `T-${a.id}`,
    catalogue: ["T-a"], approve: ["T-b"] };
  assert.deepEqual(await unapprovedArtifacts("svc", "http://x", p), [{ id: "c", source: "o/c@r3", digest: "T-c" }]);
  const refused = { ...p, validateSpec: () => ({ ok: false, errors: ["bad"] }) };
  assert.deepEqual(await unapprovedArtifacts("svc", "http://x", refused), []);
});
