// The Windows kill helper, run through its own Run with every Win32 call scripted: only a read that succeeded may lead
// to "ended" or to "not ours", and one that failed is a stated problem (comms-senior-dev, on 05dc655).
//
// The helper's own C# (HELPER_SOURCE, the string the kill compiles) is compiled here with a fake IHeldWin beside it, and
// Run is called with that fake: no process is opened or ended. Each case says what Run printed, what it exited with, and
// which pids TerminateProcess was handed, so a Run that skipped the decision, or ended what it could not identify, is
// seen in what it did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { HELPER_SOURCE, SOURCE_VARIABLE, helperEnv, helperScript, powershellPath } from "../lib/plugins/aify-dashboard/held-kill.mjs";

const onlyWindows = process.platform !== "win32" && "the helper is Windows PowerShell";

// A tree of root 100, child 200 and grandchild 300, created in that order. A scenario changes what one call returns.
const FAKE_SOURCE = `
public class FakeHeldWin : IHeldWin {
  public System.Collections.Generic.Dictionary<uint, int> OpenError = new System.Collections.Generic.Dictionary<uint, int>();
  public System.Collections.Generic.Dictionary<uint, int> TimesError = new System.Collections.Generic.Dictionary<uint, int>();
  public System.Collections.Generic.Dictionary<uint, int> QueryStatus = new System.Collections.Generic.Dictionary<uint, int>();
  public System.Collections.Generic.Dictionary<uint, ulong> ParentOf = new System.Collections.Generic.Dictionary<uint, ulong>();
  public System.Collections.Generic.Dictionary<uint, long> Created = new System.Collections.Generic.Dictionary<uint, long>();
  public System.Collections.Generic.List<uint[]> Listing = new System.Collections.Generic.List<uint[]>();
  public bool Made = true; public int MadeError = 0; public bool FirstOk = true; public int FirstError = 0; public int StopError = 18;
  public System.Collections.Generic.List<uint> Terminated = new System.Collections.Generic.List<uint>();
  System.Collections.Generic.HashSet<uint> ended = new System.Collections.Generic.HashSet<uint>();

  public FakeHeldWin() {
    ParentOf[200] = 100; ParentOf[300] = 200;
    Created[100] = 1000; Created[200] = 2000; Created[300] = 3000;
    Listing.Add(new uint[] { 100, 1 }); Listing.Add(new uint[] { 200, 100 }); Listing.Add(new uint[] { 300, 200 }); Listing.Add(new uint[] { 999, 5 });
  }
  static uint Pid(System.IntPtr handle) { return (uint)handle.ToInt64(); }
  public bool Open(uint pid, out System.IntPtr handle, out int error) {
    error = OpenError.ContainsKey(pid) ? OpenError[pid] : 0;
    handle = error == 0 ? new System.IntPtr(pid) : System.IntPtr.Zero;
    return error == 0;
  }
  public bool Times(System.IntPtr handle, out long created, out int error) {
    uint pid = Pid(handle);
    error = TimesError.ContainsKey(pid) ? TimesError[pid] : 0;
    created = error == 0 ? Created[pid] : 0;
    return error == 0;
  }
  public int Parent(System.IntPtr handle, out ulong ppid) {
    uint pid = Pid(handle);
    ppid = ParentOf.ContainsKey(pid) ? ParentOf[pid] : 0;
    return QueryStatus.ContainsKey(pid) ? QueryStatus[pid] : 0;
  }
  public bool Terminate(System.IntPtr handle, out int error) { Terminated.Add(Pid(handle)); ended.Add(Pid(handle)); error = 0; return true; }
  public uint Wait(System.IntPtr handle, uint ms) { return ended.Contains(Pid(handle)) ? 0u : 258u; }
  public void Close(System.IntPtr handle) { }
  public System.Collections.Generic.List<uint[]> Processes(out bool made, out int madeError, out bool firstOk, out int firstError, out int stopError) {
    made = Made; madeError = MadeError; firstOk = FirstOk; firstError = FirstError; stopError = StopError;
    return Made && FirstOk ? Listing : new System.Collections.Generic.List<uint[]>();
  }
}

public static class FakeRun {
  public static string Of(FakeHeldWin win, string answer) {
    var output = new System.IO.StringWriter();
    int code = HeldKill.Run(100, win, new System.IO.StringReader(answer + "\\n"), output);
    return code + "|" + output.ToString().Trim().Replace("\\r", "").Replace("\\n", " / ") + "|" + string.Join(",", win.Terminated.ConvertAll(p => p.ToString()).ToArray());
  }
}
`;

