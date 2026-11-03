# This script and its manifest are embedded in the signed installer. No remote
# manifest or script is executed. Compatible with Windows PowerShell 5.1.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$LocalSource,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [switch]$Offline,
  [switch]$NoProgressWindow
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = $null
$form = $null
$statusLabel = $null
$progressBar = $null
$script:cancelled = $false
$script:networkDownloadBytes = [long]0
$script:localCopyBytes = [long]0
$script:installRootVerified = $false

function Assert-NoLink([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Component path is a link.' }
    }
    $parent = [IO.Directory]::GetParent($current)
    $current = if ($parent) { $parent.FullName } else { $null }
  }
}

function Get-SafePath([string]$Root, [string]$Relative) {
  if (-not $Relative -or $Relative.Contains('\') -or $Relative.StartsWith('/') -or
      $Relative -match '[\x00-\x1f:*?"<>|]' -or
      @($Relative.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or
        $_ -match '[ .]$' -or $_ -match '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)' }).Count -gt 0) {
    throw 'Unsafe component path.'
  }
  $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $result = [IO.Path]::GetFullPath((Join-Path $Root $Relative.Replace('/', '\')))
  if (-not $result.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Component path escaped its root.' }
  Assert-NoLink $result
  return $result
}

function Assert-Pin($Row, [switch]$AllowEmpty) {
  if (-not ($Row.path -is [string]) -or -not ($Row.sha256 -is [string]) -or
      $Row.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $Row.bytes -isnot [ValueType] -or
      [long]$Row.bytes -lt 0 -or (-not $AllowEmpty -and [long]$Row.bytes -eq 0) -or
      [long]$Row.bytes -gt 8GB -or [double]$Row.bytes -ne [long]$Row.bytes) {
    throw 'Invalid embedded component pin.'
  }
}

function Test-PinnedFile([string]$Path, $Pin) {
  Assert-NoLink $Path
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Length -ne [long]$Pin.bytes) { return $false }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $Pin.sha256
}

function Set-Status([string]$Text, [int]$Percent = -1) {
  Write-Output $Text
  if ($statusLabel) {
    $statusLabel.Text = $Text
    if ($Percent -ge 0) { $progressBar.Value = [Math]::Min(100, [Math]::Max(0, $Percent)) }
    [Windows.Forms.Application]::DoEvents()
    if ($script:cancelled) { throw 'Component installation cancelled.' }
  }
}

function Show-ComponentProgress {
  # Verification and any first-install/repair downloads remain visible even
  # when the existing app's update helper invokes the installer in /S mode.
  if ($NoProgressWindow) { return }
  Add-Type -AssemblyName System.Windows.Forms
  $script:form = New-Object Windows.Forms.Form
  $form.Text = 'Klipper Farm'
  $form.Width = 540; $form.Height = 155
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false; $form.MinimizeBox = $false
  $script:statusLabel = New-Object Windows.Forms.Label
  $statusLabel.SetBounds(20, 15, 490, 45)
  $script:progressBar = New-Object Windows.Forms.ProgressBar
  $progressBar.SetBounds(20, 65, 485, 22)
  $form.Controls.Add($statusLabel); $form.Controls.Add($progressBar)
  $form.Add_FormClosing({ $script:cancelled = $true })
  $form.Show()
  Set-Status 'Проверяю офлайн-компоненты. Уже установленные файлы используются повторно.' 0
}

function Write-ComponentState {
  $statePath = Get-SafePath $InstallRoot '.klipper-component-state.json'
  # Per-file size + mtime records let the next verification run trust files
  # that cannot have changed since this verified state was written, instead of
  # re-hashing hundreds of megabytes on every launch.
  $fileTable = New-Object 'Collections.Generic.List[object]'
  foreach ($row in $expected.Values) {
    $fullPath = Get-SafePath $InstallRoot $row.path
    try {
      $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
      if (-not $item.PSIsContainer) {
        $fileTable.Add([pscustomobject]@{ path=$row.path; size=[long]$item.Length; mtime=$item.LastWriteTimeUtc.Ticks })
      }
    } catch { }
  }
  $state = @{ schema=1; runtimeSha256=$runtime.sha256; modelSha256=$model.sha256;
    runtimeFiles=$expected.Count; runtimeReusedFiles=($expected.Count - $missing.Count);
    runtimeReusedBytes=($unpackedBytes - (($missing | Measure-Object -Property bytes -Sum).Sum));
    modelReused=(-not $needModel); networkDownloadBytes=$script:networkDownloadBytes;
    localCopyBytes=$script:localCopyBytes; files=$fileTable.ToArray();
    installedAtUtc=[DateTime]::UtcNow.ToString('o') }
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  $previousError = Get-SafePath $InstallRoot '.klipper-component-install-error.txt'
  if (Test-Path -LiteralPath $previousError -PathType Leaf) { Remove-Item -LiteralPath $previousError -Force }
}

function Remove-StaleRuntimeFiles([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory)) { return }
  Assert-NoLink $Directory
  foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
    Assert-NoLink $item.FullName
    if ($item.PSIsContainer) {
      Remove-StaleRuntimeFiles $item.FullName
      if (@(Get-ChildItem -LiteralPath $item.FullName -Force).Count -eq 0) { [IO.Directory]::Delete($item.FullName) }
    } else {
      $relative = $item.FullName.Substring($InstallRoot.Length + 1).Replace('\', '/')
      if (-not $expected.ContainsKey($relative) -and $relative -cnotin @(
          'speech/silero/tts.py', 'speech/whisper/recognition.args', 'speech/NEURAL-SPEECH-NOTICES.txt', 'speech/manifest.json')) {
        Remove-Item -LiteralPath $item.FullName -Force
      }
    }
  }
}

function Assert-FreeSpace([long]$Required) {
  $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($InstallRoot))
  if ($drive.AvailableFreeSpace -lt $Required) {
    throw ('Not enough space on ' + $drive.Name + '. Required free space: ' + [Math]::Ceiling($Required / 1GB) + ' GB.')
  }
}

function Receive-PinnedFile($Pin, [string]$Target, [string]$Adjacent) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Target)) | Out-Null
  if (Test-PinnedFile $Adjacent $Pin) {
    Set-Status ('Использую проверенный локальный компонент: ' + [IO.Path]::GetFileName($Adjacent))
    [IO.File]::Copy($Adjacent, $Target, $false)
    if (-not (Test-PinnedFile $Target $Pin)) { throw 'Local component copy failed integrity verification.' }
    $script:localCopyBytes += [long]$Pin.bytes
    return
  }
  if ($Offline) { throw 'Required verified local component is missing (offline install).' }
  $uri = [Uri]$Pin.url
  $response = $null; $inputStream = $null; $outputStream = $null
  try {
    # Follow redirects explicitly so every hop remains HTTPS. The signed byte
    # length and SHA256 remain authoritative, including redirected CDN data.
    for ($redirect = 0; $redirect -le 8; $redirect++) {
      if ($uri.Scheme -ne 'https' -or $uri.UserInfo) { throw 'Component download requires HTTPS.' }
      $request = [Net.HttpWebRequest]::Create($uri)
      $request.AllowAutoRedirect = $false
      $request.Timeout = 60000; $request.ReadWriteTimeout = 60000
      $request.UserAgent = 'Klipper-Farm-Component-Installer/1'
      $response = $request.GetResponse()
      $code = [int]$response.StatusCode
      if ($code -in @(301, 302, 303, 307, 308)) {
        $location = $response.Headers['Location']
        if (-not $location) { throw 'Component redirect has no target.' }
        $uri = New-Object Uri ($uri, $location)
        $response.Dispose(); $response = $null
        continue
      }
      if ($code -ne 200) { throw 'Component download returned an unexpected status.' }
      break
    }
    if (-not $response) { throw 'Too many component redirects.' }
    if ($response.ContentLength -ge 0 -and $response.ContentLength -ne [long]$Pin.bytes) {
      throw 'Component download length differs from its embedded pin.'
    }
    $inputStream = $response.GetResponseStream()
    $outputStream = [IO.File]::Open($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = New-Object byte[] (1024 * 1024)
    [long]$written = 0
    $lastPercent = -1
    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $written += $count
      $script:networkDownloadBytes += $count
      if ($written -gt [long]$Pin.bytes) { throw 'Component download exceeded its embedded size.' }
      $outputStream.Write($buffer, 0, $count)
      $percent = [int]([double]$written * 100 / [long]$Pin.bytes)
      if ($percent -ne $lastPercent) {
        Set-Status ('Скачиваю офлайн-компонент: ' + $percent + '%') $percent
        $lastPercent = $percent
      } elseif ($form) {
        [Windows.Forms.Application]::DoEvents()
        if ($script:cancelled) { throw 'Component installation cancelled.' }
      }
    }
    $outputStream.Dispose(); $outputStream = $null
    Set-Status 'Проверяю целостность скачанного компонента (SHA256).' 100
    if (-not (Test-PinnedFile $Target $Pin)) { throw 'Downloaded component failed SHA256/size verification.' }
  } finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
    if ($response) { $response.Dispose() }
  }
}

