#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const moonraker=read('src/lib/moonraker.ts')+'\n'+read('src/lib/printerActorBridge.ts');
const core=read('src-tauri/src/transactional_core/mod.rs');
const engine=read('src-tauri/src/engine_client.rs');
// RPC-путь вынесен в rpc.rs (R232): собираем оба файла, иначе проверка
// ищет метки в месте, где их больше нет.
const assembly=`${read('src-tauri/src/lib.rs')}
${read('src-tauri/src/rpc.rs')}`;
const app=read('src/App.tsx');
const styles=read('src/styles.css');
const runtimeHarness=read('scripts/check-headless-telemetry-runtime.mjs');

for(const marker of [
  "secureInvoke<PrinterActorDesktopUpdates>('printer_actor_snapshots'",
  'actorBridgeSubscriptions',
  'includeEvents',
  'applyActorSnapshot',
  'pollActorCompatibility',
  'Moonraker доступен · REST/JSON-RPC',
  "snapshot.activeProtocol==='websocket'",
])assert.ok(moonraker.includes(marker),`desktop actor bridge is missing ${marker}`);
assert.equal((moonraker.match(/const actorBridgeSubscriptions=/g)??[]).length,1,'actor snapshots must be polled once per farm, not once per printer');
assert.ok(moonraker.includes("document.hidden?4_000:1_000"),'snapshot bridge lacks visible/background pacing');
assert.ok(moonraker.includes('printer_actor_events_ack'),'durable daemon events are not acknowledged after replay');
assert.ok(moonraker.includes("'printer_actor_events_ack',{printerId:this.config.id,host:this.config.host"),'outbox ACK is not bound to the saved printer endpoint');
assert.ok(moonraker.includes("'printer_actor_rpc',{")&&moonraker.includes('host:this.config.host'),'actor RPC is not bound to the saved printer endpoint');
assert.ok(moonraker.includes('actorCompatibilityInFlightEpoch===epoch'),'compatibility polling is not isolated across reconnect epochs');

for(const marker of [
  'pub(crate) async fn printer_actor_snapshots',
  'authorize_printer_target(&app, &user, &target.printer_id, &target.host)',
  'MAX_ACTOR_SNAPSHOT_TARGETS',
  'MAX_ACTOR_SNAPSHOT_EVENTS',
  'unique_targets.insert(key)',
  'PrinterActor snapshot bridge worker failed',
  'EngineCommand::PendingEvents',
  'authorize_printer_target(&app, &user, &printer_id, &host)',
])assert.ok(core.includes(marker),`target-bound actor batch is missing ${marker}`);
assert.ok(assembly.includes('printer_actor_snapshots,'),'target-bound actor batch is not registered with Tauri');
assert.ok(core.indexOf('pub(crate) fn printer_actor_list')<core.indexOf('Role::Admin)?;',core.indexOf('pub(crate) fn printer_actor_list')),'unfiltered actor list is not admin-only');

for(const marker of ['recovery_lock','engine_transport_recoverable','HEADLESS_ENGINE_RECOVERY_TIMEOUT','only_local_ipc_transport_failures_trigger_daemon_recovery']){
  assert.ok(engine.includes(marker),`headless-engine self-recovery is missing ${marker}`);
}
for(const marker of ['enum StartupState','StartupState::Starting','StartupState::Ready','StartupState::Failed','tokio::sync::Notify','wait_for_background_startup','route_to_daemon']){
  assert.ok(engine.includes(marker),`desktop/daemon startup race gate is missing ${marker}`);
}
for(const marker of ['StartupState::EmbeddedFallback','attach_healthy_daemon_or_allow_fallback','stop_spawned_daemon','HEADLESS_ENGINE_EMBEDDED_FAILOVER','settled_startup_failure_allows_single_owner_embedded_failover']){
  assert.ok(engine.includes(marker),`all-printers-offline failover regression guard is missing ${marker}`);
}
assert.ok(!engine.includes('KLIPPER_FARM_ALLOW_EMBEDDED_CORE'),'safe embedded failover still requires a manual environment flag');
for(const marker of ['fn engine_owner_conflict','MOONRAKER_DIRECT_FAILOVER','embedded_ready && core.snapshot_for_printer']){
  assert.ok(assembly.includes(marker),`stale engine-owner direct transport fallback is missing ${marker}`);
}
assert.ok(assembly.includes('error.contains("ENGINE_ALREADY_RUNNING")')&&assembly.includes('error.contains("HEADLESS_ENGINE_ACTIVE")'),'direct transport fallback is not restricted to engine-owner conflicts');
const actorUpsert=core.slice(core.indexOf('pub(crate) async fn printer_actor_upsert'),core.indexOf('pub(crate) async fn printer_actor_rpc'));
assert.ok(actorUpsert.indexOf('client.route_to_daemon().await?')<actorUpsert.indexOf('core.initialize(&app)?'),'printer actor can enter the embedded core before background daemon startup settles');
assert.ok(!engine.includes('engine_transport_recoverable("IPC_REMOTE_ERROR'),'remote Moonraker errors must never restart the daemon');
for(const marker of ['headless WebSocket telemetry snapshot','REST-only actor fallback readiness','persisted headless actor recovery']){
  assert.ok(runtimeHarness.includes(marker),`physical daemon telemetry harness is missing ${marker}`);
}

assert.ok(app.includes("page==='printers'?'printersMain':''"),'printer page has no one-screen layout scope');
assert.ok(!app.includes('Добавить вручную'),'the removed manual-add toolbar action returned');
assert.ok(!app.includes('kfPrinterPageActions'),'the empty printer toolbar row returned');
for(const marker of [
  '.printersMain>.kfTopbar',
  '.printersMain>.kfPrinterGrid',
  'grid-template-columns:repeat(3,minmax(0,1fr))',
  '@media(max-width:1100px) and (min-width:761px)',
  'grid-template-columns:74px minmax(0,1fr)',
])assert.ok(styles.includes(marker),`one-screen printer layout is missing ${marker}`);

console.log('printer connection bridge OK: daemon startup gate, snapshots/outbox, REST fallback, IPC recovery and one-screen printer layout are locked');
