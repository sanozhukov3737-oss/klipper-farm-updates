#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from './typescript-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const loadTypeScript=async relative=>{
  const compiled=ts.transpileModule(read(relative),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},fileName:relative,reportDiagnostics:true});
  assert.equal(compiled.diagnostics?.length??0,0,`${relative}: transpile diagnostics`);
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
};

const {MoonrakerChannelHealth}=await loadTypeScript('src/lib/connectionReliability.ts');
const {printerPresentationPreset}=await loadTypeScript('src/lib/printerPresentation.ts');
const probablePresentation={
  name:'Klipper · 192.168.1.110',
  profile:{preset:'custom'},
  modelSelection:{mode:'automatic',selectedPreset:'custom',lastDetection:{status:'matched',decision:'probable',model:'creality-k1c-2025',conflicts:[]}},
};
assert.equal(printerPresentationPreset(probablePresentation),'creality-k1c-2025','probable safe presentation must select matching model art');
assert.equal(printerPresentationPreset({...probablePresentation,modelSelection:{...probablePresentation.modelSelection,lastDetection:{...probablePresentation.modelSelection.lastDetection,decision:'conflict',conflicts:[{id:'insufficient-margin'}]}}}),undefined,'conflicted detection must use neutral art');
assert.equal(probablePresentation.profile.preset,'custom','presentation inference must not mutate the operational profile');
const primary={protocol:'websocket',port:80},fallback={protocol:'rest',port:7125};
const channels=new MoonrakerChannelHealth(primary,()=>.5);
channels.recordFailure(primary,'first timeout',1_000);
channels.recordSuccess(fallback,25,1_001);
assert.deepEqual(channels.active(),primary,'one transient failure must not switch the route');
channels.recordFailure(primary,'second timeout',2_000);
channels.recordSuccess(fallback,24,2_001);
assert.deepEqual(channels.active(),fallback,'two primary failures must activate a healthy fallback');
assert.deepEqual(channels.ordered([primary,fallback],10_000)[0],fallback,'fallback must remain sticky before the canary interval');
assert.deepEqual(channels.ordered([primary,fallback],17_000)[0],primary,'primary canary was not scheduled');
channels.recordSuccess(primary,20,17_001);
for(const now of [32_001,47_001]){
  assert.deepEqual(channels.ordered([primary,fallback],now)[0],primary,'primary canary cadence was lost');
  channels.recordSuccess(primary,20,now);
  assert.deepEqual(channels.active(),fallback,'primary route returned before the 45-second stability window');
}
assert.deepEqual(channels.ordered([primary,fallback],62_001)[0],primary);
channels.recordSuccess(primary,19,62_001);
assert.deepEqual(channels.active(),primary,'stable primary route did not recover after 45 seconds');
const routeSnapshot=channels.snapshot(62_001);
assert.equal(routeSnapshot.lastSwitchReason,'primary_stable');
assert.equal(routeSnapshot.switches,2);
assert.equal(routeSnapshot.routeHistory.length,2);
assert.deepEqual(routeSnapshot.routeHistory[0].to,primary);
channels.reset(primary);
assert.equal(channels.snapshot().switches,0,'route reset must not retain a count after clearing its history');

const emergency=new MoonrakerChannelHealth(primary,()=>.5);
emergency.recordFailure(primary,'first timeout',1_000);
emergency.recordFailure(primary,'second timeout',2_000);
emergency.recordSuccess(fallback,20,2_001);
emergency.recordFailure(fallback,'first fallback failure',3_000);
emergency.recordFailure(fallback,'second fallback failure',4_000);
emergency.recordSuccess(primary,18,4_001);
assert.deepEqual(emergency.active(),primary,'a failed fallback must not hold a newly healthy primary behind the stability window');

const native=read('src-tauri/src/moonraker_protocol.rs');
const discovery=read('src-tauri/src/transactional_core/discovery.rs');
const commands=read('src-tauri/src/discovery_commands.rs');
const actor=read('src-tauri/src/transactional_core/actor.rs');
const actorTypes=read('src-tauri/src/transactional_core/types.rs');
const actorBoundary=read('src-tauri/src/transactional_core/mod.rs');
const nativeRoot=read('src-tauri/src/lib.rs');
const app=read('src/App.tsx');
const recovery=read('src/lib/printerAddressRecovery.ts');
const panel=read('src/components/DiscoveryPanel.tsx');
const settings=read('src/components/PrinterSettings.tsx');
const wizard=read('src/components/SetupWizard.tsx');
const moonraker=read('src/lib/moonraker.ts');
const artwork=read('src/lib/printerArtwork.ts');
const presentation=read('src/lib/printerPresentation.ts');
const names=read('src/lib/printerName.ts');
const styles=read('src/styles.css');
const distLock=read('scripts/lock-v20-6-dist.mjs');
const v20Core=read('scripts/check-v20-core.mjs');
const windowsBuilder=read('scripts/build-and-install-windows.mjs');

