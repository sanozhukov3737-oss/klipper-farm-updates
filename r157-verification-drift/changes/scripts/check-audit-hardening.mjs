#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const engine=read('src-tauri/src/engine_client.rs');
const database=read('src-tauri/src/database.rs');
const migrations=read('src-tauri/src/transactional_core/migrations.rs');
const coreModule=read('src-tauri/src/transactional_core/mod.rs');
const durableFs=read('src-tauri/src/transactional_core/durable_fs.rs');
const rust=read('src-tauri/src/lib.rs');
const system=read('src-tauri/src/system_commands.rs');
const native=read('src/lib/native.ts');
const telegram=read('src/lib/telegram.ts');
const app=read('src/App.tsx');
const systemPanel=read('src/components/SystemPanel.tsx');
const tauri=JSON.parse(read('src-tauri/tauri.conf.json'));
const e2e=read('e2e/run-e2e.mjs');
const modalHelper=read('src/lib/modalAccessibility.ts');
const modalConsumers=[
  'src/components/QrScanner.tsx','src/components/CameraModal.tsx','src/components/QueuePanel.tsx',
  'src/components/MaintenancePanel.tsx','src/components/FleetHealthPanel.tsx','src/components/ProductionPanel.tsx',
  'src/components/PrinterSettings.tsx','src/components/AutoDispatchPanel.tsx','src/components/AnalyticsPanel.tsx',
  'src/components/SystemPanel.tsx','src/components/NotificationCenter.tsx','src/lib/appDialogs.tsx',
];

assert.match(read('RELEASE-BUILD-ID.txt').trim(),/^V20\.6-R/,'build identity is not a V20.6 release');
for(const marker of ['enum StartupState','Starting','Ready','EmbeddedFallback(String)','Failed(String)','Notify','spawned_daemon','HEADLESS_ENGINE_START_FAILED','attach_healthy_daemon_or_allow_fallback','stop_spawned_daemon'])assert.ok(engine.includes(marker),`engine startup/failover state is missing ${marker}`);
assert.ok(!engine.includes('KLIPPER_FARM_ALLOW_EMBEDDED_CORE'),'production connectivity still depends on an undocumented environment flag');
assert.ok(native.includes("secureInvoke<HeadlessEngineStatus>('headless_engine_status')")&&app.includes('kfEngineNotice'),'current engine/failover state is not visible to the operator');
assert.ok(app.includes("diagnosticError('printer.connect'")&&app.includes("diagnosticWarning('printer.reconnect'"),'top-level printer connection failures are still swallowed');
assert.ok(rust.includes('fn engine_owner_conflict')&&rust.includes('MOONRAKER_DIRECT_FAILOVER')&&rust.includes('embedded_ready && core.snapshot_for_printer'),'engine lease conflict can still block direct Moonraker telemetry');
assert.ok(engine.includes('pub(crate) async fn call_async')&&engine.includes('engine_runtime::spawn_blocking'),'bounded async IPC bridge is missing');
assert.ok(!rust.includes('client.call('),'Tauri root command handler contains direct blocking engine IPC');
assert.ok(!read('src-tauri/src/transactional_core/farm_services.rs').includes('client.call('),'farm service handler contains direct blocking engine IPC');
assert.ok(!read('src-tauri/src/transactional_core/upload.rs').includes('client.call('),'upload handler contains direct blocking engine IPC');
assert.ok(database.includes('busy_timeout(SQLITE_BUSY_TIMEOUT)'),'SQLite busy timeout is missing');
assert.ok(!database.slice(database.indexOf('pub(crate) fn open_db'),database.indexOf('pub(crate) fn initialize_app_database')).includes('migrate_with_backup'),'ordinary database opens still run migrations');
assert.ok(migrations.includes('if previous_version == SCHEMA_VERSION')&&migrations.includes('DATABASE_SCHEMA_TOO_NEW'),'migration version guard is missing');
for(const marker of ['revoke_user_sessions(&mut inner, &id)','SESSION_ABSOLUTE_MS','MAX_FAILURE_RECORDS','GLOBAL_FAILURE_LIMIT','bounded_spawn_blocking(ExecutionClass::Control'])assert.ok(rust.includes(marker),`auth hardening is missing ${marker}`);
assert.ok(!native.includes('secret_get')&&!system.includes('fn secret_get('),'native secret read command is still exposed');
assert.ok(telegram.includes('telegramSendNative')&&!telegram.includes('fetch('),'Telegram still sends from WebView');
assert.ok(system.includes('async fn telegram_send(')&&system.includes('stored_api_key(Some(TELEGRAM_TOKEN_ID))'),'native Telegram sender is incomplete');
assert.ok(!tauri.app.security.csp.includes('api.telegram.org'),'Telegram remains in WebView CSP');
const endpointPublisher=read('src-tauri/src/headless_engine.rs').slice(read('src-tauri/src/headless_engine.rs').indexOf('fn publish_endpoint'),read('src-tauri/src/headless_engine.rs').indexOf('fn probe_existing'));
assert.ok(!endpointPublisher.includes('fs::remove_file(path)')&&endpointPublisher.includes('rename_atomic(&temporary, path)'),'endpoint publication must atomically replace the stale record without a delete gap');
assert.ok(coreModule.includes('pub(crate) mod durable_fs;')&&durableFs.includes('pub(crate) fn rename_atomic('),'Windows endpoint helper is not visible to headless_engine within the crate');
assert.ok(!durableFs.includes('use std::fs::{self, OpenOptions};'),'Windows build retains an unused std::fs import');
for(const marker of ['assert.equal(geometry.dialogs.length,1','Tab escaped the discovery dialog','Escape did not close the discovery dialog','KF_E2E_FIXTURE_PASSWORD'])assert.ok(e2e.includes(marker),`mandatory Windows E2E assertion is missing ${marker}`);
for(const marker of ["role','dialog'","aria-modal","button.setAttribute('aria-label',inferred)","??initial[0]??node).focus()","event.key!=='Tab'","event.key==='Escape'"])assert.ok(modalHelper.includes(marker),`modal accessibility helper is missing ${marker}`);
for(const file of modalConsumers)assert.ok(read(file).includes('useModalAccessibility('),`${file} does not use the shared modal accessibility boundary`);
assert.ok(systemPanel.includes('MAX_BACKUP_FILE_BYTES=24*1024*1024')&&systemPanel.indexOf('file.size>MAX_BACKUP_FILE_BYTES')<systemPanel.indexOf('file.text()'),'backup restore size cap must run before decoding');

assert.ok(engine.includes('retire_recorded_windows_daemon(data_dir)')&&engine.includes('ensure_embedded_initialization_allowed'),'verified mutex-owner recovery is missing from the audit boundary');
const fix313=read('scripts/check-fix3-13-identity-connection-recovery.mjs');
assert.ok(fix313.includes('const containsTokens=')&&fix313.includes('const findPattern='),'FIX3.13 source gate is still formatting-sensitive');
assert.ok(!read('scripts/verification-lab-v20.mjs').includes('check-fix3-16-format-independent-verification.mjs'),'the redundant test-of-a-test must not block Windows releases');

console.log('FIX3.17 audit hardening OK: format-independent FIX3.13 remains guarded without a redundant blocking meta-gate');
