#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const buildId=read('RELEASE-BUILD-ID.txt').trim();
const launcher=read('FIX_AND_INSTALL.bat');
const builder=read('scripts/build-and-install-windows.mjs');
const rootBatches=fs.readdirSync(root).filter(name=>name.toLowerCase().endsWith('.bat')).sort();

assert.equal(buildId,'V20.6-R15.10-UPDATE-DELIVERY-PRODUCTION-CANDIDATE-2026-11-14','wrong update delivery build identity');
const channel=JSON.parse(read('UPDATE-CHANNEL.json'));
assert.equal(channel.installedSequence,160,'production native updater must identify the installed release as R160');
assert.equal(channel.channel,'stable');
assert.equal(channel.publicKeyHex,'28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb');
assert.equal(channel.endpoint,'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json');
assert.deepEqual(rootBatches,['FIX_AND_INSTALL.bat'],'the package root must expose exactly one batch file');
assert.ok(launcher.includes('setlocal EnableExtensions DisableDelayedExpansion'),'launcher does not preserve special path characters');
assert.ok(launcher.includes('scripts\\build-and-install-windows.mjs'),'launcher does not call the clean orchestrator');
assert.equal((launcher.match(/node .*build-and-install-windows\.mjs/g)??[]).length,1,'launcher must invoke exactly one build orchestrator');
assert.ok(!launcher.includes('VERIFY_AND_BUILD_'),'launcher still chains a legacy verification batch');

const realMarkers=[
  "runNode('frontend payload','scripts/check-production-bundle.mjs')",
  "runNode('Rust tests','scripts/run-rust-tests.mjs')",
  "runNode('build cache fingerprint','scripts/prepare-windows-build-cache.mjs')",
  "run('Clippy','cargo'",
  "runNode('daemon sidecar','scripts/prepare-sidecar.mjs')",
  "run('Windows IPC probe','cargo'",
  "run('NSIS build',process.execPath",
  "runNode('desktop binary checks','scripts/check-windows-gui-binaries.mjs'",
  "spawn(installer,[],{detached:true",
];
for(const marker of realMarkers)assert.ok(builder.includes(marker),`clean installer lost real build stage: ${marker}`);
for(const forbidden of ['verification-lab-v20','check-fix3-','VERIFY_AND_BUILD_V20']){
  assert.ok(!builder.includes(forbidden),`clean installer still executes legacy gate: ${forbidden}`);
}
for(const forbidden of ['npm.cmd',"runNpm(","cargo',['fmt'",'generate-release-manifests.mjs']){
  assert.ok(!builder.includes(forbidden),`clean installer still mutates or downloads packaged source: ${forbidden}`);
}
assert.ok(!builder.includes('check-desktop-startup-smoke.mjs'),'uninstalled desktop smoke must not block a completed NSIS build');
for(const marker of ['BUILD-AND-INSTALL.log','BUILD-FAILURE.txt','Command/detail:','--self-test']){
  assert.ok(builder.includes(marker),`clean installer diagnostics are missing ${marker}`);
}
assert.ok(!builder.includes("'-D','warnings'")&&!builder.includes("'--','-D','warnings'"),'warnings were promoted to installer-blocking errors');

console.log(`R9.9 direct NSIS installer OK: one build entry, ${realMarkers.length} real-stage contracts, no legacy FIX/smoke gate`);
