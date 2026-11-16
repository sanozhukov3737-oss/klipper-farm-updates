#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from './typescript-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const loadTypeScript=async relative=>{
  const source=read(relative);
  const compiled=ts.transpileModule(source,{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},
    fileName:relative,
    reportDiagnostics:true,
  });
  assert.equal(compiled.diagnostics?.length??0,0,`${relative}: transpile diagnostics`);
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
};

const telemetry=await loadTypeScript('src/lib/printerTelemetry.ts');
assert.equal(telemetry.dataFreshness(undefined,100_000),'unavailable');
assert.equal(telemetry.dataFreshness(80_000,100_000),'live','20 seconds must still be live');
assert.equal(telemetry.dataFreshness(79_999,100_000),'stale','data must become stale immediately after 20 seconds');
assert.equal(telemetry.dataFreshness(0,120_000),'stale','120 seconds is the last visible stale value');
assert.equal(telemetry.dataFreshness(0,120_001),'expired','long outage must hide the card value');
const telemetryStatus={state:'ready',progress:0,printDuration:0,nozzle:217,nozzleTarget:220,bed:61,bedTarget:60,telemetryUpdatedAt:66_000};
assert.equal(telemetry.telemetryLabel(telemetryStatus,100_000),'Данные устарели · 34 с назад');
assert.equal(telemetry.compactTelemetryLabel(telemetryStatus,100_000),'Устарели · 34 с');
assert.equal(telemetry.confirmedTemperature(217,telemetryStatus,100_000),'217°C');
assert.equal(telemetry.confirmedTemperature(217,telemetryStatus,200_001),'—');
assert.equal(telemetry.lastResponseLabel(90_000,100_000),'Последний ответ 10 с назад');

const endpoint=await loadTypeScript('src/lib/printerEndpoint.ts');
assert.equal(endpoint.printerHostDisplay('[fd12:3456::99]:7125'),'fd12:3456::99');
assert.equal(endpoint.printerHostDisplay('[fe80::1%12]:80'),'fe80::1%12');
assert.equal(endpoint.printerPort('[fd12:3456::99]:80'),80);
assert.equal(endpoint.printerEndpointKey('[fd12:3456::99]:7125'),'[fd12:3456::99]:7125');

const panel=read('src/components/DiscoveryPanel.tsx');
const app=read('src/App.tsx');
const health=read('src/lib/printerHealth.ts');
const moonraker=read('src/lib/moonraker.ts');
const native=read('src-tauri/src/lib.rs');
const discoveryCommands=read('src-tauri/src/discovery_commands.rs');
const discovery=read('src-tauri/src/transactional_core/discovery.rs');
const scheduler=read('src-tauri/src/transactional_core/scheduler.rs');
const clock=read('src/lib/liveClock.ts');
const card=read('src/components/PrinterCard.tsx')+read('src/components/FleetPrinterCard.tsx');
const fleet=read('src/components/FleetDashboard.tsx')+read('src/components/FleetPrinterCard.tsx');
const control=read('src/components/ControlPanel.tsx');
const fixAndInstall=read('FIX_AND_INSTALL.bat');
const windowsBuilder=read('scripts/build-and-install-windows.mjs');
const rustTests=read('src-tauri/src/lib_tests.rs');
const verificationLab=read('scripts/verification-lab-v20.mjs');

