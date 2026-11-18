import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from './typescript-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const source=read('src/lib/moonrakerPayload.ts');
const compiled=ts.transpileModule(source,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},
  fileName:'src/lib/moonrakerPayload.ts',
  reportDiagnostics:true,
});
assert.equal(compiled.diagnostics?.length??0,0,'Moonraker payload normalizer transpile diagnostics');
const payload=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

assert.deepEqual(
  payload.moonrakerObjectNames({result:{data:{objects:['extruder','heater_bed',7]}}}),
  ['extruder','heater_bed'],
  'wrapped Creality object catalogue was not normalized',
);
assert.deepEqual(
  payload.moonrakerStatus({result:{result:{status:{extruder:{temperature:'24.5'},heater_bed:{temperature:23}}}}}),
  {extruder:{temperature:'24.5'},heater_bed:{temperature:23}},
  'wrapped telemetry status was not normalized',
);
const cyclic={};cyclic.result=cyclic;
assert.deepEqual(payload.moonrakerStatus(cyclic),{},'cyclic payload must terminate safely');

const client=read('src/lib/moonraker.ts');
const rust=`${read('src-tauri/src/lib.rs')}\n${read('src-tauri/src/discovery_commands.rs')}\n${read('src-tauri/src/moonraker_protocol.rs')}`;
const card=read('src/components/PrinterCard.tsx');
assert(client.includes("await this.rpc('printer.print.start',{filename:path})")&&!client.includes("script:`${stockMacro}"),'Forge-X desktop launch must use Moonraker directly, never the Stock Screen macro');
assert(client.includes('acquireConservativeIo')&&client.includes('runControlRequest')&&client.includes('runFileTransfer')&&client.includes('resourceQuietUntil')&&client.includes('this.prefersConservativeBackgroundMode()?1:4'),'Forge-X low-resource request serialization is incomplete');
assert(client.includes('prefersK1CCompatibilityMode')&&client.includes('queryK1CCoreStatus')&&client.includes("type K1CTransport={protocol:'websocket'|'rest'|'jsonrpc'")&&client.includes('refreshK1CExtendedTelemetry'),'adaptive K1C core/optional telemetry path is missing');
assert(client.includes('print_stats:null')&&client.includes('virtual_sdcard:null')&&client.includes("new MoonrakerChannelHealth({protocol:'websocket',port:port===7125?7125:80})")&&client.includes('this.channelHealth.recordSuccess'),'K1C job snapshot does not use the sticky confirmed WebSocket/default-port route');
assert(client.includes('moonraker_ws_rpc')&&client.includes('k1cTransportCandidates')&&client.includes('configured===80?[80,7125]:configured===7125?[7125,80]:[80,7125]')&&client.includes('moonrakerHostForPort'),'K1C WebSocket port 80/7125 compatibility path is missing');
assert(client.includes("if(probes.every(item=>item.status==='rejected'))")&&/server=moonrakerRecord\(await this\.nativeWsRpc\('server\.info'/.test(client),'setup/model detection cannot recover through the restored K1C WebSocket route');
assert(rust.includes('should_try_query_compatibility_fallback')&&rust.includes('moonraker_query_result_useful')&&rust.includes('bounded_rpc_timeout')&&rust.includes('prefer_rest: Option<bool>'),'Creality preferred REST/legacy compatibility fallback is missing');
assert(rust.includes('async fn moonraker_ws_rpc')&&rust.includes('websocket_rpc_blocking')&&(rust.includes('GET /websocket HTTP/1.1')||(rust.includes('websocket_handshake_path_bound(target, api_key, timeout, bind_ip, "/websocket", None)')&&rust.includes('GET {path} HTTP/1.1')))&&rust.includes('default_port: Option<u16>'),'native K1C WebSocket/default-port transport is missing');
assert(rust.includes('DiscoveryTarget')&&rust.includes('[7125_u16, 80_u16]')&&rust.includes('discovered_printer_from_payload'),'native LAN discovery does not probe and preserve both K1C ports');
assert(/if prefer_rest \{[\s\S]*?return Ok\(result\);\s*\}\s*let mut request/.test(rust),'preferred K1C REST mode must not cascade into a second JSON-RPC timeout');
assert(client.includes('remoteControlSuspended')&&client.includes('STOP_MOD'),'planned Forge-X Moonraker suspension is not represented');
assert(client.includes("secureInvoke<NativeUploadBegin>('transactional_upload_begin'")&&client.includes("secureInvoke<number>('transactional_upload_chunk'")&&client.includes('file.slice(offset,end).arrayBuffer()')&&!client.includes('await file.arrayBuffer()'),'large Moonraker upload is not streamed transactionally in bounded chunks');
assert(card.includes('<FleetPrinterCard')&&read('src/components/FleetPrinterCard.tsx').includes('compactTelemetryLabel')&&!card.includes("online?'MOONRAKER'"),'oversized service state returned to printer card');

// Ответ Moonraker читается только после проверки формы. Раньше это скрывалось
// за any: spoolmanSpools обращался к r.error.message, и строковая ошибка давала
// «Spoolman error» без причины, а объект без message — падение.
{
  const tool = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(read('src/lib/moonrakerPayload.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},fileName:'src/lib/moonrakerPayload.ts'}).outputText).toString('base64')}`);
  // Формы, которые может получить lightPayload: вложенные ответы и мусор.
  // error лежит на уровне result, а moonrakerRecord вернул бы лист — поэтому
  // обход идёт по всем уровням.
  const levels = tool.payloadRecords({result:{error:{message:'нет связи'}}});
  assert.ok(levels.some(level=>level.error), 'вложенная ошибка не находится на уровне result');
  const deep = tool.payloadRecords({result:{data:{response:[1,2]}}});
  assert.deepEqual(deep.map(level=>level.response).find(v=>v!==undefined), [1,2], 'response не находится на вложенном уровне');
  // Для мусора возвращается пустой объект, а не выдуманное значение и не падение.
  assert.deepEqual(tool.moonrakerRecord('строка'), {}, 'строка не должна давать поля');
  assert.deepEqual(tool.moonrakerRecord(null), {}, 'null не должен давать поля');
  assert.deepEqual(tool.moonrakerObjectNames({result:{objects:null}}), [], 'null-список объектов не должен ронять разбор');
}

// Контракт запуска печати: start возвращает ответ RPC, а не void. Типы
// говорили void, и any скрывал расхождение с реальным значением.
assert(/async start\(filename:string,options:PrintStartOptions=\{\}\):Promise<unknown>/.test(client),'print start must declare the RPC response it returns');
assert(!/async start\(filename:string,options:PrintStartOptions=\{\}\)\s*\{/.test(client),'print start returned to an implicit any return');

// Spoolman: ошибка читается как объект или строка, но всегда после проверки.
assert(/const levels=payloadRecords\(await this\.runBackgroundRequest/.test(client),'spoolman response is not normalized before use');
assert(!/r\?\.error\.message/.test(client),'spoolman error is read without shape check');

console.log('Moonraker compatibility OK: native K1C WebSocket 80/7125 failover, bounded telemetry and direct low-resource Forge-X launch');
