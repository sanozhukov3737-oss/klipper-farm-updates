#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const sha=relative=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,relative))).digest('hex');
const client=read('src-tauri/src/engine_client.rs');
const lease=read('src-tauri/src/transactional_core/engine_lease.rs');
const hooks=read('src-tauri/windows/installer-hooks.nsh');

assert.match(read('RELEASE-BUILD-ID.txt').trim(),/^V20\.6-R/,'FIX3.12 ownership recovery is not carried by the current build');
assert.equal(sha('FIX_AND_INSTALL.bat'),'4b11eb0216546834b9d57902384455f9f2e980c9df4676998ec2bae0ac662d96','GOLD FIX_AND_INSTALL.bat changed');
assert.equal(sha('VERIFY_AND_BUILD_V20.bat'),'2e5100f1fe6f823a59590123e91cd6229b63af07afcf81df06c17e15c29d4ed5','GOLD VERIFY_AND_BUILD_V20.bat changed');

for(const marker of [
  'fn start_daemon_until_ready(',
  '!authenticated_daemon_retired',
  'let launch_attempts = if cfg!(windows) { 2 } else { 1 };',
  'engine_owner_conflict(&error)',
  'HEADLESS_ENGINE_OWNER_RECOVERY_EXHAUSTED',
  'fn retire_unreachable_windows_owner(',
  'wait_for_windows_engine_owner_release(retired)',
  'HEADLESS_ENGINE_UNIDENTIFIED_OWNER',
  'HEADLESS_ENGINE_MUTEX_RELEASE_TIMEOUT',
])assert.ok(client.includes(marker),`FIX3.12 ownership recovery is missing ${marker}`);

assert.ok((client.match(/start_daemon_until_ready\(/g)??[]).length>=5,'startup helper is not shared by initial startup and all recovery branches');
const recovery=client.slice(client.indexOf('fn recover('),client.indexOf('fn probe_path('));
assert.ok((recovery.match(/start_daemon_until_ready\(/g)??[]).length>=3,'transport recovery can still bypass stale-owner takeover');
assert.ok(client.indexOf('wait_for_windows_engine_owner_release(retired)')<client.indexOf('fn retire_authenticated_daemon'),'mutex release is not verified inside the pre-start path');
assert.match(client,/\#\[cfg\(debug_assertions\)\]\s+if let Some\(path\) = std::env::var_os\("KLIPPER_FARMD_PATH"\)/,'release build still accepts an arbitrary daemon override');
assert.ok(!client.includes('taskkill.exe" /F /T /IM "klipper-farm-client.exe'),'runtime takeover can kill the desktop process');

for(const marker of [
  'const PRODUCTION_MUTEX_NAME: &str = "Local\\\\KlipperFarmEngine-v18";',
  'pub(crate) fn production_owner_present()',
  'fn named_mutex_present(',
  'windows_named_mutex_probe_observes_owner_and_release',
  'assert!(platform::named_mutex_present(&mutex_name).unwrap());',
])assert.ok(lease.includes(marker),`Windows mutex probe is missing ${marker}`);

for(const image of [
  'klipper-farmd.exe',
  'klipper-farmd-x86_64-pc-windows-msvc.exe',
  'klipper-farmd-x86_64-pc-windows-gnu.exe',
]){
  assert.ok(client.includes(`"${image}"`),`runtime takeover omits ${image}`);
  assert.ok(hooks.includes(`/IM "${image}"`),`installer takeover omits ${image}`);
}

console.log('FIX3.12 engine ownership recovery checks passed: startup and transport recovery share bounded takeover, verify mutex release and retry one owner collision');