for(const marker of [
  "listen<DiscoveryFound>('moonraker-discovery-result'",
  'identifyActiveRef.current<3',
  'acceptFound(payload.printer',
  'Moonraker найден · требуется API Key',
  "secureInvoke<ApiKeyValidation>('validate_moonraker_api_key'",
  'className="discoveryReport"',
  'className="discoveryAdvanced"',
  'if(rowsRef.current.length>0&&!hasNew)scheduleClose(4_500)',
  'const scrubCredentials=useCallback',
  "const previous:CredentialDraft=current[key]??{value:'',state:'idle'}",
  "secureInvoke<DiscoveredPrinter[]>('probe_moonraker_host'",
  '2,4 и 5 ГГц не мешают сами по себе.',
  "row.moonraker_confirmed&&!row.auth_required",
  'Диагностический ZIP',
])assert.ok(panel.includes(marker),`streaming discovery UI is missing ${marker}`);
assert.ok(!panel.includes("{value:'',state:'idle',...current[key]"),'credential state must not declare properties before an overriding spread');
assert.ok(!panel.includes('scheduleClose(hasNew?'),'new printers must suppress automatic close');
assert.ok(!panel.includes('scheduleClose(6_000)'),'search errors must stay open for diagnostics');
assert.ok(app.includes('Принтер сменил IP-адрес')&&app.includes('Stable ID:'),'DHCP address-change confirmation is incomplete');
assert.ok(app.includes("secureInvoke<DiscoveryResult>('discover_moonraker'")&&app.includes("secureInvoke<SavedPrinterIdentityProbe>('recheck_saved_printer_identity'")&&app.includes("audit('printer.ip_changed'")&&app.includes("if(!stopped)schedule()},addressPlanRef.current.blockedIds.size?30_000:90_000)"),'periodic saved-printer/IP-change recovery is missing');
assert.ok(app.includes('await secretSet(configured.id,row.apiKeyForAdd)'),'validated key does not reach the OS credential boundary');
assert.ok(discovery.includes('pub(crate) fn validate_api_key')&&discoveryCommands.includes('validate_header_value(&api_key, 512)?'),'native API-key verification boundary is missing');
assert.ok(discovery.includes('pub(crate) fn probe_saved_printer_identity')&&discoveryCommands.includes('stored_api_key(Some(&printer_id))?')&&native.includes('recheck_saved_printer_identity'),'saved-printer IP recovery must reuse the protected native API key');
assert.ok(discoveryCommands.includes('auth_required: true')&&native.includes('DISCOVERY_FOUND_EVENT'),'native discovery does not classify/stream authorization results');
assert.ok(discovery.includes('physical_ipv4_adapters()')&&discovery.includes('query_mdns(address, adapter_name)')&&discovery.includes('query_ssdp(address, adapter_name)')&&discovery.includes('collect_multicast_seeds_for_adapters'),'multicast discovery is not sent per physical adapter');
assert.ok(discovery.includes('0x8001_u16.to_be_bytes()'),'per-adapter mDNS sockets do not request unicast replies');
for(const marker of ['collect_priority_seeds','collect_multicast_seeds','arp_ipv4_hosts','manual_host_seeds','/server/info'])assert.ok(discovery.includes(marker),`R6 discovery source is missing ${marker}`);
for(const marker of ['http_response_callback','response.is_err() && seed.port != 80','/printer/info','probe_saved_printer_identity'])assert.ok(discovery.includes(marker),`R6 manual/priority discovery fallback is missing ${marker}`);
assert.ok(discoveryCommands.includes('response.status == 401')&&!discoveryCommands.includes('matches!(response.status, 401 | 403)'),'discovery must reserve API-key state for HTTP 401');
assert.ok(discoveryCommands.includes('discovery_retryable_error')&&discoveryCommands.includes('Moonraker response timeout'),'dead TCP connects must not consume the slow retry queue');
for(const marker of ['DISCOVERY_DEADLINE: Duration = Duration::from_secs(9)','DISCOVERY_FAST_WORKERS: usize = 64','moonraker_uuid','moonraker_confirmed'])assert.ok(native.includes(marker),`R6 native contract is missing ${marker}`);
for(const marker of ['_priority_worker = thread::spawn','multicast_handle = thread::spawn','Some(fast_candidate_callback.as_ref())','candidate.probe_state = "http_response"','Duration::from_secs(7)','same_discovered_printer'])assert.ok(discoveryCommands.includes(marker)||native.includes(marker),`parallel/immediate R6 discovery is missing ${marker}`);
assert.ok(discoveryCommands.includes('let fast_workers = DISCOVERY_FAST_WORKERS')&&discoveryCommands.includes('let slow_workers = DISCOVERY_SLOW_WORKERS'),'discovery workers are still coupled to actor EMA');

