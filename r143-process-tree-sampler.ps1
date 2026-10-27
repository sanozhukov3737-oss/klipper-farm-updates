param([Parameter(Mandatory=$true)][int]$AppProcessId)
$ErrorActionPreference='Stop'
# Only the launched application and current descendants. Never sum every WebView
# or Klipper process on the machine. Private bytes are commit, not resident RAM.
while ($true) {
  $root=Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
  if (-not $root) { break }
  $relations=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
  $owned=[Collections.Generic.HashSet[int]]::new()
  [void]$owned.Add($AppProcessId)
  do {
    $added=$false
    foreach ($relation in $relations) {
      if ($owned.Contains([int]$relation.ParentProcessId) -and $owned.Add([int]$relation.ProcessId)) { $added=$true }
    }
  } while ($added)
  $rows=@()
  foreach ($ownedId in $owned) {
    $item=Get-Process -Id $ownedId -ErrorAction SilentlyContinue
    if ($item) {
      try {
        $rows+=@{processId=$ownedId;name=$item.ProcessName;startedAt=$item.StartTime.ToUniversalTime().ToString('o');privateCommitBytes=$item.PrivateMemorySize64;workingSetBytes=$item.WorkingSet64;cpuSeconds=$item.TotalProcessorTime.TotalSeconds}
      } catch { if ($ownedId -eq $AppProcessId) { throw } }
    }
  }
  @{observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();rootProcessId=$AppProcessId;processes=$rows;privateCommitBytes=($rows | Measure-Object privateCommitBytes -Sum).Sum;processWorkingSetSumBytes=($rows | Measure-Object workingSetBytes -Sum).Sum} | ConvertTo-Json -Compress -Depth 5
  Start-Sleep -Milliseconds 1000
}