/** Each scenario, as PowerShell that sets up one fake, run through Run, one result line each, in one PowerShell run. */
function run(scenarios) {
  // The source travels the way the kill sends it: in the helper's environment, not on its command line.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition $env:${SOURCE_VARIABLE}`,
    ...scenarios.map(([, setup, answer = "go"]) => `$w = New-Object FakeHeldWin; ${setup}; [Console]::Out.WriteLine([FakeRun]::Of($w, '${answer}'))`),
  ].join("\n");
  const env = { ...helperEnv(), [SOURCE_VARIABLE]: `${HELPER_SOURCE}\n${FAKE_SOURCE}` };
  const ran = spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 60_000, env });
  assert.equal(ran.error, undefined, `the helper could not be started: ${ran.error?.code}`);
  assert.equal(ran.status, 0, `the helper did not compile or run: ${ran.stderr}`);
  const lines = ran.stdout.trim().split(/\r?\n/);
  return lines.map((line) => {
    const [code, said, terminated] = line.split("|");
    return { code: Number(code), said, terminated: terminated === "" ? [] : terminated.split(",").map(Number) };
  });
}

test("the helper's command line stays short, and its source fits one environment variable", () => {
  // The bug (2026-10-17): the source rode on the command line as 28 576 of Windows' 32 767 characters; past that the
  // spawn fails with ENAMETOOLONG and no kill runs at all. The command line now carries only a bootstrap.
  const encoded = Buffer.from(helperScript(4242), "utf16le").toString("base64");
  assert.ok(encoded.length < 2_000, `the encoded command is ${encoded.length} characters`);
  assert.ok(!helperScript(4242).includes("DllImport"), "the C# is not on the command line");
  assert.equal(helperEnv({ A: "1" })[SOURCE_VARIABLE], HELPER_SOURCE);
  assert.ok(HELPER_SOURCE.length < 32_767, `the source is ${HELPER_SOURCE.length} characters, past one variable's limit`);
});

test("the helper's source compiles as it is, alone", { skip: onlyWindows }, () => {
  // A source that does not compile ends no process, and a plant that broke compilation would read as red below for a
  // reason that is not its own: this test is red for exactly that, so the two can be told apart.
  const ran = spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(`$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition $env:${SOURCE_VARIABLE}\n[Console]::Out.WriteLine('compiled')`, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 60_000, env: helperEnv() });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), "compiled");
});

test("Run ends the whole live tree, and only what it could identify", { skip: onlyWindows }, () => {
  const cases = [
    ["control: a live tree is ended whole", "", { code: 0, said: /^held 1000 \/ done 3$/, terminated: [100, 200, 300] }],
    ["the root's creation time could not be read: nothing is ended", "$w.TimesError[100] = 6", { code: 3, said: /^gone could not read 100's creation time \(error 6\)$/, terminated: [] }],
    ["answered no: nothing is ended", "", { code: 4, said: /released$/, terminated: [] }, "no"],
    ["a child refused with access denied is still running: said, not ended, not skipped", "$w.OpenError[200] = 5", { code: 5, said: /failed could not open child 200 of 100 \(error 5\)$/, terminated: [100] }],
    ["a child gone since the listing (87) is nothing left to end", "$w.OpenError[200] = 87", { code: 0, said: /done 1$/, terminated: [100] }],
    ["a child whose identity could not be queried is not ended", "$w.QueryStatus[200] = -1073741823", { code: 5, said: /failed could not read child 200's identity \(status -1073741823, times read\)$/, terminated: [100] }],
    ["a child whose creation time could not be read is not ended", "$w.TimesError[200] = 6", { code: 5, said: /failed could not read child 200's identity \(status 0, times error 6\)$/, terminated: [100] }],
    ["a child read as another parent's is not ended, and that is no problem", "$w.ParentOf[200] = 999", { code: 0, said: /done 1$/, terminated: [100] }],
    ["a child created before its parent is a stale parent id: not ended", "$w.Created[200] = 500", { code: 0, said: /done 1$/, terminated: [100] }],
    ["a child created with its parent is its own", "$w.Created[200] = 1000", { code: 0, said: /done 3$/, terminated: [100, 200, 300] }],
    ["a listing that could not be made is said", "$w.Made = $false; $w.MadeError = 5", { code: 5, said: /failed the children of 100 could not all be listed: the process list could not be read \(error 5\)$/, terminated: [100] }],
    ["a listing whose first entry could not be read is said", "$w.FirstOk = $false; $w.FirstError = 24", { code: 5, said: /the process list could not be started \(error 24\)$/, terminated: [100] }],
    ["a listing that stopped before its end is said, and what it did list is still ended", "$w.StopError = 31", { code: 5, said: /the process list stopped before its end \(error 31\)/, terminated: [100, 200, 300] }],
  ];
  const got = run(cases.map(([name, setup, , answer]) => [name, setup, answer]));
  for (const [index, [name, , want]] of cases.entries()) {
    const one = got[index];
    assert.ok(one !== undefined, `${name}: no result`);
    assert.equal(one.code, want.code, `${name}: exit ${one.code}, said "${one.said}"`);
    assert.match(one.said, want.said, `${name}: said "${one.said}"`);
    assert.deepEqual(one.terminated, want.terminated, `${name}: ended ${JSON.stringify(one.terminated)}, said "${one.said}"`);
  }
});
