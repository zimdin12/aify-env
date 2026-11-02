// A managed agent whose workspace is outside the folder aify-env was started in cannot be started by it, and nothing said
// so until a spawn was refused (2026-10-13: started in C:\Docker\aify-comms, dashboard-manager at C:/Docker/aify-dashboard
// and nearly every other managed agent refused). The startup warning and the `agents-outside-roots` doctor row both
// come from `definitionsOutsideRoots`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { addHintFor, agentsOutsideRootsCheck, definitionsOutsideRoots, outsideRootsWarning } from "../lib/definition-checks.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { STATE } from "../lib/health.mjs";
import { handleRequest } from "../lib/protocol.mjs";

const ROOTS = ["C:\\Docker\\aify-comms"];
const managed = (id, workspace) => ({ id, agent: { mode: "managed", workspace } });
const DEFINITIONS = [
  managed("dashboard-manager", "C:/Docker/aify-dashboard"),
  managed("gov-tui", "c:/docker/AIFY-COMMS/tui"),
  { id: "pc-manager", agent: { mode: "resident", workspace: "C:\\Docker" } },
];

test("A MANAGED AGENT OUTSIDE THE ROOTS is named; one inside (any case, on Windows) and a resident are not", () => {
  assert.deepEqual(definitionsOutsideRoots(DEFINITIONS, ROOTS, { windows: true }),
    [{ id: "dashboard-manager", workspace: "C:/Docker/aify-dashboard" }]);
});

test("OFF WINDOWS, case is a different folder", () => {
  assert.deepEqual(definitionsOutsideRoots([managed("a", "/home/Bob/work")], ["/home/bob"], { windows: false }),
    [{ id: "a", workspace: "/home/Bob/work" }]);
  assert.deepEqual(definitionsOutsideRoots([managed("a", "/home/bob/work")], ["/home/bob"], { windows: false }), []);
});

test("THE STARTUP WARNING names the agent, its workspace, the roots and the fix, and is silent when none are outside", () => {
  const warning = outsideRootsWarning(DEFINITIONS, ROOTS, { windows: true });
  assert.match(warning, /dashboard-manager \(C:\/Docker\/aify-dashboard\)/);
  assert.match(warning, /C:\\Docker\\aify-comms/);
  assert.ok(warning.includes('`aify-env roots add "C:/Docker/aify-dashboard"`, or a folder above it'), warning);
  assert.doesNotMatch(warning, /start it again/, "the warning still sends the operator to restart aify-env");
  assert.equal(outsideRootsWarning(DEFINITIONS.slice(1), ROOTS, { windows: true }), "");
});

test("THE DOCTOR ROW fails naming them, passes when none, and is unanswered without evidence", () => {
  const listed = { definitions: DEFINITIONS };
  const failing = agentsOutsideRootsCheck({ answered: true, roots: ROOTS, listed, windows: true });
  assert.equal(failing.state, STATE.FAILED);
  assert.match(failing.detail, /dashboard-manager/);
  assert.ok(failing.fix.includes('`aify-env roots add "C:/Docker/aify-dashboard"`'), failing.fix);
  const two = agentsOutsideRootsCheck({ answered: true, roots: ROOTS, windows: true,
    listed: { definitions: [managed("a", "D:/Games/one"), managed("b", "E:/two")] } });
  assert.ok(two.fix.startsWith('add each folder above as a launch root on this host, starting with `aify-env roots add "D:/Games/one"`'), two.fix);
  assert.equal(agentsOutsideRootsCheck({ answered: true, roots: ["C:\\"], listed, windows: true }).state, STATE.PASSED);
  for (const input of [{ answered: false }, { answered: true, roots: null, listed }, { answered: true, roots: [], listed },
    { answered: true, roots: ROOTS, listed: null }]) {
    assert.equal(agentsOutsideRootsCheck({ ...input, windows: true }).state, STATE.UNANSWERED, JSON.stringify(input));
  }
});

