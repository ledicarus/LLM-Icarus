# Windows probe for the performance sidebar: once a second it adds up what LLM Icarus's own processes use and prints one
# JSON line:  {"pids":N,"names":["node","llama-server"],"cpuSec":123.4,"ramBytes":N,"gpu":P,"vramBytes":N}
# "LLM Icarus's own processes" = the server (the process given as -RootPid) and everything it started (the model engine,
# the Python helpers, ...), plus the app window ("LLM Icarus.exe") that started the server and its WebView2 processes.
param([int]$RootPid)

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class Probe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PMC2 {
    public uint cb, PageFaultCount;
    public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage,
                   QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage, PrivateWorkingSetSize;
    public ulong SharedCommitUsage;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr h, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr h, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, out PMC2 c, uint size);

  // every running process as "pid,parentPid,name"
  public static List<string> Snapshot() {
    var list = new List<string>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == (IntPtr)(-1)) return list;
    var e = new PROCESSENTRY32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
    if (Process32First(snap, ref e)) {
      do { list.Add(e.th32ProcessID + "," + e.th32ParentProcessID + "," + e.szExeFile); } while (Process32Next(snap, ref e));
    }
    CloseHandle(snap);
    return list;
  }

  // { processor time in 100 ns units (kernel + user), private working set in bytes } or null if the process cannot be read
  public static long[] Stats(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return null;
    try {
      long c, x, k, u; if (!GetProcessTimes(h, out c, out x, out k, out u)) return null;
      var m = new PMC2(); m.cb = (uint)Marshal.SizeOf(typeof(PMC2));
      long ws = 0;
      if (GetProcessMemoryInfo(h, out m, m.cb)) ws = (long)m.PrivateWorkingSetSize.ToUInt64();
      return new long[] { k + u, ws };
    } finally { CloseHandle(h); }
  }
}
"@

$self = $PID
$exclude = @('typeperf.exe', 'nvidia-smi.exe', 'powershell.exe', 'conhost.exe')
$gpuEng = @{}   # instance name -> PerformanceCounter
$gpuMem = @{}
$hasGpuCats = $true
try { $null = [System.Diagnostics.PerformanceCounterCategory]::Exists('GPU Engine') } catch { $hasGpuCats = $false }

while ($true) {
  $t0 = [Environment]::TickCount
  $name = @{}; $parent = @{}; $kids = @{}
  foreach ($line in [Probe]::Snapshot()) {
    $p = $line.Split(',', 3); $id = [int]$p[0]; $pp = [int]$p[1]
    $name[$id] = $p[2]; $parent[$id] = $pp
    if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.Generic.List[int] }
    $kids[$pp].Add($id)
  }
  # the roots: this server, and the app window that started it (if that is what started it)
  $roots = @($RootPid)
  if ($parent.ContainsKey($RootPid) -and $name.ContainsKey($parent[$RootPid]) -and $name[$parent[$RootPid]] -like 'LLM Icarus*') { $roots += $parent[$RootPid] }
  $set = New-Object System.Collections.Generic.HashSet[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  foreach ($r in $roots) { if ($name.ContainsKey($r) -and $set.Add($r)) { $queue.Enqueue($r) } }
  while ($queue.Count) {
    $cur = $queue.Dequeue()
    if ($kids.ContainsKey($cur)) { foreach ($c in $kids[$cur]) { if ($set.Add($c)) { $queue.Enqueue($c) } } }
  }
  $ids = @($set | Where-Object { $_ -ne $self -and ($exclude -notcontains $name[$_].ToLower()) })

  $cpu = 0L; $ram = 0L; $names = @{}
  foreach ($id in $ids) {
    $s = [Probe]::Stats([uint32]$id)
    if ($s) { $cpu += $s[0]; $ram += $s[1]; $names[($name[$id] -replace '\.exe$', '')] = 1 }
  }

  # graphics card: load (the busiest kind of engine counts, as in Task Manager) and dedicated memory, per process
  $gpu = 0.0; $vram = 0L
  if ($hasGpuCats -and $ids.Count) {
    try {
      $idset = New-Object System.Collections.Generic.HashSet[string]
      foreach ($id in $ids) { [void]$idset.Add("pid_$($id)_") }
      $seen = @{}
      $perType = @{}   # "pid|type" -> summed load of that kind of engine
      foreach ($inst in (New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')).GetInstanceNames()) {
        if ($inst -notmatch '^pid_(\d+)_') { continue }
        if (-not $idset.Contains("pid_$($Matches[1])_")) { continue }
        $pidv = $Matches[1]
        $seen[$inst] = 1
        if (-not $gpuEng.ContainsKey($inst)) { $gpuEng[$inst] = New-Object System.Diagnostics.PerformanceCounter('GPU Engine', 'Utilization Percentage', $inst, $true) }
        $type = if ($inst -match 'engtype_(\w+)$') { $Matches[1] } else { 'x' }
        $k = "$pidv|$type"
        $perType[$k] = [double]$perType[$k] + $gpuEng[$inst].NextValue()
      }
      foreach ($k in @($gpuEng.Keys)) { if (-not $seen.ContainsKey($k)) { $gpuEng[$k].Dispose(); $gpuEng.Remove($k) } }
      $perPid = @{}
      foreach ($k in $perType.Keys) { $pidv = $k.Split('|')[0]; if ($perType[$k] -gt [double]$perPid[$pidv]) { $perPid[$pidv] = $perType[$k] } }
      foreach ($v in $perPid.Values) { $gpu += $v }

      $seenM = @{}
      foreach ($inst in (New-Object System.Diagnostics.PerformanceCounterCategory('GPU Process Memory')).GetInstanceNames()) {
        if ($inst -notmatch '^pid_(\d+)_') { continue }
        if (-not $idset.Contains("pid_$($Matches[1])_")) { continue }
        $seenM[$inst] = 1
        if (-not $gpuMem.ContainsKey($inst)) { $gpuMem[$inst] = New-Object System.Diagnostics.PerformanceCounter('GPU Process Memory', 'Dedicated Usage', $inst, $true) }
        $vram += [long]$gpuMem[$inst].NextValue()
      }
      foreach ($k in @($gpuMem.Keys)) { if (-not $seenM.ContainsKey($k)) { $gpuMem[$k].Dispose(); $gpuMem.Remove($k) } }
    } catch { $hasGpuCats = $false }
  }

  $list = ($names.Keys | Sort-Object | ForEach-Object { '"' + $_ + '"' }) -join ','
  [Console]::Out.WriteLine(('{{"pids":{0},"names":[{1}],"cpuSec":{2},"ramBytes":{3},"gpu":{4},"vramBytes":{5}}}' -f $ids.Count, $list, ($cpu / 1e7).ToString('0.###', [Globalization.CultureInfo]::InvariantCulture), $ram, $gpu.ToString('0.#', [Globalization.CultureInfo]::InvariantCulture), $vram))
  [Console]::Out.Flush()
  $left = 1000 - ([Environment]::TickCount - $t0)
  if ($left -gt 20) { Start-Sleep -Milliseconds $left }
}
