param([string]$Node, [string]$Fixture, [string]$Binary, [string]$Root, [string]$CheckJob)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class OwnedHerdrJob {
  const uint CREATE_SUSPENDED = 4, KILL_ON_JOB_CLOSE = 0x2000;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public uint cb; public string reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show, reserved2;
    public IntPtr reservedPtr, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime, jobTime; public uint flags; public UIntPtr min, max;
    public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a,b,c,d; public uint faults,total,active,terminated; }
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXTENDED_LIMIT value, uint size);
  [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out ACCOUNTING value, uint size, IntPtr length);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr psa, IntPtr tsa, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  static void Require(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Check(string name) {
    IntPtr job = OpenJobObjectW(4, false, name); Require(job != IntPtr.Zero);
    try { bool member; Require(IsProcessInJob(GetCurrentProcess(), job, out member)); if (!member) throw new Exception("Fixture is not in its owned job"); }
    finally { CloseHandle(job); }
  }
  static string Quote(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }
  public static int Run(string node, string fixture, string binary, string root) {
    string name = "Local\\aify-herdr-" + Guid.NewGuid().ToString();
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name); Require(job != IntPtr.Zero);
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION(); bool assigned = false;
    uint code = 1, active = 999;
    try {
      EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.basic.flags = KILL_ON_JOB_CLOSE;
      // Neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK is allowed.
      Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
      STARTUPINFO si = new STARTUPINFO(); si.cb = (uint)Marshal.SizeOf(si);
      string cmd = Quote(node) + " " + Quote(fixture) + " " + Quote(binary) + " --owned-job " + Quote(name) + " " + Quote(root);
      Require(CreateProcessW(node, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED, IntPtr.Zero, root, ref si, out pi));
      // The root cannot execute or create descendants before assignment succeeds.
      Require(AssignProcessToJobObject(job, pi.process)); assigned = true;
      if (ResumeThread(pi.thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (WaitForSingleObject(pi.process, 180000) != 0) throw new Exception("Owned fixture timeout");
      Require(GetExitCodeProcess(pi.process, out code));
    } finally {
      try {
        if (pi.process != IntPtr.Zero && !assigned) {
          // Creator-returned handle only; failed assignment never resumes the root.
          Require(TerminateProcess(pi.process, 1)); Require(WaitForSingleObject(pi.process, 5000) == 0);
        }
        Require(TerminateJobObject(job, 1));
        for (int i = 0; i < 100; i++) {
          ACCOUNTING counts; Require(QueryInformationJobObject(job, 1, out counts, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
          active = counts.active; if (active == 0) break; System.Threading.Thread.Sleep(50);
        }
        System.IO.File.WriteAllText(System.IO.Path.Combine(root, "job-receipt.json"), "{\"assignedBeforeResume\":" + assigned.ToString().ToLowerInvariant() + ",\"exitCode\":" + code + ",\"activeProcessesAfterTerminate\":" + active + "}");
        if (active != 0) throw new Exception("Owned job cleanup incomplete");
      } finally {
        if (pi.thread != IntPtr.Zero) CloseHandle(pi.thread);
        if (pi.process != IntPtr.Zero) CloseHandle(pi.process);
        CloseHandle(job);
      }
    }
    return (int)code;
  }
}
'@
if ($CheckJob) { [OwnedHerdrJob]::Check($CheckJob); exit 0 }
if (!$Node -or !$Fixture -or !$Binary -or !$Root) { throw 'Node, Fixture, Binary and Root are required' }
exit [OwnedHerdrJob]::Run($Node, $Fixture, $Binary, $Root)
