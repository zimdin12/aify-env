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

const HELPER_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class HeldKill {
  const uint TERMINATE = 0x0001, QUERY_LIMITED = 0x1000, SYNCHRONIZE = 0x00100000;
  const uint SNAPPROCESS = 0x2;

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
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, ref BasicInformation info, int size, out int written);

  class Held { public IntPtr Handle; public uint Pid; public long Created; }

  static List<uint> ChildrenOf(uint parent) {
    var found = new List<uint>();
    IntPtr snapshot = CreateToolhelp32Snapshot(SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) return found;
    var entry = new Entry(); entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
    for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry))
      if (entry.th32ParentProcessID == parent && entry.th32ProcessID != parent) found.Add(entry.th32ProcessID);
    CloseHandle(snapshot);
    return found;
  }

  // Ends one held process and waits for it, so it can start nothing after its children are listed.
  static string End(Held one) {
    if (WaitForSingleObject(one.Handle, 0) == 0) return null;
    if (!TerminateProcess(one.Handle, 1) && WaitForSingleObject(one.Handle, 0) != 0) return "could not end " + one.Pid + " (error " + Marshal.GetLastWin32Error() + ")";
    if (WaitForSingleObject(one.Handle, 5000) != 0) return one.Pid + " did not end within 5 s";
    return null;
  }

  public static int Run(uint pid) {
    IntPtr root = OpenProcess(TERMINATE | QUERY_LIMITED | SYNCHRONIZE, false, pid);
    if (root == IntPtr.Zero) { Console.Out.WriteLine("gone could not open " + pid + " (error " + Marshal.GetLastWin32Error() + ")"); Console.Out.Flush(); return 3; }
    long created, exited, kernel, user;
    GetProcessTimes(root, out created, out exited, out kernel, out user);
    Console.Out.WriteLine("held " + created); Console.Out.Flush();
    string answer = Console.In.ReadLine();
    if (answer != "go") { CloseHandle(root); Console.Out.WriteLine("released"); Console.Out.Flush(); return 4; }

    var problems = new List<string>();
    var queue = new Queue<Held>();
    var all = new List<Held>();
    var first = new Held { Handle = root, Pid = pid, Created = created };
    queue.Enqueue(first); all.Add(first);
    int ended = 0;
    while (queue.Count > 0) {
      Held parent = queue.Dequeue();
      string problem = End(parent);
      if (problem != null) problems.Add(problem); else ended++;
      foreach (uint candidate in ChildrenOf(parent.Pid)) {
        IntPtr handle = OpenProcess(TERMINATE | QUERY_LIMITED | SYNCHRONIZE, false, candidate);
        if (handle == IntPtr.Zero) {
          // Only "no such process" (87) is gone since the snapshot. Any other refusal, access denied (5) for an elevated
          // or protected child above all, is a process still running that this could not end: said, never skipped
          // (comms-tech-lead, on 2e0e55f; an elevated hermes gateway once hid from the reaps the same way).
          int error = Marshal.GetLastWin32Error();
          if (error != 87) problems.Add("could not open child " + candidate + " of " + parent.Pid + " (error " + error + ")");
          continue;
        }
        var info = new BasicInformation(); int written;
        long childCreated = 0, a, b, c;
        bool ours = NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(typeof(BasicInformation)), out written) == 0
          && (ulong)info.InheritedFromUniqueProcessId.ToInt64() == parent.Pid
          && GetProcessTimes(handle, out childCreated, out a, out b, out c) && childCreated >= parent.Created;
        if (!ours) { CloseHandle(handle); continue; }
        var child = new Held { Handle = handle, Pid = candidate, Created = childCreated };
        queue.Enqueue(child); all.Add(child);
      }
    }
    foreach (Held one in all) CloseHandle(one.Handle);
    Console.Out.WriteLine(problems.Count == 0 ? "done " + ended : "failed " + string.Join("; ", problems.ToArray()));
    Console.Out.Flush();
    return problems.Count == 0 ? 0 : 5;
  }
}
`;

/** The helper's PowerShell, for one pid. The pid is checked to be a positive integer before it is written into it. */
export function helperScript(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`not a process id: ${String(pid)}`);
  return `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${HELPER_SOURCE}\n'@\nexit [HeldKill]::Run(${pid})\n`;
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
      helper = start(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
