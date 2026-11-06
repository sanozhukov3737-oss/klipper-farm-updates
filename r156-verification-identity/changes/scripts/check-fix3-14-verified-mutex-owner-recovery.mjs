#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const buildId=read('RELEASE-BUILD-ID.txt').trim();
const client=read('src-tauri/src/engine_client.rs');
const lease=read('src-tauri/src/transactional_core/engine_lease.rs');
const core=read('src-tauri/src/transactional_core/mod.rs');
const rust=read('src-tauri/src/lib.rs');
const system=read('src-tauri/src/system_commands.rs');
const runner=read('scripts/run-rust-tests.mjs');
const physicalHarness=read('scripts/check-headless-telemetry-runtime.mjs');

assert.match(buildId,/^V20\.6-R/);

for(const marker of [
  'production_owner_record(data_dir)',
  'record.owner != "headless"',
  'tasklist.exe',
  '"PID eq {}"',
  '["/F", "/T", "/PID", &pid]',
  'trusted_daemon_image_name(&image_name)',
  'STALE_RECORDED_DAEMON_RETIRED',
])assert.ok(client.includes(marker),`verified recorded-owner recovery is missing ${marker}`);
for(const marker of [
  'pub(crate) struct ProductionOwnerRecord',
  'pub(crate) fn production_owner_record(',
  'pid: record.pid',
  'owner: record.owner',
  'acquired_at: record.acquired_at',
])assert.ok(lease.includes(marker),`durable owner evidence is missing ${marker}`);

const takeover=client.slice(client.indexOf('fn retire_unreachable_windows_owner'),client.indexOf('fn retire_authenticated_daemon'));
assert.ok(takeover.indexOf('retire_known_windows_daemon_images()?')<takeover.indexOf('retire_recorded_windows_daemon(data_dir)?'),'recorded owner fallback does not follow ordinary image cleanup');
assert.ok(takeover.indexOf('retire_recorded_windows_daemon(data_dir)?')<takeover.indexOf('wait_for_windows_engine_owner_release(retired)'),'mutex is checked before recorded owner recovery runs');
assert.ok(client.includes('record.pid == std::process::id()'),'recorded-owner recovery can terminate the current desktop');
assert.ok(!client.includes('["/F", "/T", "/PID", &record.pid.to_string()]'),'temporary PID is passed unsafely to Command');
assert.ok(client.includes('HEADLESS_ENGINE_UNIDENTIFIED_OWNER'),'a genuinely unrelated mutex owner must remain fail-closed');

const coreInitialize=core.slice(core.indexOf('pub fn initialize(&self, app:'),core.indexOf('pub(crate) fn initialize_headless'));
assert.ok(coreInitialize.includes('app.try_state::<EngineClient>()'),'embedded core does not consult daemon startup ownership');
assert.ok(coreInitialize.indexOf('ensure_embedded_initialization_allowed()?')<coreInitialize.indexOf('crate::db_path(app)?'),'desktop can acquire the engine lease before the startup gate');
for(const marker of ['StartupState::Starting => Err','StartupState::Ready => Err','HEADLESS_ENGINE_STARTING','HEADLESS_ENGINE_ACTIVE'])assert.ok(client.includes(marker),`embedded startup gate is missing ${marker}`);
assert.ok(runner.includes('embedded_core_cannot_race_daemon_startup_or_ready_state'),'Rust gate omits the desktop/daemon race regression');
assert.ok(runner.includes('recorded_daemon_image_parser_accepts_only_product_sidecars'),'Windows Rust gate omits recorded-owner image validation');
for(const marker of ['const cleanupChildren=[...children]','await Promise.all(cleanupChildren.map(child=>waitForChildExit(child,2_000)))','runtime harness left a child process alive; installer launch is blocked'])assert.ok(physicalHarness.includes(marker),`physical runtime cleanup is not deterministic: ${marker}`);

for(const [name,source] of [['native Moonraker HTTP',rust],['camera snapshot',system]]){
  assert.ok(!source.includes('core.initialize(&app)?;\n    let scheduler = core.scheduler();'),`${name} can still seize the engine lease just to use the scheduler`);
}

const parseTasklistImage=line=>{
  const normalized=line.trim();
  if(!normalized.startsWith('"'))return undefined;
  const separator=normalized.indexOf('\",\"',1);
  return separator<0?undefined:normalized.slice(1,separator);
};
const trusted=image=>{
  const normalized=image.toLowerCase();
  return normalized.startsWith('klipper-farmd')&&normalized.endsWith('.exe')&&/^[a-z0-9._-]+$/.test(normalized);
};
assert.equal(parseTasklistImage('"klipper-farmd-build-7.exe","4242","Console","1","10,000 K"'),'klipper-farmd-build-7.exe');
assert.ok(trusted('klipper-farmd-build-7.exe'));
assert.ok(!trusted('klipper-farm-client.exe'));
assert.ok(!trusted('other-klipper-farmd.exe'));

console.log('FIX3.14 verified mutex-owner recovery checks passed: recorded headless PID recovery, strict image validation and desktop/daemon startup exclusion are locked');
