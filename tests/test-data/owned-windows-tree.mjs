// Native Windows held-handle qualification on a fixture-known tree only: the client this test started and the one
// grandchild that client reported. Never global process discovery.
//
// ⛔ INTENTIONAL INJECTION. The tests that use this hand endOwnedChildTree (the core, unchanged) a `held` port that is
// the core heldKill (unchanged: its stillOurs handshake, its helper source, its result parsing), with only heldKill's
// injected `start` wrapped. The wrapper checks that the helper it was asked to start is exactly the core's, then starts
// it with the unchanged HELPER_SOURCE compiled together with KnownTreeWin, an IHeldWin that:
// - Open: real OpenProcess, ONLY for the fixture's root and grandchild pids; any other pid throws, and the helper fails.
// - Times/Parent/Terminate/Wait/Close: real calls, ONLY on handles this adapter opened; any other handle throws.
// - Processes: the two known {pid, ppid} rows and nothing else. RealHeldWin.Processes is never called, so no snapshot of
//   this host's processes is read and no process outside the fixture can become a candidate.
// The grandchild is still judged by HeldKill.Classify on its OWN handle (real parent id and creation time), so a row
// this file asserts is not taken on trust: a grandchild whose real parent is not the root is foreign and is not ended.
// "Ended" here therefore means the fixture's known tree; a helper process Windows attaches to it (a conhost) is not in
// the rows and is not touched. The default provider->core routing (no injected `held`) is proved separately, with
// tripwire fakes, not here.
//
// This file is NEVER a mutant population: it exists to run real handles on processes the test itself created.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from 'node:crypto';

import { heldKill, helperScript, HELPER_SOURCE, powershellPath, SOURCE_VARIABLE } from "../../lib/held-process-tree.mjs";

/** The adapter's C# travels in the helper's environment beside the core's, as the core's does (not on the command line). */
export const ADAPTER_VARIABLE = "AIFY_KNOWN_TREE_SOURCE";

/**
 * Appended after HELPER_SOURCE in one compilation unit, so it sees IHeldWin, RealHeldWin and HeldKill. C# 5 only and
 * mscorlib types only (Windows PowerShell 5.1's Add-Type): no HashSet, no expression-bodied members.
 */
export const ADAPTER_SOURCE = `
public class KnownTreeWin : IHeldWin {
  readonly RealHeldWin real = new RealHeldWin();
  readonly uint root, grandchild, rootParent;
  readonly System.Collections.Generic.List<System.IntPtr> issued = new System.Collections.Generic.List<System.IntPtr>();
  public KnownTreeWin(uint root, uint grandchild, uint rootParent) { this.root = root; this.grandchild = grandchild; this.rootParent = rootParent; }
  void Issued(System.IntPtr handle) {
    if (!issued.Contains(handle)) throw new System.InvalidOperationException("not a handle this fixture opened");
  }
  public bool Open(uint pid, out System.IntPtr handle, out int error) {
    if (pid != root && pid != grandchild) throw new System.InvalidOperationException("not a fixture process: " + pid);
    bool ok = real.Open(pid, out handle, out error);
    if (ok) issued.Add(handle);
    return ok;
  }
  public bool Times(System.IntPtr handle, out long created, out int error) { Issued(handle); return real.Times(handle, out created, out error); }
  public int Parent(System.IntPtr handle, out ulong ppid) { Issued(handle); return real.Parent(handle, out ppid); }
  public bool Terminate(System.IntPtr handle, out int error) { Issued(handle); return real.Terminate(handle, out error); }
  public uint Wait(System.IntPtr handle, uint ms) { Issued(handle); return real.Wait(handle, ms); }
  public void Close(System.IntPtr handle) { Issued(handle); issued.Remove(handle); real.Close(handle); }
  public System.Collections.Generic.List<uint[]> Processes(out bool made, out int madeError, out bool firstOk, out int firstError, out int stopError) {
    made = true; madeError = 0; firstOk = true; firstError = 0; stopError = HeldKill.NO_MORE_FILES;
    var rows = new System.Collections.Generic.List<uint[]>();
    rows.Add(new uint[] { root, rootParent });
    rows.Add(new uint[] { grandchild, root });
    return rows;
  }
}
`;

const isPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xFFFFFFFF;

/** The PowerShell that runs the core's HeldKill.Run on the known tree. Every number is checked before it is written. */
function knownTreeScript(root, grandchild, rootParent) {
  for (const pid of [root, grandchild, rootParent]) if (!isPid(pid)) throw new Error(`not a process id: ${String(pid)}`);
  return `$ErrorActionPreference = 'Stop'\n`
    + `Add-Type -TypeDefinition ($env:${SOURCE_VARIABLE} + $env:${ADAPTER_VARIABLE})\n`
    + `exit [HeldKill]::Run(${root}, [KnownTreeWin]::new(${root}, ${grandchild}, ${rootParent}), [Console]::In, [Console]::Out)\n`;
}