test("THE SUGGESTED COMMAND keeps a folder with spaces one argument, and is never one the command would refuse", async (t) => {
  const B = String.fromCharCode(92);
  const fixFor = (workspaces) => agentsOutsideRootsCheck({ answered: true, roots: ROOTS, windows: true,
    listed: { definitions: workspaces.map((workspace, i) => managed(`a${i}`, workspace)) } }).fix;
  await t.test("spaces are quoted", () => assert.ok(fixFor(["D:/My Games/x"]).includes('`aify-env roots add "D:/My Games/x"`'), fixFor(["D:/My Games/x"])));
  // The parser refuses these on Windows (the CLI would too), so moving is the honest advice, with the parser's reason.
  for (const [workspace, reason] of [[`${B}${B}server${B}share${B}x`, /UNC and device paths are not supported yet/],
    ["D:/Games/../x", /names \. or \.\./], ["D:/two\nlines", /drive letter/], ["D:/car\rriage", /drive letter/]]) {
    await t.test(`a folder that cannot be a root is told to move, and why: ${JSON.stringify(workspace)}`, () => {
      const fix = fixFor([workspace]);
      assert.doesNotMatch(fix, /aify-env roots add "/, `suggested a command for ${workspace}: ${fix}`);
      assert.match(fix, /move its workspace under a launch root: `aify-env roots add` refuses it/);
      assert.match(fix, reason);
    });
  }
  // Valid roots with no portable spelling: no hint, and never told the folder is refused or must move.
  for (const workspace of ['D:/a"b', "D:/$HOME", "D:/%PATH%", "D:/Wow!", "D:/tab\there", "D:/bell\u0007"]) {
    await t.test(`no hint, but still a valid root: ${JSON.stringify(workspace)}`, () => {
      const fix = fixFor([workspace]);
      assert.doesNotMatch(fix, /aify-env roots add "/, `suggested a command for ${JSON.stringify(workspace)}: ${fix}`);
      assert.match(fix, /quoted for your shell/);
      assert.doesNotMatch(fix, /move|cannot be/, `a valid root was called refused: ${fix}`);
    });
  }
  await t.test("no backslash ever meets the closing quote: Windows folders are named with forward slashes", () => {
    for (const [workspace, named] of [[`D:${B}`, '"D:/"'], [`d:${B}Games${B}x${B}`, '"D:/Games/x"'], [`D:${B}My Games`, '"D:/My Games"']]) {
      const fix = fixFor([workspace]);
      assert.ok(fix.includes(`\`aify-env roots add ${named}\``), `${workspace}: ${fix}`);
      assert.ok(!fix.includes(`${B}"`), `${workspace}: a backslash meets the quote: ${fix}`);
    }
  });
  await t.test("on POSIX a backslash in the folder gets no command", () => {
    const fix = agentsOutsideRootsCheck({ answered: true, roots: ["/srv"], windows: false,
      listed: { definitions: [managed("p", `/home/bob/odd${B}name`)] } }).fix;
    assert.doesNotMatch(fix, /aify-env roots add "/, fix);
    assert.match(fix, /quoted for your shell/, "a valid POSIX root with a backslash was called refused");
  });
  await t.test("on POSIX a line break is a valid name but gets no command", () => {
    const fix = agentsOutsideRootsCheck({ answered: true, roots: ["/srv"], windows: false,
      listed: { definitions: [managed("p", "/home/bob/two\nlines")] } }).fix;
    assert.doesNotMatch(fix, /aify-env roots add "/, fix);
    assert.match(fix, /quoted for your shell/);
  });
  await t.test("the first folder the command accepts is the one named", () => {
    assert.ok(fixFor(["//server/share", "E:/two"]).includes('starting with `aify-env roots add "E:/two"`'), fixFor(["//server/share", "E:/two"]));
  });
});

test("THE ROW IS COLLECTED from the daemon's own /health roots when the doctor can read definitions", async () => {
  const base = {
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ supported: true, reason: "" }),
    readCredentialStore: async () => ({ names: [] }),
    endpoint: "http://127.0.0.1:8802",
    windows: true,
    knock: async () => ({ ok: true, status: 200, body: {
      status: "healthy", pid: 1, instance: "i1", processes: [], unknown: [], terminals: {}, cwdRoots: ROOTS } }),
  };
  const row = (checks) => checks.find((check) => check.id === "agents-outside-roots");
  const collected = row(await collectEnvironmentChecks({ ...base, listDefinitions: async () => ({ definitions: DEFINITIONS }) }));
  assert.equal(collected?.state, STATE.FAILED);
  assert.equal(row(await collectEnvironmentChecks(base)), undefined, "the view, which cannot read definitions, gets no row");
});

test("/health CARRIES THE FOLDERS this daemon was started in, and null when it does not say", async () => {
  const base = { runner: { list: () => [] }, readFile: () => "", version: "0.0.0", unknown: [], terminals: {}, traffic: {} };
  const health = async (deps) => (await handleRequest({ method: "GET", path: "/health" }, { ...base, ...deps })).body;
  assert.deepEqual((await health({ cwdRoots: ROOTS })).cwdRoots, ROOTS);
  assert.equal((await health({})).cwdRoots, null);
});

test("A PARTLY READ LISTING IS UNANSWERED, never a pass: the unread entry may be the one outside", () => {
  // 0.9.2 review: an incomplete enumeration, an unreadable entry or a conflict read as "every managed agent can start".
  const inside = [managed("lead", "C:/Docker/aify-comms/x")];
  for (const gap of [{ unreadable: ["broken"] }, { conflict: { intent: "x" } }, { enumerationFailed: true }]) {
    const row = agentsOutsideRootsCheck({ answered: true, roots: ["C:\\"], listed: { definitions: inside, ...gap }, windows: true });
    assert.equal(row.state, STATE.UNANSWERED, JSON.stringify(gap));
  }
  const found = agentsOutsideRootsCheck({ answered: true, roots: ["C:/Docker/aify-comms"], windows: true,
    listed: { definitions: [managed("dash", "C:/Docker/aify-dashboard")], unreadable: ["broken"] } });
  assert.equal(found.state, STATE.FAILED, "what was found still fails");
  assert.equal(agentsOutsideRootsCheck({ answered: true, roots: ["C:\\"], listed: { definitions: inside, unreadable: [] },
    windows: true }).state, STATE.PASSED, "CONTROL: a complete listing still passes");
});

test("addHintFor IS EXPORTED for comms' specimen parity, and answers each of its three shapes", () => {
  // comms' twin (service/api_core/workspace.py add_hint) compares against this export specimen for specimen.
  assert.deepEqual(addHintFor("D:/Games/x", true), { command: '`aify-env roots add "D:/Games/x"`' });
  assert.deepEqual(addHintFor("D:/$HOME", true), { unquotable: true });
  assert.ok(typeof addHintFor("//server/share", true).refused === "string" && addHintFor("//server/share", true).refused.length > 0);
});
