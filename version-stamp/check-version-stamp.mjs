#!/usr/bin/env node
// Verify that the built artifacts really carry the stamped version.
//
// The build can only regress here by producing artifacts whose PE version, single-instance
// identity or diagnostics banner disagree with version-stamp/version.json, so every gate is
// an exact comparison. Runs on the produced tree only: it never touches printers, the update
// channel or the published releases.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(readFileSync(join(here, 'version.json'), 'utf8'));

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const appRoot = resolve(option('--app', '.'));
const expected = option('--expected', settings.version);
const diagnosticsPath = option('--diagnostics', null);
const explicitArtifacts = args
  .map((value, index) => (value === '--artifact' ? args[index + 1] : null))
  .filter(Boolean)
  .map(file => resolve(file));
const isWindows = process.platform === 'win32';

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  throw new Error(`expected version is not a plain SemVer: ${expected}`);
}

const failures = [];
const notes = [];

const normalize = value => {
  const parts = String(value ?? '').trim().split('.');
  while (parts.length < 4) parts.push('0');
  return parts.slice(0, 4).join('.');
};
const expectedFour = normalize(expected);

const releaseDir = join(appRoot, '.klipper-build-cache', 'target', 'release');
const installerDir = join(appRoot, 'INSTALLER');

const artifacts = [];

if (explicitArtifacts.length === 0) {
  artifacts.push(
    join(releaseDir, 'klipper-farm-client.exe'),
    join(releaseDir, 'klipper-farmd.exe'),
    join(releaseDir, 'klipper-farm-ipc-probe.exe')
  );
  if (existsSync(installerDir)) {
    for (const entry of readdirSync(installerDir).filter(name => name.toLowerCase().endsWith('.exe'))) {
      artifacts.push(join(installerDir, entry));
    }
  }
} else {
  artifacts.push(...explicitArtifacts);
}

for (const artifact of artifacts) {
  if (!existsSync(artifact)) {
    failures.push(`missing build artifact: ${artifact}`);
  }
}

const present = artifacts.filter(existsSync);

if (isWindows && present.length > 0) {
  const quoted = present.map(file => `'${file.replaceAll("'", "''")}'`).join(',');
  const script = `$ErrorActionPreference='Stop';foreach($f in @(${quoted})){$v=(Get-Item -LiteralPath $f).VersionInfo;"$f|$($v.ProductVersion)|$($v.FileVersion)"}`;
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  });
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [file, productVersion, fileVersion] = line.trim().split('|');
    const product = normalize(productVersion);
    const fileFour = normalize(fileVersion);
    const label = file.split(/[\\/]/).slice(-2).join('/');
    if (product !== expectedFour) {
      failures.push(`${label}: ProductVersion ${productVersion || '(empty)'} != ${expected}`);
    }
    if (fileFour !== expectedFour) {
      failures.push(`${label}: FileVersion ${fileVersion || '(empty)'} != ${expected}`);
    }
    if (product === expectedFour && fileFour === expectedFour) {
      notes.push(`${label}: PE version ${expected} OK`);
    }
  }
} else if (!isWindows) {
  notes.push('PE version checks skipped: not running on Windows');
}

const mutexPattern = new RegExp('KlipperFarmClient-v');
for (const artifact of present) {
  // Only the desktop client owns the single-instance guard; the daemon owns the engine mutex.
  if (!/[\\/]klipper-farm-client\.exe$/i.test(artifact)) continue;
  const text = readFileSync(artifact).toString('latin1');
  const name = artifact.split(/[\\/]/).slice(-1)[0];
  if (!text.includes('KlipperFarmClient')) {
    failures.push(`${name}: single-instance mutex name is missing from the binary`);
  }
  if (mutexPattern.test(text)) {
    failures.push(`${name}: versioned mutex name is still compiled in (stale instance guard)`);
  }
}

if (diagnosticsPath) {
  if (!existsSync(diagnosticsPath)) {
    failures.push(`diagnostics package is missing: ${diagnosticsPath}`);
  } else {
    const text = readFileSync(diagnosticsPath, 'utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      failures.push(`diagnostics package is not JSON anymore: ${diagnosticsPath}`);
    } else if (parsed.appVersion !== expected) {
      failures.push(`diagnostics appVersion ${parsed.appVersion} != ${expected}`);
    } else {
      notes.push(`diagnostics appVersion ${expected} OK`);
    }
  }
}

for (const note of notes) console.log(note);
if (failures.length > 0) {
  console.error('\nVersion stamp verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Version stamp verified: ${present.length} artifact(s) at ${expected}`);
