import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

const moonraker=read('src/lib/moonraker.ts');
const rust=`${read('src-tauri/src/lib.rs')}\n${read('src-tauri/src/moonraker_protocol.rs')}`;
const actor=read('src-tauri/src/transactional_core/actor.rs');
const dashboard=read('src/components/FleetDashboard.tsx');
const farmReports=read('src/lib/farmReports.ts');
const files=read('src/components/PrinterFilesPanel.tsx');
const production=read('src/components/ProductionPanel.tsx');

assert(moonraker.includes("type K1CTransport={protocol:'websocket'|'rest'|'jsonrpc'")&&moonraker.includes('const remembered=this.channelHealth.active()')&&moonraker.includes('this.k1cTelemetryTransport={protocol:remembered.protocol,defaultPort:remembered.port}'),'K1C adaptive transport does not retain the confirmed healthy route at connect time');
assert(moonraker.includes('queryK1CCoreStatus')&&moonraker.includes('index===0?2200:1400'),'K1C core job snapshot is not bounded across candidate transports');
assert(moonraker.includes('k1cTransportCandidates')&&moonraker.includes("configured===80?[80,7125]:configured===7125?[7125,80]:[80,7125]")&&moonraker.includes('moonrakerHostForPort')&&moonraker.includes('this.channelHealth.ordered')&&moonraker.includes('k1cAlternateTransportAllowed'),'K1C cannot fail over safely between port 80/7125 WebSocket and HTTP routes');
// Правило переехало в чистый модуль вместе с самой функцией: проверяем там,
// где оно теперь живёт, иначе проверка охраняла бы пустое место.
const moonrakerState=read('src/lib/moonrakerState.ts');
// Смысл проверки: отказ авторизации не лечится сменой транспорта. Условие —
// шаблон на 401/403 и отрицание результата, а не конкретная формулировка
// комментария: текст может меняться, инвариант — нет.
assert(moonrakerState.includes('(?:401|403)')&&/return\s*!\s*\/.*403/.test(moonrakerState),'K1C fallback may bypass an authorization failure');
assert(moonraker.includes('refreshK1CExtendedTelemetry')&&moonraker.includes('},1600)')&&moonraker.includes('must never change it offline'),'optional K1C heater telemetry can still break liveness');
assert(moonraker.includes('requestScheduler.run')&&moonraker.includes("requestScheduler.run('upload'")&&moonraker.includes('runBackgroundRequest')&&moonraker.includes('runControlRequest'),'K1C/FlashForge non-emergency network work is not routed through the priority scheduler');
assert(moonraker.includes("nativeRpc('printer.emergency_stop'")&&!moonraker.includes("requestScheduler.run('emergency'"),'emergency stop can still wait behind the WebView request scheduler');
assert(actor.includes('struct EmergencyTransport')&&actor.includes('return self.emergency.execute(request)'),'PrinterActor emergency command is not routed through its independent transport');
assert(moonraker.includes('statusAlreadyPolled=await this.pollStatus(epoch)')&&moonraker.includes('message:this.k1cConnectionMessage()'),'K1C core job snapshot is not used as its liveness and telemetry source');
assert(moonraker.indexOf('statusAlreadyPolled=await this.pollStatus(epoch)')<moonraker.indexOf(':await this.readConnectionInfo()'),'K1C still waits for server.info before core telemetry');
assert(moonraker.includes('latency:probeLatency')&&!moonraker.includes('latency:performance.now()-started'),'displayed latency still includes the full telemetry cycle');
assert(moonraker.includes('lastObjectCatalogAttemptAt=Date.now()')&&moonraker.includes('!k1c&&!this.objectCatalogInFlight'),'optional object discovery can still block K1C core telemetry');
assert(moonraker.includes("diagnosticWarning('moonraker.objects.catalog'")&&moonraker.includes('finally{if(this.objectCatalogInFlight===task)'),'FlashForge object discovery can still outlive its conservative poll lock or disappear from diagnostics');
assert(!moonraker.includes('K1C отвечает, но не отдал объекты extruder/heater_bed'),'partial K1C telemetry is still rejected when optional heaters are absent');

assert(rust.includes('query_get_first: bool')&&rust.includes('prefer_rest: Option<bool>'),'native preferred REST transport is not wired');
assert(rust.includes('async fn moonraker_ws_rpc')&&rust.includes('websocket_rpc_blocking')&&rust.includes('moonraker_default_port'),'native WebSocket/default-port K1C transport is not wired');
assert(rust.includes('bounded_rpc_timeout')&&rust.includes('bounded_http_timeout'),'native Moonraker timeouts are not bounded');
assert(rust.includes('Duration::from_millis(timeout_ms.unwrap_or(8_000).clamp(1_000, 8_000))'),'RPC timeout bounds changed unexpectedly');
assert(/if prefer_rest \{[\s\S]*?return Ok\(result\);\s*\}\s*let mut request/.test(rust),'a K1C REST timeout can still fall through into a second full JSON-RPC timeout');

// Ячейка печати переехала в FleetPrinterCard: пара «подтверждённое задание +
// свежая телеметрия» считается там, поэтому проверяем и доску, и карточку.
const card=read('src/components/FleetPrinterCard.tsx');
assert(dashboard.includes('printers.map((printer,index)=>')&&card.includes('jobFreshness(status, now)')&&card.includes("fresh === 'live' || fresh === 'stale'")&&card.includes('telemetryFreshness(status, now)'),'dashboard must render every printer job and gate it on confirmed telemetry');
assert(dashboard.includes('printerHasActiveJob')&&dashboard.includes('Math.round(printer.status.printDuration||0)')&&dashboard.includes('printer.status.telemetryUpdatedAt'),'dashboard can still hide or freeze a live job that the detailed panel displays');
assert(dashboard.includes('concurrency:2')&&dashboard.includes('window.setInterval(refresh,300_000)')&&farmReports.includes('mapLimit(available,concurrency'),'dashboard report refresh is not bounded');
assert(dashboard.includes('prefersConservativeBackgroundMode()?80:250'),'K1C/vendor report history is not using a conservative background limit');
assert(!dashboard.includes('queueStatus('),'dashboard still duplicates the queue refresh in the background');
assert(!dashboard.includes('Promise.all(printers.map'),'dashboard still fans out unbounded requests to every printer');

const immediateList=files.indexOf('setFiles(initialRows)');
const metadataPass=files.indexOf('const metadataRows=await mapLimit');
assert(immediateList>=0&&metadataPass>immediateList,'printer file names are not rendered before metadata hydration');
assert(files.includes('activeClient.prefersConservativeBackgroundMode()?1:3'),'file metadata concurrency is not reduced for K1C');
assert(files.includes('const backgroundAllowed=!activeClient.prefersK1CCompatibilityMode()'),'K1C can still start a full-library automatic G-code scan');
assert(!files.includes('[refresh,hydrateCache,canSync,connectionState,'),'file synchronization still restarts on online/degraded oscillation');

assert(production.includes('mapLimit(available,2')&&production.includes('c.prefersConservativeBackgroundMode()?1:2'),'production library refresh is not bounded');
assert(!production.includes('Promise.all(printers.map'),'production library still fans out to every printer at once');
assert(production.includes('if(forceMetadata||!metadata)'),'automatic production refresh does not reuse cached metadata');

console.log('runtime stability OK: sticky K1C transport, unified live jobs and priority-bounded file/background work');
