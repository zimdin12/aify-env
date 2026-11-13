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
    policyReadiness: () => ({ state: "ready", command: null, reason: "fixture ready" }),
    preparePolicy: async () => { throw new Error("unexpected policy preparation"); },
    windows: false,
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

test("--no-prompt refuses an unknown artifact before connect with one complete digest-bound command", async () => {
  const given = host();
  const { exit } = await new InstallChain(plan("--no-prompt"), given.io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.equal(given.asked.length, 0);
  assert.equal(given.calls.some(c => c[0] === "connect"), false);
  const commands = given.io.said.join("\n").split("\n").filter(line => line.startsWith("'aify-env' 'install'"));
  assert.equal(commands.length, 1);
  assert.equal(commands[0], "'aify-env' 'install' '--connect' 'aify-comms=http://comms.test:8800' '--client' 'claude' '--secret' 'aify-comms.credentialRef=/k' '--no-prompt' '--approve' 'D1'");
});

test("with no terminal, an unknown artifact refuses before connect and prints the same runnable action", async () => {
  const given = host({ answer: null });
  const { exit } = await new InstallChain(plan(), given.io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.equal(given.asked.length, 1);
  assert.equal(given.calls.some(c => c[0] === "connect"), false);
  assert.equal(given.io.said.join("\n").split("\n").filter(line => line.startsWith("'aify-env' 'install'")).length, 1);
});

test("CONTROL: an already approved artifact is not asked about", async () => {
  const given = host({ unapproved: [] });
  const { exit } = await new InstallChain(plan(), given.io).run();
  assert.equal(exit, EXIT_OK);
  assert.equal(given.asked.length, 0);
});

const PREPARE = { file: "/usr/bin/node", args: ["/wrapper/channel-install.mjs", "prepare-policy", "--path", "/etc/policy.json"], elevate: true };

for (const answer of [null, "n", "yes"]) {
  test(`policy-only preparation requires consent and a fresh owner read, answer ${answer}`, async () => {
    const given = host({ unapproved: [], answer });
    let reads = 0, preparations = 0;
    given.io.policyReadiness = clients => {
      assert.deepEqual(clients, ["claude"]);
      reads++;
      return preparations ? { state: "ready", command: null, reason: "prepared" }
        : { state: "needs-action", command: PREPARE, reason: "absent policy" };
    };
    given.io.preparePolicy = async command => { assert.equal(command, PREPARE); preparations++; return 0; };
    const { exit } = await new InstallChain(plan(), given.io).run();
    const yes = answer === "yes";
    assert.equal(exit, yes ? EXIT_OK : EXIT_REFUSED);
    assert.equal(preparations, yes ? 1 : 0);
    assert.equal(reads, yes ? 2 : 1);
    assert.equal(given.calls.some(c => c[0] === "connect"), yes);
    if (!yes) assert.equal(given.io.said.join("\n").split("\n").filter(line => line.startsWith("'sudo' '/usr/bin/node'")).length, 1);
  });
}

test("noninteractive policy absence never prompts, prepares or publishes", async () => {
  const given = host({ unapproved: [] });
  given.io.policyReadiness = () => ({ state: "needs-action", command: PREPARE, reason: "absent" });
  const { exit } = await new InstallChain(plan("--no-prompt"), given.io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.equal(given.asked.length, 0);
  assert.equal(given.calls.some(c => c[0] === "connect"), false);
});

test("a preparation exit zero without owner readiness still refuses before publication", async () => {
  const given = host({ unapproved: [], answer: "yes" });
  given.io.policyReadiness = () => ({ state: "needs-action", command: PREPARE, reason: "still absent" });
  given.io.preparePolicy = async () => 0;
  const { exit } = await new InstallChain(plan(), given.io).run();
  assert.equal(exit, EXIT_REFUSED);
  assert.equal(given.calls.some(c => c[0] === "connect"), false);
});

test("an unknown or owner-refused policy result cannot authorize connect", async () => {
  for (const result of [null, { state: "unknown" }, { state: "refused", command: null, reason: "admin policy" }]) {
    const given = host({ unapproved: [] });
    given.io.policyReadiness = () => result;
    const { exit } = await new InstallChain(plan(), given.io).run();
    assert.equal(exit, EXIT_REFUSED);
    assert.equal(given.calls.some(c => c[0] === "connect"), false);
  }
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