function Receive-RuntimeEntries($Runtime, [string]$Stage, $Expected, $Missing) {
  # Download only the entries of the pinned immutable runtime archive that
  # actually changed, using HTTP Range requests against the published zip.
  # The embedded per-file size/SHA256 pins stay authoritative for every byte.
  # Throws when the server or archive layout cannot support partial reads, so
  # the caller can fall back to the full-archive download path.
  $uri = New-Object Uri $Runtime.url
  $response = $null
  try {
    for ($redirect = 0; $redirect -le 8; $redirect++) {
      if ($uri.Scheme -cne 'https' -or $uri.UserInfo) { throw 'Component download requires HTTPS.' }
      $head = [Net.HttpWebRequest]::Create($uri)
      $head.AllowAutoRedirect = $false
      $head.Method = 'HEAD'
      $head.Timeout = 60000; $head.ReadWriteTimeout = 60000
      $head.UserAgent = 'Klipper-Farm-Component-Installer/1'
      $response = $head.GetResponse()
      $code = [int]$response.StatusCode
      if ($code -in @(301, 302, 303, 307, 308)) {
        $location = $response.Headers['Location']
        if (-not $location) { throw 'Component redirect has no target.' }
        $uri = New-Object Uri ($uri, $location)
        $response.Dispose(); $response = $null
        continue
      }
      if ($code -ne 200) { throw 'Component metadata returned an unexpected status.' }
      break
    }
    if (-not $response) { throw 'Too many component redirects.' }
    $total = $response.ContentLength
    $response.Dispose(); $response = $null
    if ($total -ne [long]$Runtime.bytes) { throw 'Runtime archive length differs from its embedded pin.' }

    $script:readRange = {
      param([long]$Start, [long]$End)
      if ($End -lt $Start) { throw 'Invalid component range.' }
      $req = [Net.HttpWebRequest]::Create($uri)
      $req.AllowAutoRedirect = $false
      $req.Method = 'GET'
      $req.AddRange('bytes', $Start, $End)
      $req.Timeout = 120000; $req.ReadWriteTimeout = 120000
      $req.UserAgent = 'Klipper-Farm-Component-Installer/1'
      $resp = $req.GetResponse()
      try {
        if ([int]$resp.StatusCode -ne 206) { throw 'Component server did not honor the range request.' }
        $stream = $resp.GetResponseStream()
        $buffer = New-Object byte[] ([long]($End - $Start + 1))
        $offset = 0
        while ($offset -lt $buffer.Length) {
          $count = $stream.Read($buffer, $offset, $buffer.Length - $offset)
          if ($count -le 0) { throw 'Component range response ended early.' }
          $offset += $count
          $script:networkDownloadBytes += $count
        }
        return ,$buffer
      } finally { $resp.Dispose() }
    }

    # Locate the End Of Central Directory record in the archive tail.
    $tail = & $script:readRange ([long]($total - 65536)) ([long]($total - 1))
    $eocd = -1
    for ($i = $tail.Length - 22; $i -ge 0; $i--) {
      if ($tail[$i] -eq 0x50 -and $tail[$i+1] -eq 0x4B -and $tail[$i+2] -eq 0x05 -and $tail[$i+3] -eq 0x06) { $eocd = $i; break }
    }
    if ($eocd -lt 0) { throw 'Runtime archive directory not found.' }
    $cdSize = [BitConverter]::ToUInt32($tail, $eocd + 12)
    $cdOffset = [BitConverter]::ToUInt32($tail, $eocd + 16)
    $commentLength = [BitConverter]::ToUInt16($tail, $eocd + 20)
    if ($eocd + 22 + $commentLength -ne $tail.Length) { throw 'Runtime archive directory is truncated.' }
    if ($cdOffset -eq 0xFFFFFFFF -or $cdSize -eq 0xFFFFFFFF -or [long]$cdOffset + $cdSize -gt $total) {
      throw 'Runtime archive uses an unsupported zip64 layout.'
    }

    # Map every allowlisted entry to its compressed record location.
    $cd = & $script:readRange ([long]$cdOffset) ([long]($cdOffset + $cdSize - 1))
    $entries = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
    $pos = 0
    while ($pos + 46 -le $cd.Length) {
      if ($cd[$pos] -ne 0x50 -or $cd[$pos+1] -ne 0x4B -or $cd[$pos+2] -ne 0x01 -or $cd[$pos+3] -ne 0x02) {
        throw 'Runtime archive directory is corrupt.'
      }
      $method = [BitConverter]::ToUInt16($cd, $pos + 10)
      $compressed = [BitConverter]::ToUInt32($cd, $pos + 20)
      $size = [BitConverter]::ToUInt32($cd, $pos + 24)
      $nameLength = [BitConverter]::ToUInt16($cd, $pos + 28)
      $extraLength = [BitConverter]::ToUInt16($cd, $pos + 30)
      $entryComment = [BitConverter]::ToUInt16($cd, $pos + 32)
      $localOffset = [BitConverter]::ToUInt32($cd, $pos + 42)
      if ($localOffset -eq 0xFFFFFFFF -or $compressed -eq 0xFFFFFFFF -or $size -eq 0xFFFFFFFF) {
        throw 'Runtime archive entry uses an unsupported zip64 layout.'
      }
      $name = [Text.Encoding]::UTF8.GetString($cd, $pos + 46, $nameLength)
      if (-not $Expected.ContainsKey($name)) { throw 'Runtime archive lists an unexpected entry.' }
      $entries[$name] = @{ Method = $method; Compressed = [long]$compressed; Size = [long]$size; Offset = [long]$localOffset }
      $pos += 46 + $nameLength + $extraLength + $entryComment
    }
    if ($entries.Count -ne $Expected.Count) { throw 'Runtime archive inventory differs from its embedded allowlist.' }

    # Fetch, decompress and verify only the entries that actually changed.
    foreach ($row in @($Missing.ToArray())) {
      Set-Status ('Скачиваю изменённый компонент: ' + $row.path)
      $entry = $entries[$row.path]
      if ($null -eq $entry) { throw 'Changed component is missing from the runtime archive.' }
      if ($entry.Size -ne [long]$row.bytes) { throw 'Runtime archive entry size differs from its embedded pin.' }
      $header = & $script:readRange $entry.Offset ([long]($entry.Offset + 29))
      if ($header[0] -ne 0x50 -or $header[1] -ne 0x4B -or $header[2] -ne 0x03 -or $header[3] -ne 0x04) {
        throw 'Runtime archive entry header is corrupt.'
      }
      $headerMethod = [BitConverter]::ToUInt16($header, 8)
      $headerNameLength = [BitConverter]::ToUInt16($header, 26)
      $headerExtraLength = [BitConverter]::ToUInt16($header, 28)
      if ($headerMethod -ne $entry.Method) { throw 'Runtime archive entry method is inconsistent.' }
      $dataOffset = $entry.Offset + 30 + $headerNameLength + $headerExtraLength
      if ($entry.Compressed -gt 0) {
        $raw = & $script:readRange $dataOffset ([long]($dataOffset + $entry.Compressed - 1))
      } else {
        $raw = New-Object byte[] 0
      }
      if ($entry.Method -eq 8) {
        $inputStream = New-Object IO.MemoryStream(,$raw)
        try {
          $deflate = New-Object IO.Compression.DeflateStream($inputStream, [IO.Compression.CompressionMode]::Decompress)
          try {
            $inflated = New-Object IO.MemoryStream
            try { $deflate.CopyTo($inflated); $payload = $inflated.ToArray() } finally { $inflated.Dispose() }
          } finally { $deflate.Dispose() }
        } finally { $inputStream.Dispose() }
      } elseif ($entry.Method -eq 0) {
        $payload = $raw
      } else { throw 'Runtime archive entry uses an unsupported compression method.' }
      if ($payload.Length -ne [long]$row.bytes) { throw 'Downloaded component exceeded its embedded size.' }
      $target = Get-SafePath $Stage $row.path
      [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
      [IO.File]::WriteAllBytes($target, $payload)
      if (-not (Test-PinnedFile $target $row)) { throw 'Downloaded component failed SHA256/size verification.' }
      Set-Status ('Проверен изменённый компонент: ' + $row.path)
    }
  } finally {
    if ($response) { $response.Dispose() }
  }
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\')) { throw 'Invalid component installation root.' }
  Assert-NoLink $InstallRoot
  $script:installRootVerified = $true
  Assert-NoLink $ManifestPath
  Assert-NoLink $LocalSource
  Assert-NoLink $ResultPath
  $manifestInfo = Get-Item -LiteralPath $ManifestPath
  if ($manifestInfo.Length -gt 32MB) { throw 'Embedded component manifest exceeds its bound.' }
  $manifest = [IO.File]::ReadAllText($ManifestPath, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
  if ($manifest.schema -ne 1) { throw 'Unsupported embedded component manifest.' }
  $runtime = $manifest.runtime; $model = $manifest.model
  Assert-Pin $model
  if ($model.path -cne 'understanding/model.gguf' -or $model.localName -cne 'model.gguf' -or
      $model.url -cnotmatch '^https://huggingface\.co/[^/]+/[^/]+/resolve/[0-9a-f]{40}/[^?]+$') {
    throw 'Invalid embedded model identity.'
  }
  if ($runtime.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $runtime.name -cne ('klipper-farm-runtime-' + $runtime.sha256 + '.zip') -or
      $runtime.url -cne ('https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/download/klipper-farm-runtime-v1/' + $runtime.name) -or
      [long]$runtime.bytes -lt 1 -or [long]$runtime.bytes -ge 2GB -or
      @($runtime.files).Count -lt 1 -or @($runtime.files).Count -gt 100000) { throw 'Invalid embedded engine archive identity.' }
  $expected = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
  $missing = New-Object 'Collections.Generic.List[object]'
  [long]$unpackedBytes = 0
  # A state file written by a previous fully verified installation records
  # size + mtime for every runtime file. While the runtime pin is unchanged,
  # files whose size and mtime still match that trusted record cannot have
  # been replaced since they were verified, so the per-file SHA256 pass (which
  # took minutes on large farms) is limited to files that actually changed.
  $trustedFiles = $null
  $componentStatePath = Get-SafePath $InstallRoot '.klipper-component-state.json'
  if (Test-Path -LiteralPath $componentStatePath -PathType Leaf) {
    try {
      $savedState = [IO.File]::ReadAllText($componentStatePath, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
      if ($savedState.schema -eq 1 -and $savedState.runtimeSha256 -ceq $runtime.sha256 -and $savedState.files) {
        $trustedFiles = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($record in @($savedState.files)) {
          if ($record -and $record.path -and ($record.PSObject.Properties['mtime'] -ne $null)) {
            $trustedFiles[$record.path] = $record
          }
        }
      }
    } catch { $trustedFiles = $null }
  }
  Show-ComponentProgress
  $checkedFiles = 0
  foreach ($row in $runtime.files) {
    # Python packages contain legitimate empty __init__.py / py.typed files.
    # Their zero-byte SHA256 is still checked during reuse and extraction.
    Assert-Pin $row -AllowEmpty
    if ($row.path -cnotmatch '^(speech/|understanding/runtime/)' -or $expected.ContainsKey($row.path)) {
      throw 'Invalid or duplicate embedded runtime path.'
    }
    $path = Get-SafePath $InstallRoot $row.path
    $expected.Add($row.path, $row)
    $unpackedBytes += [long]$row.bytes
    if ($unpackedBytes -gt 16GB) { throw 'Embedded runtime exceeds its unpacked bound.' }
    $trustedRecord = $null
    if ($trustedFiles -and $trustedFiles.TryGetValue($row.path, [ref]$trustedRecord)) {
      $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
      if ($item -and -not $item.PSIsContainer -and $item.Length -eq [long]$row.bytes -and
          $item.Length -eq [long]$trustedRecord.size -and
          $item.LastWriteTimeUtc.Ticks -eq [long]$trustedRecord.mtime) {
        $checkedFiles++
        if ($checkedFiles % 500 -eq 0) { Set-Status ('Проверяю установленные файлы: ' + $checkedFiles + ' / ' + $runtime.files.Count) }
        continue
      }
    }
    if (-not (Test-PinnedFile $path $row)) { $missing.Add($row) }
    $checkedFiles++
    if ($checkedFiles % 100 -eq 0) { Set-Status ('Проверяю установленные файлы: ' + $checkedFiles + ' / ' + $runtime.files.Count) }
  }
  Set-Status 'Проверяю установленную модель понимания речи (SHA256).'
  $modelPath = Get-SafePath $InstallRoot $model.path
  $needModel = -not (Test-PinnedFile $modelPath $model)
  if ($missing.Count -eq 0 -and -not $needModel) {
    Remove-StaleRuntimeFiles (Join-Path $InstallRoot 'speech')
    Remove-StaleRuntimeFiles (Join-Path $InstallRoot 'understanding/runtime')
    Write-ComponentState
    [IO.File]::WriteAllText($ResultPath, 'Verified existing offline components; no component downloads required.', [Text.Encoding]::Unicode)
    exit 0
  }
  [IO.Directory]::CreateDirectory($InstallRoot) | Out-Null
  [long]$required = 64MB
  [long]$newRuntimeBytes = 0
  if ($missing.Count -gt 0) { $newRuntimeBytes = ($missing | Measure-Object -Property bytes -Sum).Sum }
  [long]$archiveBytes = if ($missing.Count -gt 0) { $runtime.bytes } else { 0 }
  [long]$modelBytes = if ($needModel) { $model.bytes } else { 0 }
  # The verified archive is removed before acquiring the model. Staging lives
  # on the installation volume, never in the potentially full system TEMP.
  $required += $newRuntimeBytes + [Math]::Max($archiveBytes, $modelBytes)
  Assert-FreeSpace $required
  $stage = Join-Path $InstallRoot ('.update-components-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($stage) | Out-Null
  if ($missing.Count -gt 0) {
    $entriesFetched = $false
    [long]$missingBytes = ($missing | Measure-Object -Property bytes -Sum).Sum
    # Range-based partial fetch pays off only when a small part of the runtime
    # changed. Fresh or heavily outdated installs keep the single-archive path.
    if (-not $Offline -and $missingBytes -lt [long]($runtime.bytes / 4)) {
      try {
        # Fast path: fetch only the changed archive entries by byte range, so a
        # release that recompiles a few engines no longer forces a full ~600 MB
        # runtime download on every user.
        Receive-RuntimeEntries $runtime $stage $expected $missing
        $entriesFetched = $true
        Set-Status ('Скачаны только изменённые компоненты: ' + $missing.Count + ' из ' + $expected.Count + ' файлов.')
      } catch {
        Set-Status 'Частичное скачивание недоступно, загружаю полный архив компонентов.'
        foreach ($row in @($missing.ToArray())) {
          $staged = Get-SafePath $stage $row.path
          if (Test-Path -LiteralPath $staged -PathType Leaf) { Remove-Item -LiteralPath $staged -Force }
        }
      }
    }
    if (-not $entriesFetched) {
    $archivePath = Join-Path $stage $runtime.name
    Receive-PinnedFile $runtime $archivePath (Get-SafePath $LocalSource $runtime.name)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
      if ($archive.Entries.Count -ne $expected.Count) { throw 'Runtime ZIP inventory differs from its embedded allowlist.' }
      $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      $needed = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      foreach ($row in $missing) { $needed.Add($row.path) | Out-Null }
      foreach ($entry in $archive.Entries) {
        if (-not $expected.ContainsKey($entry.FullName) -or -not $seen.Add($entry.FullName) -or
            $entry.FullName -cne $expected[$entry.FullName].path -or
            $entry.Length -ne [long]$expected[$entry.FullName].bytes -or
            (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe or unexpected runtime ZIP entry.' }
        $target = Get-SafePath $stage $entry.FullName
        if ($needed.Contains($entry.FullName)) {
          [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
          $source = $entry.Open()
          $destination = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
          try {
            $buffer = New-Object byte[] (1024 * 1024); [long]$written = 0
            while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
              $written += $count
              if ($written -gt $entry.Length) { throw 'Runtime ZIP entry exceeded its size pin.' }
              $destination.Write($buffer, 0, $count)
            }
          } finally { $destination.Dispose(); $source.Dispose() }
          if (-not (Test-PinnedFile $target $expected[$entry.FullName])) { throw 'Extracted runtime failed SHA256/size verification.' }
          Set-Status ('Проверен файл офлайн-компонента: ' + $seen.Count + ' / ' + $expected.Count)
        }
      }
    } finally { $archive.Dispose() }
    Remove-Item -LiteralPath $archivePath -Force
    }
  }
  if ($needModel) {
    Receive-PinnedFile $model (Get-SafePath $stage $model.path) (Get-SafePath $LocalSource $model.localName)
  }
  # Promote only after every required new component has been verified. Matching
  # installed files are never rewritten. Existing app settings are untouched.
  Set-Status 'Устанавливаю проверенные офлайн-компоненты.' 100
  foreach ($row in @($missing.ToArray()) + @($model | Where-Object { $needModel })) {
    $source = Get-SafePath $stage $row.path
    $target = Get-SafePath $InstallRoot $row.path
    [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
    if (-not (Test-PinnedFile $source $row)) { throw 'Staged component changed before installation.' }
    if (Test-Path -LiteralPath $target) { [IO.File]::Replace($source, $target, [NullString]::Value) }
    else { [IO.File]::Move($source, $target) }
  }
  # Engine upgrades can remove modules as well as add them. Avoid importing an
  # obsolete DLL/Python module left by an older component version. These are
  # app-owned runtime roots, never the user's documents, library or preferences.
  Remove-StaleRuntimeFiles (Join-Path $InstallRoot 'speech')
  Remove-StaleRuntimeFiles (Join-Path $InstallRoot 'understanding/runtime')
  Write-ComponentState
  [IO.File]::WriteAllText($ResultPath, 'Offline components verified and installed.', [Text.Encoding]::Unicode)
} catch {
  $message = 'Klipper Farm: ' + $_.Exception.Message
  $message = $message.Substring(0, [Math]::Min(900, $message.Length))
  try { [IO.File]::WriteAllText($ResultPath, $message, [Text.Encoding]::Unicode) } catch { }
  # NSIS deletes its plugin directory on exit. Preserve only this bounded error
  # under the validated install root so a failed installation is diagnosable.
  if ($script:installRootVerified) {
    try {
      Assert-NoLink $InstallRoot
      [IO.Directory]::CreateDirectory($InstallRoot) | Out-Null
      $errorPath = Get-SafePath $InstallRoot '.klipper-component-install-error.txt'
      [IO.File]::WriteAllText($errorPath, $message, [Text.Encoding]::Unicode)
    } catch { }
  }
  Write-Error $message -ErrorAction Continue
  exit 2
} finally {
  if ($form) { $form.Dispose() }
  if ($stage) {
    try { Assert-NoLink $stage; [IO.Directory]::Delete($stage, $true) } catch { }
  }
}
