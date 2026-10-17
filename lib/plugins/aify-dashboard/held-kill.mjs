// Ending a provider client's process tree on Windows through handles held on each process, never by a pid looked up
// later.
//
// ⛔ WHY NOT taskkill (comms-senior-dev, REVISE of 33689cd). `taskkill /T /F /PID <n>` looks its target up by number,
// some time after it is started. In between, the client can exit, node can let go of it, and Windows can give the
// number to any process on this host; taskkill then ends that process and, with /T, its tree.
//
// THE HANDSHAKE. A helper opens the client by pid and HOLDS the handle, says `held`, and waits for one line. The run
// answers `go` only while it has not seen the client exit. Node closes its own handle and emits 'exit' in one
// synchronous step, so `exit` unseen when `held` is read means node's handle was open the whole time the helper was
// opening its own: the pid still named this client then, and the helper's handle keeps it from then on. Any other
// answer, or none, and the helper ends nothing.
//
// What a handle guarantees, as Microsoft documents it:
// - TerminateProcess acts on "a handle to the process to be terminated" (learn.microsoft.com, TerminateProcess).
// - "as long as the process object is still around, so too will its process ID"; the object lives while a handle to it
//   is open (The Old New Thing, 2011-01-07, "When does a process ID become available for reuse?").
//
// THE TREE. The root is ended first and waited for, so it can start nothing more. Each child is then found by its parent
// pid while the parent's handle is still held, so that pid cannot have been reused; the child is opened, and only
// counted as the parent's when, ON ITS OWN HANDLE, its parent id is that pid (NtQueryInformationProcess) and it was
// created no earlier than the parent (GetProcessTimes). It is ended and waited for the same way, and so on down.
//
// ⛔ "ENDED" MEANS THE TREE THAT WAS REACHABLE. A process whose parent had already exited before the kill has no parent
// id this can follow, as with /T: `done` says the reachable tree ended, and nothing about one already orphaned.

import { spawn } from "node:child_process";
import { win32 } from "node:path";

/** PowerShell's absolute path, from SystemRoot, or null. Never the bare name (the rule taskkill had, review of 0.8.1). */
export function powershellPath(env = process.env) {
  const root = String(env.SystemRoot || env.SYSTEMROOT || "");
  return win32.isAbsolute(root) ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
}

