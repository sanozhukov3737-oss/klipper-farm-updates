param([switch]$Browser)
$ErrorActionPreference='Stop'
if ($env:GITHUB_REPOSITORY -ne 'sanozhukov3737-oss/klipper-farm-updates') { throw 'Wrong repository' }
$pins=[ordered]@{
 'r143-source-changes-v2.json'='7f7b70c0f34937589a2e1c2559c13652a9372c6acc665659e2079f1f6e045d8a'
 'apply-r143-maintenance.py'='426e5a0ce7a2c349de748fedbb90381b34523e4103530c1a76a23e706a241c94'
 'r143-run-inherited-checks.py'='e0325d0b2fc055611e3c08037abd7cf3a0b41154ae4da1eb7a23547bdafa07fc'
 'r142-build.zip'='5cd0ca3227de93b894cd2ce0bd0a8d3bcb9f1660b8415144c620ba2c5d815369'
 'r142-required-tests.json'='2fad3b15c11c24167f88c4bfd1d96b4938b5741a9a8b71218cd74bd2093d6623'
}
foreach ($entry in $pins.GetEnumerator()) {
 if ((Get-FileHash $entry.Key).Hash.ToLowerInvariant() -ne $entry.Value) { throw "Reviewed input differs: $($entry.Key)" }
}
New-Item -ItemType Directory -Force incoming,proof | Out-Null
Expand-Archive r142-build.zip r142-build
gh release download r142-ota --repo $env:GITHUB_REPOSITORY --pattern KF-R142-FULL.zip --dir incoming
if ($LASTEXITCODE -ne 0) { throw 'Published R142 source download failed' }
python apply-r143-maintenance.py incoming/KF-R142-FULL.zip work/app --changes r143-source-changes-v2.json --baseline work/r142 --proof proof/source-delta.json
if ($LASTEXITCODE -ne 0) { throw 'Exact R142 source application failed' }
$env:KF_PERF_BASELINE_SOURCE=(Resolve-Path work/r142).Path
$env:KF_R143_PROOF=Join-Path $env:GITHUB_WORKSPACE 'proof'
$env:KF_UI_SCREENSHOTS=$env:KF_R143_PROOF
Push-Location work/app
try {
 npm ci --no-audit --no-fund
 if ($LASTEXITCODE -ne 0) { throw 'Locked frontend dependencies failed' }
 if ($Browser) {
  npm ci --prefix ui-tests --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Locked browser dependencies failed' }
  $env:CHROMIUM_EXECUTABLE=Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'
  if (-not (Test-Path $env:CHROMIUM_EXECUTABLE)) { throw 'Real Edge is unavailable' }
  $env:PLAYWRIGHT_MODULE_PATH=([System.Uri]::new((Resolve-Path ui-tests/node_modules/playwright/index.mjs).Path)).AbsoluteUri
 }
} finally { Pop-Location }
