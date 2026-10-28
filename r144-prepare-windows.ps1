param([switch]$Browser)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force incoming,proof | Out-Null
gh release download r143-ota --repo $env:GITHUB_REPOSITORY --pattern KF-R143-FULL.zip --dir incoming
if ($LASTEXITCODE -ne 0) { throw 'Published R143 source download failed' }
python r144-prepare.py incoming/KF-R143-FULL.zip work/app
if ($LASTEXITCODE -ne 0) { throw 'Exact R143 source application failed' }
$env:KF_UI_SCREENSHOTS=Join-Path $env:GITHUB_WORKSPACE 'proof'
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