export const HELPER_SOURCE = `
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

// Every Win32 call the kill makes, so a test can script each one's result and see what Run did with it.
public interface IHeldWin {
  bool Open(uint pid, out IntPtr handle, out int error);
  bool Times(IntPtr handle, out long created, out int error);
  int Parent(IntPtr handle, out ulong ppid);
  bool Terminate(IntPtr handle, out int error);
  uint Wait(IntPtr handle, uint ms);
  void Close(IntPtr handle);
  // Every process as {pid, ppid}, and how the listing went: made, its error, whether the first entry was read, its
  // error, and the error the listing stopped on.
  List<uint[]> Processes(out bool made, out int madeError, out bool firstOk, out int firstError, out int stopError);
}

// The real calls. SetLastError on every import whose error is read, so GetLastWin32Error is that call's (comms-senior-dev, on 05dc655).
public class RealHeldWin : IHeldWin {
  const uint TERMINATE = 0x0001, QUERY_LIMITED = 0x1000, SYNCHRONIZE = 0x00100000, SNAPPROCESS = 0x2;

  [StructLayout(LayoutKind.Sequential)]
  struct BasicInformation { public IntPtr ExitStatus, Peb, Affinity, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, ref BasicInformation info, int size, out int written);

  public bool Open(uint pid, out IntPtr handle, out int error) {
    handle = OpenProcess(TERMINATE | QUERY_LIMITED | SYNCHRONIZE, false, pid);
    error = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
    return handle != IntPtr.Zero;
  }
  public bool Times(IntPtr handle, out long created, out int error) {
    long exited, kernel, user;
    bool ok = GetProcessTimes(handle, out created, out exited, out kernel, out user);
    error = ok ? 0 : Marshal.GetLastWin32Error();
    return ok;
  }
  public int Parent(IntPtr handle, out ulong ppid) {
    var info = new BasicInformation(); int written;
    int status = NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(typeof(BasicInformation)), out written);
    ppid = (ulong)info.InheritedFromUniqueProcessId.ToInt64();
    return status;
  }
  public bool Terminate(IntPtr handle, out int error) {
    bool ok = TerminateProcess(handle, 1);
    error = ok ? 0 : Marshal.GetLastWin32Error();
    return ok;
  }
  public uint Wait(IntPtr handle, uint ms) { return WaitForSingleObject(handle, ms); }
  public void Close(IntPtr handle) { CloseHandle(handle); }
  public List<uint[]> Processes(out bool made, out int madeError, out bool firstOk, out int firstError, out int stopError) {
    var all = new List<uint[]>();
    IntPtr snapshot = CreateToolhelp32Snapshot(SNAPPROCESS, 0);
    made = snapshot != new IntPtr(-1);
    madeError = made ? 0 : Marshal.GetLastWin32Error();
    firstOk = false; firstError = 0; stopError = HeldKill.NO_MORE_FILES;
    if (!made) return all;
    var entry = new Entry(); entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
    firstOk = Process32FirstW(snapshot, ref entry);
    if (!firstOk) firstError = Marshal.GetLastWin32Error();
    for (bool more = firstOk; more; ) {
      all.Add(new uint[] { entry.th32ProcessID, entry.th32ParentProcessID });
      more = Process32NextW(snapshot, ref entry);
      if (!more) stopError = Marshal.GetLastWin32Error();
    }
    CloseHandle(snapshot);
    return all;
  }
}

public static class HeldKill {
  class Held { public IntPtr Handle; public uint Pid; public long Created; }

  // ⛔ ONLY WHAT WAS OBSERVED DECIDES (comms-senior-dev, on 05dc655). "Ended" and "not ours" each need a read that
  // succeeded; a read that failed is Unknown, which is a stated problem, so the result is failed and the run unconfirmed.
  public const int OURS = 0, FOREIGN = 1, GONE = 2, UNKNOWN = 3;
  public const int NO_SUCH_PROCESS = 87, NO_MORE_FILES = 18;
  const uint WAIT_OBJECT_0 = 0;

  // One candidate child, from what each read returned. Pure: no process is touched.
  public static int Classify(bool openOk, int openError, int queryStatus, ulong ppid, ulong parentPid, bool timesOk, long created, long parentCreated) {
    if (!openOk) return openError == NO_SUCH_PROCESS ? GONE : UNKNOWN;
    if (queryStatus != 0 || !timesOk) return UNKNOWN;
    return ppid == parentPid && created >= parentCreated ? OURS : FOREIGN;
  }

  // What the helper says once it holds the root. Every child is judged against the root's creation time, so a root
  // whose time could not be read is "gone" and ends nothing (comms-senior-dev, on 05dc655). Pure.
  public static string HeldLine(uint pid, bool timesOk, int error, long created) {
    return timesOk ? "held " + created : "gone could not read " + pid + "'s creation time (error " + error + ")";
  }

  // Whether one listing of processes is complete, from how it went: null when it is, else why not. Pure.
  public static string SnapshotProblem(bool created, int createError, bool firstOk, int firstError, int stopError) {
    if (!created) return "the process list could not be read (error " + createError + ")";
    if (!firstOk) return "the process list could not be started (error " + firstError + ")";
    if (stopError != NO_MORE_FILES) return "the process list stopped before its end (error " + stopError + ")";
    return null;
  }

  static List<uint> ChildrenOf(IHeldWin win, uint parent, List<string> problems) {
    bool made, firstOk; int madeError, firstError, stopError;
    var found = new List<uint>();
    foreach (uint[] one in win.Processes(out made, out madeError, out firstOk, out firstError, out stopError))
      if (one[1] == parent && one[0] != parent) found.Add(one[0]);
    string problem = SnapshotProblem(made, madeError, firstOk, firstError, stopError);
    if (problem != null) problems.Add("the children of " + parent + " could not all be listed: " + problem);
    return found;
  }

  // Ends one held process and waits for it, so it can start nothing after its children are listed.
  static string End(IHeldWin win, Held one) {
    if (win.Wait(one.Handle, 0) == WAIT_OBJECT_0) return null;
    int error;
    if (!win.Terminate(one.Handle, out error) && win.Wait(one.Handle, 0) != WAIT_OBJECT_0) return "could not end " + one.Pid + " (error " + error + ")";
    if (win.Wait(one.Handle, 5000) != WAIT_OBJECT_0) return one.Pid + " did not end within 5 s";
    return null;
  }

  public static int Run(uint pid) {
    return Run(pid, new RealHeldWin(), Console.In, Console.Out);
  }

  public static int Run(uint pid, IHeldWin win, TextReader input, TextWriter output) {
    IntPtr root; int error;
    if (!win.Open(pid, out root, out error)) { output.WriteLine("gone could not open " + pid + " (error " + error + ")"); output.Flush(); return 3; }
    long created;
    bool timesOk = win.Times(root, out created, out error);
    string line = HeldLine(pid, timesOk, error, created);
    output.WriteLine(line); output.Flush();
    if (!line.StartsWith("held ")) { win.Close(root); return 3; }
    string answer = input.ReadLine();
    if (answer != "go") { win.Close(root); output.WriteLine("released"); output.Flush(); return 4; }

    var problems = new List<string>();
    var queue = new Queue<Held>();
    var all = new List<Held>();
    var first = new Held { Handle = root, Pid = pid, Created = created };
    queue.Enqueue(first); all.Add(first);
    int ended = 0;
    while (queue.Count > 0) {
      Held parent = queue.Dequeue();
      string problem = End(win, parent);
      if (problem != null) problems.Add(problem); else ended++;
      foreach (uint candidate in ChildrenOf(win, parent.Pid, problems)) {
        IntPtr handle; int openError;
        bool openOk = win.Open(candidate, out handle, out openError);
        int status = -1; ulong ppid = 0;
        long childCreated = 0; int timesError = 0;
        bool childTimesOk = false;
        if (openOk) {
          status = win.Parent(handle, out ppid);
          childTimesOk = win.Times(handle, out childCreated, out timesError);
        }
        int kind = Classify(openOk, openError, status, ppid, parent.Pid, childTimesOk, childCreated, parent.Created);
        // Only "no such process" is gone since the listing. An open refused for any other reason, access denied for an
        // elevated or protected child above all, is a process still running this could not end (comms-tech-lead, on
        // 2e0e55f; an elevated hermes gateway once hid from the reaps the same way).
        if (kind == UNKNOWN) {
          problems.Add(openOk
            ? "could not read child " + candidate + "'s identity (status " + status + ", times " + (childTimesOk ? "read" : "error " + timesError) + ")"
            : "could not open child " + candidate + " of " + parent.Pid + " (error " + openError + ")");
        }
        if (kind != OURS) { if (openOk) win.Close(handle); continue; }
        var child = new Held { Handle = handle, Pid = candidate, Created = childCreated };
        queue.Enqueue(child); all.Add(child);
      }
    }
    foreach (Held one in all) win.Close(one.Handle);
    output.WriteLine(problems.Count == 0 ? "done " + ended : "failed " + string.Join("; ", problems.ToArray()));
    output.Flush();
    return problems.Count == 0 ? 0 : 5;
  }
}
`;

