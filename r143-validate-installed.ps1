$ErrorActionPreference='Stop'
$workspace=Get-Location
$pins=Get-Content r143-installed-check-pins.json -Raw | ConvertFrom-Json -AsHashtable
foreach ($entry in $pins.GetEnumerator()) { if ((Get-FileHash $entry.Key).Hash.ToLowerInvariant() -ne $entry.Value) { throw "Installed verification helper differs: $($entry.Key)" } }
$provenance=Get-Content candidate/provenance.json -Raw | ConvertFrom-Json
if ($provenance.buildRunId -ne $env:KF_R143_BUILD_RUN -or $provenance.buildHeadSha -ne $env:KF_R143_BUILD_HEAD -or $provenance.sequence -ne 143 -or $provenance.sourcePatchSha256 -ne '7f7b70c0f34937589a2e1c2559c13652a9372c6acc665659e2079f1f6e045d8a' -or $provenance.stablePublished -ne $false) { throw 'Candidate build provenance differs' }
foreach ($entry in $provenance.assets.PSObject.Properties) {
  $file=Get-Item (Join-Path 'candidate' $entry.Name)
  if ($file.Length -ne $entry.Value.sizeBytes -or (Get-FileHash $file.FullName).Hash.ToLowerInvariant() -ne $entry.Value.sha256) { throw "Candidate asset differs: $($entry.Name)" }
}
Copy-Item r143-installed-*.mjs,r143-check-installed-payload.mjs,r143-compare-installed-performance.mjs,r143-process-tree-sampler.ps1 candidate/scripts/
Set-Location candidate
New-Item -ItemType Directory -Force proof,clean-smoke,smoke,old | Out-Null
$seven=Join-Path $env:ProgramFiles '7-Zip/7z.exe'
if (-not (Test-Path $seven)) { $seven=(Get-Command 7z.exe -ErrorAction Stop).Source }
& $seven x '-y' '-oextracted-nsis' Klipper-Farm-R143-candidate.exe
if ($LASTEXITCODE -ne 0) { throw 'Exact NSIS extraction failed' }
$setup=(Resolve-Path Klipper-Farm-R143-candidate.exe).Path
$cleanDir=Join-Path $env:RUNNER_TEMP 'KF-R143-clean'
$process=Start-Process $setup -ArgumentList ('/S /D='+$cleanDir) -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Clean R143 installation failed' }
node scripts/r143-check-installed-payload.mjs $cleanDir "$PWD/extracted-nsis" "$PWD/proof/clean-installed-payload.json"
if ($LASTEXITCODE -ne 0) { throw 'Clean payload differs' }
node scripts/check-desktop-startup-smoke.mjs "$cleanDir/klipper-farm-client.exe" "$cleanDir/klipper-farmd.exe" clean-smoke
if ($LASTEXITCODE -ne 0) { throw 'Clean real WebView startup failed' }

$installDir=Join-Path $env:RUNNER_TEMP 'KF-R143-upgrade'
gh release download r142-ota --repo $env:GITHUB_REPOSITORY --pattern Klipper-Farm-R142-setup.exe --dir old
if ($LASTEXITCODE -ne 0) { throw 'Published R142 download failed' }
$old=(Resolve-Path old/Klipper-Farm-R142-setup.exe).Path
if ((Get-Item $old).Length -ne 233611051 -or (Get-FileHash $old).Hash.ToLowerInvariant() -ne 'd44bad2f409995ab9371af2984ff4da29cb00a49814e07d6101d0454944dffa4') { throw 'R142 baseline installer differs' }
$process=Start-Process $old -ArgumentList ('/S /D='+$installDir) -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'R142 baseline installation failed' }
node scripts/check-desktop-startup-smoke.mjs "$installDir/klipper-farm-client.exe" "$installDir/klipper-farmd.exe" smoke
if ($LASTEXITCODE -ne 0) { throw 'Published R142 WebView startup failed' }
$dataDir=Join-Path $env:APPDATA 'app.klipper.farm'
$database=Join-Path $dataDir 'farm.sqlite3'
$marker=Join-Path $dataDir 'r143-preservation.txt'
[IO.File]::WriteAllText($marker,'preserve-existing-data')
python scripts/r142-upgrade-data.py seed --database $database --proof proof/upgrade-data-seed.json
if ($LASTEXITCODE -ne 0) { throw 'Synthetic seven-printer stock fixture seed failed' }
node scripts/r143-installed-performance.mjs "$installDir/klipper-farm-client.exe" "$PWD/proof/performance-R142" $database R142
if ($LASTEXITCODE -ne 0) { throw 'Installed R142 process measurement failed' }
python scripts/r142-upgrade-data.py verify --database $database --proof proof/baseline-data-preserved.json
if ($LASTEXITCODE -ne 0) { throw 'Baseline profiling changed preserved business data' }

