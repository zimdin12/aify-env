// Launch roots added on this host (lib/launch-roots.mjs, `aify-env roots`): a host started at C:\ can start agents on
// D:\ once the operator adds it, a file that is not right adds nothing, and nothing a service sends widens the roots.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { LaunchRoots, launchRootsFrom, launchRootsPath, parseLaunchRoot, readLaunchRootsFile, withLaunchRootAdded,
  withLaunchRootRemoved, writeLaunchRootsFile } from "../lib/launch-roots.mjs";
import { launchRootsCheck } from "../lib/definition-checks.mjs";
import { STATE } from "../lib/health.mjs";
import { handleRequest } from "../lib/protocol.mjs";
import { rootsNow, workspaceWithinRoots } from "../lib/workspace-roots.mjs";
import { outsideRootsDetail, prepareTerminalLaunch } from "../lib/plugins/aify-comms/terminal-controls.mjs";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runRoots } from "../bin/aify-env-roots.mjs";

const B = String.fromCharCode(92);
const win = (text) => parseLaunchRoot(text, { windows: true });
const posix = (text) => parseLaunchRoot(text, { windows: false });
function fixtureHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-roots-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, ".aify", "launch-roots.json") };
}
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };

test("WINDOWS SPELLINGS: every way to type a drive root stores D:/, folders lose a trailing slash and keep their case", () => {
  for (const typed of [`D:${B}`, "D:/", `d:${B}`, "d:", "D:"]) assert.deepEqual(win(typed), { root: "D:/" }, typed);
  assert.deepEqual(win(`d:${B}Games${B}Terraria${B}`), { root: "D:/Games/Terraria" });
  assert.deepEqual(win(`D:${B}Games${B}${B}x`), { root: "D:/Games/x" }, "a doubled separator is one");
});

test("WINDOWS REFUSALS: UNC and device paths (not supported yet), relative, drive-relative, ~, and . or ..", () => {
  for (const typed of [`${B}${B}server${B}share`, "//server/share", `${B}${B}?${B}D:${B}x`, `${B}${B}.${B}pipe${B}x`]) {
    assert.match(win(typed).refused ?? "", /UNC and device paths are not supported yet/, typed);
  }
  for (const typed of ["Games", "~", "D:Games", `${B}Games`, "/Games"]) assert.match(win(typed).refused ?? "", /drive letter/, typed);
  for (const typed of [`D:${B}a${B}..${B}b`, "D:/a/./b"]) assert.match(win(typed).refused ?? "", /names \. or \.\./, typed);
  assert.match(win("  ").refused ?? "", /no folder given/);
});

test("POSIX: / is a root, case is kept and never folded, and only absolute folders count", () => {
  assert.deepEqual(posix("/"), { root: "/" });
  assert.deepEqual(posix("/home/Bob/work/"), { root: "/home/Bob/work" });
  for (const typed of ["~/work", "work", "/a/../b"]) assert.ok(posix(typed).refused, typed);
  assert.deepEqual(launchRootsFrom(JSON.stringify({ version: 1, roots: ["/home/Bob", "/home/bob"] })).roots, ["/home/Bob", "/home/bob"],
    "two spellings are two folders off Windows");
});

test("THE FILE FAILS CLOSED: any fault adds no root at all, and names the fault", () => {
  const good = (roots) => JSON.stringify({ version: 1, roots });
  assert.deepEqual(launchRootsFrom(null, { windows: true }), { roots: [], problem: "" }, "no file is no roots and no fault");
  assert.deepEqual(launchRootsFrom(good([`d:${B}`, "D:/", "E:/Work", "e:/WORK"]), { windows: true }), { roots: ["D:/", "E:/Work"], problem: "" },
    "CONTROL: one root per folder, case folded on Windows");
  for (const [text, fault] of [["{", /not JSON/], ["[]", /not an object/], [JSON.stringify({ version: 2, roots: [] }), /version is 2/],
    [JSON.stringify({ version: 1, roots: "D:/" }), /not a list/], [good(["D:/", `${B}${B}srv${B}x`]), /entry .* is refused/]]) {
    const read = launchRootsFrom(text, { windows: true });
    assert.deepEqual(read.roots, [], `a partial list survived: ${text}`);
    assert.match(read.problem, fault, text);
  }
});