/** The helper's PowerShell, for one pid. The pid is checked to be a positive integer before it is written into it. */
export function helperScript(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`not a process id: ${String(pid)}`);
  return `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition $env:${SOURCE_VARIABLE}\nexit [HeldKill]::Run(${pid})\n`;
}

/**
 * ⛔ THE SOURCE TRAVELS IN THE HELPER'S OWN ENVIRONMENT, NOT ON ITS COMMAND LINE. Encoded on the command line it came to
 * 28 576 of Windows' 32 767 characters, and the spawn fails outright past that (ENAMETOOLONG, measured 2026-10-17): a
 * longer comment in the C# would have stopped every kill. One variable holds up to 32 767 characters, and only this
 * process sets the helper's environment.
 */
export const SOURCE_VARIABLE = "AIFY_HELD_KILL_SOURCE";

/** The helper's environment: this process's, with the C# source added. */
export function helperEnv(parent = process.env) {
  return { ...parent, [SOURCE_VARIABLE]: HELPER_SOURCE };
}

/**
 * End `pid` and the tree reachable from it, through held handles, if `stillOurs()` is true when the helper says it holds
 * the process. Resolves once the reachable tree has ended; rejects with the reason otherwise, including when nothing
 * was ended because the client could no longer be known to be this run's.
 */
export function heldKill(pid, { stillOurs, start = spawn, powershell = powershellPath() } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof stillOurs !== "function") return reject(new Error("no way to know the pid is still the client's, so nothing was killed by it"));
    if (powershell === null) return reject(new Error("no SystemRoot, so there is no PowerShell to hold the client's process with"));
    let script;
    try {
      script = helperScript(pid);
    } catch (error) {
      return reject(error);
    }
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    let helper;
    try {
      helper = start(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, env: helperEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      return reject(error);
    }
    let out = "";
    let err = "";
    let refused = "";
    let answered = false;
    helper.stderr?.on("data", (chunk) => { err = (err + chunk).slice(-2000); });
    helper.stdout?.on("data", (chunk) => {
      out += chunk;
      if (answered || !/^(held|gone)\b.*\r?\n/m.test(out)) return;
      answered = true;
      if (/^gone\b/m.test(out)) {
        refused = `the client's process could not be held (${out.trim().split(/\r?\n/)[0].slice(5)}), so nothing was killed`;
        helper.stdin?.end();
        return;
      }
      // ⛔ THE DECISION, read here and nowhere else: the helper holds the pid as of now.
      if (stillOurs()) helper.stdin?.end("go\n");
      else {
        refused = "the client exited before its process was held, so nothing was killed by pid";
        helper.stdin?.end("no\n");
      }
    });
    helper.on("error", (error) => reject(error));
    helper.on("close", (code) => {
      const said = out.trim().split(/\r?\n/).at(-1) ?? "";
      if (refused) reject(new Error(refused));
      else if (code === 0 && /^done\b/.test(said)) resolve();
      else reject(new Error(/^failed\b/.test(said) ? said.slice(7) : `the kill helper exited ${code}${err.trim() ? `: ${err.trim().split(/\r?\n/).at(-1)}` : ""}`));
    });
  });
}