$process=Start-Process $setup -ArgumentList ('/S /D='+$installDir) -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'R143 upgrade over R142 failed' }
node scripts/r143-check-installed-payload.mjs $installDir "$PWD/extracted-nsis" "$PWD/proof/installed-payload.json"
if ($LASTEXITCODE -ne 0) { throw 'Upgraded exact payload differs' }
if ((Get-Content $marker -Raw) -ne 'preserve-existing-data') { throw 'Existing data marker lost' }
node scripts/check-desktop-startup-smoke.mjs "$installDir/klipper-farm-client.exe" "$installDir/klipper-farmd.exe" smoke
if ($LASTEXITCODE -ne 0) { throw 'Upgraded WebView startup failed' }
node scripts/check-headless-telemetry-runtime.mjs --daemon "$installDir/klipper-farmd.exe" --probe "$PWD/release/klipper-farm-ipc-probe.exe" --report "$PWD/proof/headless-runtime.json"
if ($LASTEXITCODE -ne 0) { throw 'Actual installed daemon telemetry or transfer regression failed' }
python scripts/r142-upgrade-data.py verify --database $database --proof proof/upgrade-data-before-fullscreen.json
if ($LASTEXITCODE -ne 0) { throw 'Upgrade changed printer or stock data' }
node scripts/r143-installed-fullscreen.mjs "$installDir/klipper-farm-client.exe" "$PWD/proof/installed-fullscreen" $database
if ($LASTEXITCODE -ne 0) { throw 'Actual installed TV fullscreen restoration failed' }
$fullscreen=Get-Content proof/installed-fullscreen/installed-fullscreen-report.json -Raw | ConvertFrom-Json
if ($fullscreen.release -ne 'R143' -or $fullscreen.passed -ne $true -or $fullscreen.passedCases -ne 5 -or $fullscreen.actualWindowsWindowManager -ne $true -or $fullscreen.actualInstalledWebView -ne $true -or $fullscreen.nativeWindowCallsReal -ne $true -or $fullscreen.configuredPrinters -ne 7) { throw 'Installed fullscreen evidence incomplete' }
node scripts/r143-installed-performance.mjs "$installDir/klipper-farm-client.exe" "$PWD/proof/performance-R143" $database R143
if ($LASTEXITCODE -ne 0) { throw 'Actual installed R143 process measurement failed' }
node scripts/r143-compare-installed-performance.mjs proof/performance-R142/installed-performance.json proof/performance-R143/installed-performance.json proof/installed-performance-comparison.json
if ($LASTEXITCODE -ne 0) { throw 'Installed Windows performance budgets failed' }
python scripts/r142-upgrade-data.py verify --database $database --proof proof/upgrade-data-after-profiling.json
if ($LASTEXITCODE -ne 0) { throw 'Installed UI or profile changed business data' }
node scripts/check-desktop-startup-smoke.mjs "$installDir/klipper-farm-client.exe" "$installDir/klipper-farmd.exe" smoke
if ($LASTEXITCODE -ne 0) { throw 'Upgraded real WebView restart failed' }
python scripts/r142-upgrade-data.py verify --database $database --proof proof/upgrade-data-after-restart.json
if ($LASTEXITCODE -ne 0) { throw 'Upgrade data changed after restart' }
node scripts/r143-check-installed-payload.mjs $installDir "$PWD/extracted-nsis" "$PWD/proof/installed-payload-after-restart.json"
if ($LASTEXITCODE -ne 0) { throw 'Installed payload changed after restart' }
@{candidate='R143';passed=$true;stablePublished=$false;buildRunId=$env:KF_R143_BUILD_RUN;buildHeadSha=$env:KF_R143_BUILD_HEAD;validationRunId=$env:GITHUB_RUN_ID;validationHeadSha=$env:GITHUB_SHA;upgradeFrom=142;cleanInstallVerified=$true;exactInstalledBytesVerified=$true;installedRestartVerified=$true;businessDataPreserved=$true;installedTvFullscreenCases=5;installedProcessPerformanceBudgets=9;physicalPrintersTested=$false} | ConvertTo-Json | Set-Content exact-validation.json -Encoding utf8NoBOM
Compress-Archive proof,smoke,clean-smoke R143-UI-proof.zip
Set-Location $workspace