const decode = (encoded) => Buffer.from(String(encoded), "base64").toString("utf16le");
const encode = (script) => Buffer.from(script, "utf16le").toString("base64");

/**
 * The tree one test started: its root from the ChildProcess runChild actually spawned, its grandchild from the root's
 * pids file once that file names the same root. Until both are known, the held port ends nothing.
 */
export class KnownWindowsTree {
  #root = null;
  #grandchild = null;
  #selfPid;
  #spawnHelper;
  #heldCalls = [];
  #helpersStarted = 0;
  #helperInputs = [];
  #recordOnly;

  constructor({ selfPid = process.pid, spawnHelper = spawn, recordOnly = false } = {}) {
    this.#selfPid = selfPid;
    this.#spawnHelper = spawnHelper;
    this.#recordOnly = recordOnly === true;
  }

  get root() { return this.#root; }
  get grandchild() { return this.#grandchild; }
  /** Every pid the core asked the held port to end, in order. */
  get heldCalls() { return [...this.#heldCalls]; }
  /** How many kill helpers this tree let start. */
  get helpersStarted() { return this.#helpersStarted; }
  get recordOnly() { return this.#recordOnly; }
  get helperInputs() { return this.#helperInputs.map(row => ({ ...row, before: { ...row.before }, after: row.after && { ...row.after } })); }

  /** runChild's `start`, wrapped: the root is the pid of the process actually started, recorded once. */
  adopt(child) {
    if (this.#root === null && isPid(child?.pid)) this.#root = child.pid;
    return child;
  }

  /** Learn the grandchild from the root's own pids file; the file must name the adopted root. Returns what it read. */
  learn(pidsFile) {
    const pids = JSON.parse(readFileSync(pidsFile, "utf8"));
    if (this.#root === null) throw new Error("no root was adopted, so the pids file cannot be checked against it");
    if (pids.child !== this.#root) throw new Error(`the pids file names client ${pids.child}, not the started ${this.#root}`);
    if (!isPid(pids.grandchild) || pids.grandchild === this.#root || pids.grandchild === this.#selfPid) {
      throw new Error(`not a fixture grandchild: ${String(pids.grandchild)}`);
    }
    this.#grandchild = pids.grandchild;
    return pids;
  }

  /** endOwnedChildTree's `held` port: the core heldKill, its start restricted to this tree. */
  held = (pid, { stillOurs, timeoutMs } = {}) => {
    this.#heldCalls.push(pid);
    if (this.#root === null || this.#grandchild === null) return Promise.reject(new Error("the fixture tree is not known yet, so nothing was killed"));
    if (pid !== this.#root) return Promise.reject(new Error(`${pid} is not the fixture's root ${this.#root}, so nothing was killed`));
    // Negative probe input, not a killer mutation: record the request, issue no native effect, then test-owned DONE cleanup.
    if (this.#recordOnly) return Promise.resolve();
    return heldKill(pid, { stillOurs, timeoutMs, start: (file, args, options) => this.#start(pid, file, args, options) });
  };

  /** Start the core's helper only if it is exactly the core's helper for this root; run it on the known tree. */
  #start(pid, file, args, options) {
    const expected = powershellPath();
    if (expected === null || file !== expected) throw new Error(`not the core's PowerShell: ${String(file)}`);
    if (!Array.isArray(args) || args.at(-2) !== "-EncodedCommand") throw new Error("not the core's helper command line");
    if (decode(args.at(-1)) !== helperScript(pid)) throw new Error("not the core's helper script for the fixture root");
    if (options?.env?.[SOURCE_VARIABLE] !== HELPER_SOURCE) throw new Error("the helper environment does not carry the core's source");
    const script = knownTreeScript(this.#root, this.#grandchild, this.#selfPid);
    this.#helpersStarted += 1;
    const payload = Object.freeze({ script, source: HELPER_SOURCE, adapter: ADAPTER_SOURCE });
    const hashes = () => Object.fromEntries(Object.entries(payload).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')]));
    const binding = { root: this.#root, grandchild: this.#grandchild, script, before: hashes(), after: null };
    this.#helperInputs.push(binding);
    const helper = this.#spawnHelper(file, [...args.slice(0, -1), encode(script)], { ...options, env: { ...options.env, [ADAPTER_VARIABLE]: ADAPTER_SOURCE } });
    helper.once('close', () => { binding.after = hashes(); });
    return helper;
  }
}