test("LIVE: a root added to the file is in force at the next read, and a broken file leaves the start folder alone", (t) => {
  const { file } = fixtureHome(t);
  const logged = [];
  const roots = new LaunchRoots({ startFolder: `C:${B}`, file, windows: true, log: (line) => logged.push(line) });
  assert.deepEqual(roots.current(), [`C:${B}`], "no file: the start folder only");
  write(file, { version: 1, roots: ["D:/"] });
  assert.deepEqual(roots.current(), [`C:${B}`, "D:/"], "the added root was not picked up without a new instance");
  write(file, "{ not json");
  assert.deepEqual(roots.current(), [`C:${B}`], "a broken file kept the root it used to add");
  assert.equal(roots.read().problem, "it is not JSON");
  assert.match(logged.at(-1) ?? "", /launch-roots\.json is ignored because it is not JSON; work starts only under C:/);
});

test("A FILE THAT BECOMES UNREADABLE adds nothing, though its time and size never changed; and it recovers", () => {
  // Stat answers the same throughout, as it does when only read access is lost (review of e130408, R2).
  const text = JSON.stringify({ version: 1, roots: ["D:/"] });
  let denied = false;
  const io = { statSync: () => ({ mtimeMs: 1, size: text.length }),
    readFileSync: () => { if (denied) throw Object.assign(new Error("denied"), { code: "EACCES" }); return text; } };
  const roots = new LaunchRoots({ startFolder: `C:${B}`, file: "fixture.json", windows: true, io });
  assert.deepEqual(roots.current(), [`C:${B}`, "D:/"], "CONTROL: the readable file adds D:/");
  denied = true;
  assert.deepEqual(roots.current(), [`C:${B}`], "an unreadable file kept the root it added before");
  assert.match(roots.read().problem, /cannot be read \(EACCES\)/);
  denied = false;
  assert.deepEqual(roots.current(), [`C:${B}`, "D:/"], "access came back and the old error stayed");
});

test("THE REAL LAUNCH GUARD refuses D:/ work, admits it once the root is added, and never reads roots from the request", (t) => {
  const { file } = fixtureHome(t);
  const roots = new LaunchRoots({ startFolder: `C:${B}`, file, windows: true });
  // The request names its own wider roots, as a service's `cwdRoots` would: the guard must not read them.
  const launch = { cwd: "D:/Games/terraria-manager", argv: [], cwdRoots: ["D:/"], launchRoots: ["D:/"] };
  const guard = () => prepareTerminalLaunch({ launch, terminalId: "t1", cwdRoots: roots.current(), windows: true,
    withinRoots: workspaceWithinRoots, buildSpec: () => null, resolveCandidates: () => [] });
  assert.equal(guard().rootRefusal, true, "work outside the start folder was let through by the request's own roots");
  write(file, { version: 1, roots: ["D:/"] });
  const admitted = guard();
  assert.equal(admitted.rootRefusal, undefined, "an added root did not admit the work");
  assert.match(admitted.detail, /carries no argv/, "CONTROL: the next check after the root check is the one that answered");
});

test("THE REAL LAUNCH GUARD refuses a service's cwd that climbs out of a root with .., and admits the plain subfolder", () => {
  const guard = (cwd) => prepareTerminalLaunch({ launch: { cwd, argv: [] }, terminalId: "t1", cwdRoots: ["D:/Games"], windows: true,
    withinRoots: workspaceWithinRoots, buildSpec: () => null, resolveCandidates: () => [] });
  assert.equal(guard("D:/Games/../Elsewhere").rootRefusal, true, "a .. cwd reached the spawn as if inside D:/Games");
  const control = guard("D:/Games/terraria-manager");
  assert.equal(control.rootRefusal, undefined, "CONTROL: a plain subfolder was refused");
  assert.match(control.detail, /carries no argv/, "CONTROL: the next check after the root check answered");
});

test("THE DAEMON HANDS EVERY READER the live roots, not a list taken at start", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aify-env.mjs"), "utf8");
  assert.doesNotMatch(source, /CWD_ROOTS/, "a fixed list is still in use");
  assert.match(source, /cwdRoots: async \(\) => LAUNCH_ROOTS\.current\(\)/, "the claim guard's roots are not read per claim");
  assert.match(source, /cwdRoots: \(\) => LAUNCH_ROOTS\.current\(\)/, "agent state judges availability against a fixed list");
  assert.match(source, /launchRootsFile: LAUNCH_ROOTS\.read\(\)/, "/health does not say what the file added");
});