for(const reason of ['websocket','rest_jsonrpc','klipper_startup','authorization','klipper_shutdown','daemon_recovering','network','quarantine']){
  assert.ok(health.includes(`case'${reason}'`)||health.includes(`'${reason}'`),`connection reason ${reason} is missing`);
}
assert.ok(health.includes("status.connectionState==='online'"),'degraded status must not count as available');
assert.ok(moonraker.includes('Math.min(nozzleAt,bedAt)')&&moonraker.includes('mapped.jobUpdatedAt=jobObservedAt'),'heater/job observations need independent timestamps and conservative core age');
// Вызов получил четвёртый аргумент controllerLive: кеш не должен выдавать себя
// за живой контроллер. Форму вызова проверяем терпимо к хвосту, смысл — строго.
assert.ok(/this\.applyStatus\(snapshot\.cachedStatus,snapshot\.lastSeenAt\?\?now,snapshot[,)]/.test(moonraker)&&moonraker.includes('sourceTimestamps[sensor]'),'cached actor snapshots must preserve per-heater and job data ages');
const actor=read('src-tauri/src/transactional_core/actor.rs');
const nativeTemperature=read('src-tauri/src/transactional_core/temperature.rs');
assert.ok(actor.includes('self.snapshot.nozzle_updated_at = Some(observed_at)')&&actor.includes('self.snapshot.bed_updated_at = Some(observed_at)'),'native actor does not preserve independent heater observation ages');
assert.ok(actor.includes('self.snapshot.telemetry_updated_at = core_temperature_observed_at(')&&nativeTemperature.includes('Some(nozzle_at?.min(bed_at?))'),'native core freshness must require both actual observations and follow the older one');
assert.ok(clock.includes('window.setInterval(publish,1_000)')&&clock.includes('const subscribers=new Set'),'age labels must share one one-second clock');
for(const source of [card,fleet,control]){
  assert.ok((source.includes('Данные задания недоступны')||source.includes('Ожидаем данные задания')),'unconfirmed job telemetry fallback is missing');
  assert.ok(source.includes('confirmedTemperature'),'expired temperature values are not gated');
}
assert.ok(card.includes('printerWorkingChannel')&&fleet.includes('printerWorkingChannel')&&control.includes('printerWorkingChannel'),'working channel is not visible across printer views');
assert.ok(fixAndInstall.includes('scripts\\build-and-install-windows.mjs'),'FIX_AND_INSTALL does not route V20.6 into the one-click install workflow');
for(const marker of ["runNode('frontend payload','scripts/check-production-bundle.mjs')","verifyManifest('release'","verifyManifest('offline'","runNode('Rust tests','scripts/run-rust-tests.mjs')","spawn(installer,[],{detached:true"]){
  assert.ok(windowsBuilder.includes(marker),`one-click V20.6 builder is missing ${marker}`);
}
for(const marker of ['DiscoveryProbeOutcome::Miss','Arc::new(|_| {})','"websocket"','"rest"','auth_required: false','working_protocol: Some','working_port: Some']){
  assert.ok(rustTests.includes(marker),`V20.6 Rust discovery tests did not follow the production contract: ${marker}`);
}
assert.ok(rustTests.includes('moonraker_server_info_is_found_twenty_times_without_a_miss'),'20-run no-miss discovery regression is missing');
assert.ok(rustTests.includes('complete_24_fast_pass_stays_below_eight_seconds')&&rustTests.includes('assert_eq!(output.scanned, 508)'),'bounded /24 performance regression is missing');
for(const marker of ['process.env.npm_execpath','process.execPath,[npmCli,...args]','Failed checks:']){
  assert.ok(verificationLab.includes(marker),`Windows-safe verification runner is missing ${marker}`);
}
assert.ok(!verificationLab.includes("process.platform==='win32'?'npm.cmd':'npm'"),'verification must not spawn npm.cmd directly without cmd.exe');

console.log('V20.6 R8 discovery/display OK: streaming results, key gate, freshness, reasons, channels, adapter-bound IPv4/IPv6 and one-click Windows build');
