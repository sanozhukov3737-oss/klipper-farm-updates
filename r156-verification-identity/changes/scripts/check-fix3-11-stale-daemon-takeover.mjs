#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const sha=relative=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,relative))).digest('hex');
const client=read('src-tauri/src/engine_client.rs');
const hooks=read('src-tauri/windows/installer-hooks.nsh');

assert.match(read('RELEASE-BUILD-ID.txt').trim(),/^V20\.6-R/,'FIX3.11+ build identity is stale');
assert.equal(sha('FIX_AND_INSTALL.bat'),'4b11eb0216546834b9d57902384455f9f2e980c9df4676998ec2bae0ac662d96','GOLD FIX_AND_INSTALL.bat changed');
assert.equal(sha('VERIFY_AND_BUILD_V20.bat'),'2e5100f1fe6f823a59590123e91cd6229b63af07afcf81df06c17e15c29d4ed5','GOLD VERIFY_AND_BUILD_V20.bat changed');

for(const marker of [
  'WINDOWS_DAEMON_IMAGE_NAMES',
  'klipper-farmd.exe',
  'klipper-farmd-x86_64-pc-windows-msvc.exe',
  'klipper-farmd-x86_64-pc-windows-gnu.exe',
  '!authenticated_daemon_retired',
  'retire_unreachable_windows_owner(data_dir)',
  'retire_known_windows_daemon_images()?',
  'SystemRoot',
  '.join("System32").join("taskkill.exe")',
  '.args(["/F", "/T", "/IM", image_name])',
  'status.code() == Some(128)',
  'HEADLESS_ENGINE_STALE_DAEMON_RETIRE_FAILED',
  'STALE_DAEMON_IMAGE_RETIRED',
])assert.ok(client.includes(marker),`stale daemon takeover is missing ${marker}`);
const guardedStart=client.slice(client.indexOf('fn start_daemon_until_ready'),client.indexOf('fn retire_authenticated_daemon'));
assert.ok(guardedStart.indexOf('retire_unreachable_windows_owner(data_dir)?')<guardedStart.indexOf('self.start_daemon(data_dir)?'),'stale owner is not retired before the replacement daemon starts');
assert.ok(!client.includes('taskkill.exe" /F /T /IM "klipper-farm-client.exe'),'runtime takeover can kill the desktop process');

for(const image of [
  'klipper-farmd.exe',
  'klipper-farmd-x86_64-pc-windows-msvc.exe',
  'klipper-farmd-x86_64-pc-windows-gnu.exe',
])assert.ok(hooks.includes(`/IM "${image}"`),`installer preflight does not retire ${image}`);

console.log('FIX3.11 stale daemon takeover checks passed: GOLD installer is unchanged and only known orphan sidecars are retired before engine startup');
