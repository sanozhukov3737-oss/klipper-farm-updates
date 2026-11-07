$ErrorActionPreference = 'Stop'

function Get-UpdateCacheScope($value) {
  if (-not $value.cacheRoot) { return $null }
  $root = [IO.Path]::GetFullPath([string]$value.cacheRoot).TrimEnd('\')
  $installerPath = [IO.Path]::GetFullPath([string]$value.installer)
  $attempt = Split-Path -Parent $installerPath
  if ((Split-Path -Leaf $root) -ne 'verified-updates' -or
      (Split-Path -Parent $attempt) -ne $root -or
      (Split-Path -Leaf $attempt) -notmatch '^[a-fA-F0-9]{32}$' -or
      (Split-Path -Leaf $installerPath) -ne 'installer.exe' -or
      [IO.Path]::GetFullPath([string]$value.ready) -ne (Join-Path $attempt 'helper-ready')) { throw 'Invalid update cache scope' }
  foreach ($path in @($root,$attempt)) {
    $item = Get-Item -LiteralPath $path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Update cache is a link' }
  }
  return @{root=$root;directory=$attempt}
}

function Clear-UpdateCacheAttempt($scope) {
  if (-not $scope) { return }
  try {
    foreach ($directory in @($scope.root,$scope.directory)) {
      $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    }
    foreach ($name in @('installer.exe','manifest.json','helper-ready','install-result.txt')) {
      $path = Join-Path $scope.directory $name
      $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      if ($item -and -not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      }
    }
    # Delete only an empty directory. Unknown files and nested directories stay.
    [IO.Directory]::Delete($scope.directory,$false)
  } catch { } # Startup cleanup retries locked files after the helper exits.
}

function Write-UpdateFailure($scope,$fallback,$message) {
  if ($scope) {
    $rootItem = Get-Item -LiteralPath $scope.root -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
  }
  $path = if ($scope) { Join-Path $scope.root 'last-error.txt' } else { $fallback }
  $existing = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  if ($existing -and ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint))) { return }
  $text = [string]$message
  if ($text.Length -gt 2048) { $text = $text.Substring(0,2048) }
  [IO.File]::WriteAllText($path,$text)
}

[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$log = Join-Path (Split-Path -Parent $payload.installer) 'install-result.txt'
$scope = $null
$handoffComplete = $false
function Assert-Installer {
  $item = Get-Item -LiteralPath $payload.installer
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installer is a link' }
  if ($item.Length -ne $payload.sizeBytes) { throw 'Installer size changed' }
  if ((Get-FileHash -LiteralPath $payload.installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $payload.sha256) { throw 'Installer hash changed' }
}
# Установщик пишет причину отказа рядом с установкой; $PLUGINSDIR он удаляет вместе
# с собой. Добавляем её к коду возврата, иначе оператор видит только "exit code 2".
function Read-InstallerFailureReason($directory) {
  if (-not $directory) { return '' }
  $path = Join-Path $directory '.klipper-install-failure.txt'
  try {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return '' }
    $text = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false, $true)).Trim()
    if ($text.Length -gt 1024) { $text = $text.Substring(0,1024) }
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return $text
  } catch { return '' }
}

function Invoke-UpdateInstaller($payload, [string]$directory) {
  # NSIS требует /D последним и без кавычек, даже если в пути есть пробелы.
  $installer = Start-Process -FilePath $payload.installer -ArgumentList ('/S /UPDATE /D=' + $directory) -PassThru
  $deadline = (Get-Date).AddMinutes(45)
  while (-not $installer.HasExited) {
    if ((Get-Date) -gt $deadline) {
      try { Stop-Process -Id $installer.Id -Force -ErrorAction Stop } catch { }
      throw 'Installer did not finish within 45 minutes'
    }
    Start-Sleep -Seconds 5
  }
  return $installer.ExitCode
}
try {
  $scope = Get-UpdateCacheScope $payload
  Assert-Installer
  [IO.File]::WriteAllText($payload.ready,(@{helperPid=$PID} | ConvertTo-Json -Compress))
  $parent = Get-Process -Id $payload.parentPid -ErrorAction SilentlyContinue
  if ($parent) { $parent.WaitForExit(60000) | Out-Null; if (-not $parent.HasExited) { throw 'App did not exit' } }
  $handoffComplete = $true
  Assert-Installer
  # The daemon can outlive the desktop client and hold component files open;
  # the installer kills it too, but a stuck daemon must never stall the update.
  # Windows PowerShell 5.1 promotes native stderr to a terminating error while
  # $ErrorActionPreference is 'Stop' (2>$null does not prevent it), and every
  # alias below is normally absent, so a missing process must stay a no-op.
  $helperErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    foreach ($name in @('klipper-farmd.exe','klipper-farmd-x86_64-pc-windows-msvc.exe','klipper-farmd-x86_64-pc-windows-gnu.exe')) {
      & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /F /T /IM $name 2>$null | Out-Null
    }
  } finally {
    $ErrorActionPreference = $helperErrorPreference
  }
  Start-Sleep -Seconds 1
  $directory = Split-Path -Parent $payload.executable
  # Разовый сбой (антивирус ещё держит exe после сканирования, файл не освободился)
  # раньше доходил до оператора как "exit code 2". Код 2 означает, что установщик
  # сам прервался до копирования, поэтому один повтор безопасен и идемпотентен.
  $maxAttempts = 2
  $exitCode = 0
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $exitCode = Invoke-UpdateInstaller $payload $directory
    if ($exitCode -eq 0) { break }
    if ($attempt -lt $maxAttempts -and $exitCode -eq 2) {
      Start-Sleep -Seconds 15
      Assert-Installer
      continue
    }
    break
  }
  if ($exitCode -ne 0) {
    $reason = Read-InstallerFailureReason $directory
    if ($reason) { throw ('Installer exit code: ' + $exitCode + '. ' + $reason) }
    throw ('Installer exit code: ' + $exitCode)
  }
  if ($scope) { Clear-UpdateCacheAttempt $scope } else { [IO.File]::WriteAllText($log,'Installed successfully') }
  Start-Process -FilePath $payload.executable -WorkingDirectory $directory
} catch {
  $message = $_.Exception.Message
  if ($scope -or -not $payload.cacheRoot) { try { Write-UpdateFailure $scope $log $message } catch { } }
  if ($handoffComplete) { Clear-UpdateCacheAttempt $scope }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(('Klipper Farm: update was not installed. ' + $message), 'Klipper Farm') | Out-Null
  if (Test-Path -LiteralPath $payload.executable) { Start-Process -FilePath $payload.executable }
  exit 1
}