for(const marker of ['Socket::new','.bind(&source)','connect_timeout','http_request_bound','websocket_rpc_blocking_bound'])assert.ok(native.includes(marker),`source-bound TCP marker missing: ${marker}`);
for(const marker of ['collect_priority_seeds_for_adapters','collect_multicast_seeds_for_adapters','seed.bind_ip','active_ipv6_multicast_interfaces','active_discovery_adapters','query_mdns_v6(index, address, name, bind_ipv4)','"iproxy"','"vanya vpn"','"wireguard"','"wintun"'])assert.ok(discovery.includes(marker),`adapter discovery marker missing: ${marker}`);
for(const marker of ['selected_adapter_addresses','adapter_selected_override','fast_recovery','different_subnet','isolation_suspected','network_environment_snapshot','validate_stored_moonraker_api_key'])assert.ok(commands.includes(marker),`native hardening contract missing: ${marker}`);
assert.ok(commands.includes('Discovery is a desktop-owned, deadline-bounded network operation'),'discovery must stay independent from the daemon-owned engine lease');
assert.ok(!commands.includes('core.initialize(&app)?'),'discovery commands must never attempt to acquire the daemon-owned engine lease');
for(const obsolete of ['pub fn discovery_workers(&self','pub fn known_actor_hosts(&self','pub fn stable_hosts(&self','MAX_DISCOVERY_CONCURRENCY'])assert.ok(!`${actorBoundary}\n${read('src-tauri/src/transactional_core/journal.rs')}\n${read('src-tauri/src/transactional_core/scheduler.rs')}`.includes(obsolete),`obsolete embedded discovery API must not survive: ${obsolete}`);
for(const marker of ['Found(Box<DiscoveredPrinter>, DiscoveryDiagnosticEntry)','type DiscoveryAddressPlan =','items.push(*printer)','discovery_retryable_error','response.status == 401'])assert.ok(commands.includes(marker),`Clippy-safe discovery marker missing: ${marker}`);
assert.ok(!commands.includes('matches!(response.status, 401 | 403)'),'generic HTTP 403 must not identify Moonraker');
assert.match(commands,/outcome,\s*&error,\s*Some\("subnet_scan"\)/,'discovery diagnostics must borrow the error before retry classification');
assert.ok(!native.includes('pub(crate) fn websocket_handshake('),'unused synchronous WebSocket wrapper must not return under -D warnings');
assert.ok(commands.includes('pub(crate) fn discovery_operation_id'),'the validated discovery operation ID must remain visible to crate-level tests');
assert.ok(nativeRoot.includes('discovery_network_addresses, discovery_operation_id, discovery_retryable_error'),'the crate test scope must import discovery operation and retry helpers explicitly');
assert.ok(discovery.includes('let if_addrs::IfAddr::V4(ref value) = interface.addr'),'IPv4 adapter enumeration must borrow the address before consulting interface flags');
assert.ok(actor.includes('AUTHORIZATION_RECONNECT_DELAY')&&actor.includes('authorization_failure(&error)'),'native authorization retry suppression is missing');
for(const marker of ['Duration::from_secs(8)','source == "websocket"','partial response and repair the job group separately','"print_stats":null','"virtual_sdcard":null'])assert.ok(actor.includes(marker),`vendor telemetry reconciliation marker missing: ${marker}`);
for(const marker of ['ActorConnectionPresentation','connection_presentation','data_age_ms','job_age_ms','Moonraker найден — требуется API Key'])assert.ok(actorTypes.includes(marker),`unified actor presentation marker missing: ${marker}`);
assert.ok(actorBoundary.includes('ActorDesktopSnapshot')&&actorBoundary.includes('snapshot.connection_presentation(observed_at)'),'native presentation is not attached at the desktop boundary');
for(const marker of ['network_environment_snapshot','networkFingerprint','networkHeartbeat','fastRecovery:reason!==\'periodic\'','resetAuthorizationBackoff','klipper-discovery-adapters-v208'])assert.ok(app.includes(marker),`network/sleep recovery marker missing: ${marker}`);
for(const marker of ['INCOMPLETE_MODEL_RETRY_MS','selection.selectedPreset===\'custom\'','report.decision!==\'confirmed\''])assert.ok(app.includes(marker),`automatic model retry marker missing: ${marker}`);
for(const marker of ['probeWorkers','missingIndexes','preferRest:true,timeoutMs:5000',"detected.model==='creality-k1c-2025'","detected.model==='flashforge-ad5m'",'hasJobTelemetry','частичный снимок без print_stats/virtual_sdcard'])assert.ok(moonraker.includes(marker),`missing-fact model/transport repair marker missing: ${marker}`);
for(const marker of ['generic-klipper-printer.svg','printerPresentationPreset'])assert.ok(artwork.includes(marker),`safe printer artwork marker missing: ${marker}`);
for(const marker of ['printerPresentationPreset','detection.decision===\'probable\'','Presentation must never unlock model-only commands'])assert.ok(presentation.includes(marker),`safe printer presentation marker missing: ${marker}`);
assert.ok(names.includes('generatedKlipperName')&&names.includes('printerPresentationPreset(printer)'),'generic saved printer names must yield to detected model presentation');
assert.ok(app.includes('printersRef.current=next;')&&app.includes("void printerActorRemove(stableId).catch"),'printer deletion must update the UI before native cleanup');
assert.ok(actorBoundary.includes('pub(crate) async fn printer_actor_remove')&&actorBoundary.includes('PrinterActor remove worker failed'),'printer deletion cleanup must not block the WebView command thread');
for(const marker of ['strongIdentityConflict','identityConflictAccepted','saved_identity_collision','savedCollisions','DISCOVERY_HISTORY_KEY','selectedAdapterAddresses','adapter_selected_override','routeSwitches','discoveryAdapters','Последние поиски','klipper-discovery-adapters-v208','VPN автоматически исключён','HTTP-ответов','Camera discovery follows model detection'])assert.ok(panel.includes(marker),`discovery UI hardening marker missing: ${marker}`);
assert.ok(panel.indexOf('if(uuidLeft&&uuidRight)')<panel.indexOf('if(deviceLeft?.dedupeSafe&&deviceRight?.dedupeSafe)'),'Moonraker UUID must remain authoritative over local derived Stable IDs in the UI');
assert.ok(panel.includes('!savedIdentityConflict(printer,row)&&('),'saved identity conflicts must be rejected before any Stable ID or endpoint match');
assert.ok(app.includes('if(byIdentity&&!savedIdentityConflictsWithDiscovery(byIdentity,row))return byIdentity'),'a conflicting saved identity must never be overwritten through the Stable ID fast path');
// Логика восстановления адреса переехала в printerAddressRecovery.ts, где
// конфликт любого якоря (включая UUID) даёт отказ через
// strongPrinterIdentityMatch. Литерала uuidConflict в App.tsx больше нет.
assert.ok(app.includes('planPrinterAddressRecovery')
  &&recovery.includes("anchorNames=['machineId','uuid'")
  &&recovery.includes('if(a!==b)return false'),'background DHCP recovery must reject an authoritative UUID conflict');