test("aify-env roots add: stores the normalised root and says so, refuses UNC and missing folders, and never writes over a broken file", async (t) => {
  const { dir, file } = fixtureHome(t);
  const folder = path.join(dir, "Games");
  fs.mkdirSync(folder);
  const windows = process.platform === "win32";
  const added = await runRoots(["add", folder], { file, windows });
  assert.equal(added.code, EXIT_OK, added.lines.join("\n"));
  assert.equal(added.lines[0], `stored ${parseLaunchRoot(folder, { windows }).root}`);
  assert.match(added.lines.at(-1), /no aify-env answered; it counts from the next start/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).roots.length, 1);
  // Another spelling of the same folder: any case on Windows, a trailing slash elsewhere.
  const again = await runRoots(["add", windows ? folder.toUpperCase() : `${folder}/`], { file, windows });
  assert.equal(again.code, EXIT_OK);
  assert.match(again.lines[0], /^already a launch root: /, "a second spelling of one folder was stored twice");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).roots.length, 1);

  const before = fs.readFileSync(file);
  if (windows) {
    const unc = await runRoots(["add", `${B}${B}server${B}share`], { file, windows });
    assert.equal(unc.code, EXIT_USAGE);
    assert.match(unc.lines[0], /UNC and device paths are not supported yet/);
  }
  const missing = await runRoots(["add", path.join(dir, "absent")], { file, windows });
  assert.equal(missing.code, EXIT_FAILED);
  assert.match(missing.lines[0], /is not a folder on this host/);
  assert.ok(fs.readFileSync(file).equals(before), "a refused add changed the file");

  write(file, "{ broken");
  const broken = await runRoots(["add", folder], { file, windows });
  assert.equal(broken.code, EXIT_FAILED);
  assert.match(broken.lines[0], /is not written over: it is ignored because it is not JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken", "a broken file was written over");
});

test("aify-env roots add reads back from the live aify-env whether the root is in force there", async (t) => {
  const { dir, file } = fixtureHome(t);
  const windows = process.platform === "win32";
  const root = parseLaunchRoot(dir, { windows }).root;
  const answer = async (health) => (await runRoots(["add", dir], { file, windows, running: async () => health })).lines.at(-1);
  assert.equal(await answer({ cwdRoots: ["/elsewhere", root], launchRootsFile: { stored: [root], problem: "" } }), "in force now in the running aify-env");
  fs.rmSync(file);
  assert.match(await answer({ cwdRoots: ["/elsewhere"] }), /older than added roots: it counts after one ordinary restart/);
  fs.rmSync(file);
  assert.match(await answer({ cwdRoots: ["/elsewhere"], launchRootsFile: { stored: [], problem: "" } }), /does not report it yet/,
    "a daemon that does not list the root was reported as having it");
});

test("aify-env roots add of a root already stored writes nothing, and still says whether the running aify-env counts it", async (t) => {
  const { dir, file } = fixtureHome(t);
  const windows = process.platform === "win32";
  await runRoots(["add", dir], { file, windows });
  const before = fs.readFileSync(file);
  const again = await runRoots(["add", dir], { file, windows, running: async () => ({ cwdRoots: ["/elsewhere"] }) });
  assert.equal(again.code, EXIT_OK);
  assert.match(again.lines[0], /^already a launch root: /);
  assert.match(again.lines.at(-1), /older than added roots: it counts after one ordinary restart/,
    "a duplicate add hid that the running aify-env does not read added roots");
  assert.ok(fs.readFileSync(file).equals(before), "a duplicate add changed the file");
});

test("aify-env roots remove takes out any spelling of a stored root and refuses one that is not stored", async (t) => {
  const { file } = fixtureHome(t);
  write(file, { version: 1, roots: ["D:/", "E:/Work"] });
  const removed = await runRoots(["remove", "d:"], { file, windows: true });
  assert.equal(removed.code, EXIT_OK);
  assert.equal(removed.lines[0], "removed D:/");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).roots, ["E:/Work"]);
  const absent = await runRoots(["remove", "F:/"], { file, windows: true });
  assert.equal(absent.code, EXIT_FAILED);
  assert.match(absent.lines[0], /F:\/ is not an added launch root; added: E:\/Work/);
  for (const argv of [[], ["add"], ["list", "x"], ["drop", "D:/"], ["add", "D:/", "E:/"]]) {
    assert.equal((await runRoots(argv, { file, windows: true })).code, EXIT_USAGE, JSON.stringify(argv));
  }
});