for(const marker of ['validate_stored_moonraker_api_key','validate_moonraker_api_key','secretDelete(v.id)','Windows Credential Manager'])assert.ok(settings.includes(marker),`API key lifecycle marker missing: ${marker}`);
assert.ok(wizard.includes("secureInvoke<ApiKeyValidation>('validate_moonraker_api_key'"),'setup wizard does not share native API-key validation');
for(const marker of ['.discoveryIdentityConflict','.discoveryAdapters','.discoveryHistory','.apiKeyLifecycle','@media(max-height:768px)','V20.6 R7: the light discovery workflow is white end to end','.discoveryBackdrop{background:#fff!important'])assert.ok(styles.includes(marker),`responsive hardening style missing: ${marker}`);
assert.ok(styles.includes('deletion must stay visible and must not depend on hover'),'the printer delete action must remain permanently visible');
assert.ok(distLock.includes("'klipper-discovery-adapters-v208'")&&!distLock.includes('VPN и виртуальные адаптеры выключены автоматически'),'dist locking must follow the current VPN-safe frontend marker');
// Кнопка удаления переехала в PrinterCard: подпись нужна и мыши, и клавиатуре.
const card=read('src/components/PrinterCard.tsx');
assert.ok(card.includes('title={`Удалить принтер «${name}»`}')&&card.includes('aria-label={`Удалить принтер «${name}»`}'),'the visible delete action must remain labelled for mouse and keyboard users');
assert.ok(app.includes('onDelete={()=>remove(settingsPrinter.id)}')&&settings.includes('className="danger printerSetupDelete"'),'printer deletion must also remain available from printer settings');
assert.ok(v20Core.includes('const tauriInlineTable=cargo.match')&&v20Core.includes('requiredTauriFeatures.every'),'Tauri feature verification must tolerate valid TOML whitespace');
for(const stage of ['frontend payload','package integrity','Rust tests','installer collection'])assert.ok(windowsBuilder.includes(`'${stage}'`),`Windows builder is missing the precise ${stage} failure stage`);

console.log('V20.6 R8 hardening OK: adapter-bound discovery, stable identity, API-key lifecycle, telemetry repair, model presentation and stable layout');