test("THE DOCTOR'S launch-roots ROW lists where work starts, names an ignored file, and is unanswered without a daemon", () => {
  const fine = launchRootsCheck({ answered: true, roots: [`C:${B}`, "D:/"], file: { file: "f", stored: ["D:/"], problem: "" } });
  assert.equal(fine.state, STATE.PASSED);
  assert.equal(fine.detail, `work starts under C:${B}, D:/ (1 added on this host with \`aify-env roots add\`)`);
  const startOnly = launchRootsCheck({ answered: true, roots: [`C:${B}`], file: { file: "f", stored: [], problem: "" } });
  assert.match(startOnly.detail, /^work starts under C:.*, the folder it was started in/);
  const ignored = launchRootsCheck({ answered: true, roots: [`C:${B}`], file: { file: "~/.aify/launch-roots.json", stored: [], problem: "it is not JSON" } });
  assert.equal(ignored.state, STATE.FAILED);
  assert.match(ignored.detail, /only: ~\/\.aify\/launch-roots\.json is ignored because it is not JSON/);
  assert.match(launchRootsCheck({ answered: true, roots: [`C:${B}`] }).detail, /older than added launch roots/);
  for (const input of [{ answered: false }, { answered: true, roots: null }, { answered: true, roots: [] }]) {
    assert.equal(launchRootsCheck(input).state, STATE.UNANSWERED, JSON.stringify(input));
  }
});

test("/health carries what the launch-roots file added, and null when the daemon does not say", async () => {
  const base = { runner: { list: () => [] }, readFile: () => "", version: "0.0.0", unknown: [], terminals: {}, traffic: {} };
  const health = async (deps) => (await handleRequest({ method: "GET", path: "/health" }, { ...base, ...deps })).body;
  assert.deepEqual((await health({ launchRootsFile: { file: "f", stored: ["D:/"], problem: "", extra: 1 } })).launchRootsFile,
    { file: "f", stored: ["D:/"], problem: "" });
  assert.equal((await health({})).launchRootsFile, null);
});

test("THE STORE'S PIECES: the path, add and remove by the guard's fold, and a write that a read gives back whole", async (t) => {
  const { dir, file } = fixtureHome(t);
  assert.equal(launchRootsPath(dir), path.join(dir, ".aify", "launch-roots.json"));
  assert.deepEqual(withLaunchRootAdded(["D:/"], "E:/Work", { windows: true }), { roots: ["D:/", "E:/Work"], already: "" });
  assert.deepEqual(withLaunchRootAdded(["E:/Work"], "e:/work", { windows: true }), { roots: ["E:/Work"], already: "E:/Work" });
  assert.deepEqual(withLaunchRootAdded(["/home/Bob"], "/home/bob", { windows: false }).roots, ["/home/Bob", "/home/bob"], "folded off Windows");
  assert.deepEqual(withLaunchRootRemoved(["D:/", "E:/Work"], "e:/WORK", { windows: true }), { roots: ["D:/"], removed: "E:/Work" });
  assert.deepEqual(withLaunchRootRemoved(["D:/"], "F:/", { windows: true }), { roots: ["D:/"], removed: "" });
  assert.deepEqual(readLaunchRootsFile(file), { text: null, problem: "" }, "an absent file is no text and no fault");
  writeLaunchRootsFile(file, ["D:/", "E:/Work"]);
  assert.deepEqual(launchRootsFrom(readLaunchRootsFile(file).text, { windows: true }), { roots: ["D:/", "E:/Work"], problem: "" });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["launch-roots.json"], "the write left its temporary file behind");
  const denied = readLaunchRootsFile(file, { readFileSync: () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } });
  assert.deepEqual(denied, { text: null, problem: "it cannot be read (EACCES)" });
});

test("THE GUARDS' SHARED PIECES: one refusal sentence, and roots asked now from a supplier or taken as given", async () => {
  assert.equal(outsideRootsDetail("D:/x"), 'Workspace "D:/x" is outside this environment\'s advertised roots');
  const given = ["C:/"];
  assert.equal(await rootsNow(given), given, "an array is the answer as given");
  let asked = 0;
  assert.deepEqual(await rootsNow(async () => { asked += 1; return ["D:/"]; }), ["D:/"]);
  assert.deepEqual(await rootsNow(() => ["E:/"]), ["E:/"], "a plain function supplier");
  assert.equal(asked, 1, "the supplier was asked once per call");
});
