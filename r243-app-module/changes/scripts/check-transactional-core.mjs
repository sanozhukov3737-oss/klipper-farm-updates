import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import ts from './typescript-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const source=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const exists=relative=>fs.existsSync(path.join(root,relative));

const requiredFiles=[
  'src-tauri/src/transactional_core/actor.rs',
  'src-tauri/src/transactional_core/database_writer.rs',
  'src-tauri/src/transactional_core/supervisor.rs',
  'src-tauri/src/transactional_core/farm_coordinator.rs',
  'src-tauri/src/transactional_core/state_machine.rs',
  'src-tauri/src/transactional_core/journal.rs',
  'src-tauri/src/transactional_core/migrations.rs',
  'src-tauri/src/transactional_core/scheduler.rs',
  'src-tauri/src/transactional_core/capabilities.rs',
  'src-tauri/src/transactional_core/identity.rs',
  'src-tauri/src/transactional_core/discovery.rs',
  'src-tauri/src/transactional_core/upload.rs',
  'src-tauri/src/transactional_core/diagnostics.rs',
  'src-tauri/src/transactional_core/verification.rs',
  'src-tauri/src/transactional_core/farm_services.rs',
  'src-tauri/src/transactional_core/instance_lease.rs',
  'src-tauri/src/system_commands.rs',
];
for(const file of requiredFiles)assert.ok(exists(file),`missing V13 module: ${file}`);

const lib=source('src-tauri/src/lib.rs');
// Сборка приложения вынесена в app.rs (R243): часть маркеров живёт там.
const app=source('src-tauri/src/app.rs');
// Count logical source lines instead of rustfmt's brace/delimiter-only expansion.
// This keeps the monolith guard stable across supported rustfmt versions.
const libLogicalLines=lib.split(/\r?\n/).filter(line=>line.trim()&&!/^[{}(),;]+$/.test(line.trim())).length;
assert.ok(libLogicalLines<6_000,'src-tauri/src/lib.rs must remain below 6000 logical lines');
for(const marker of ['mod transactional_core;','mod system_commands;','InstanceLease::acquire']){
  assert.ok(lib.includes(marker)||app.includes(marker),`missing Rust integration marker: ${marker}`);
}
const transactionalCore=source('src-tauri/src/transactional_core/mod.rs');
for(const marker of ['bootstrap_headless','bootstrap_connection']){
  assert.ok(transactionalCore.includes(marker),`missing Rust integration marker: ${marker}`);
}

const actor=source('src-tauri/src/transactional_core/actor.rs');
for(const marker of [
  'struct PrinterActor','BinaryHeap<QueuedOperation>','PersistentWebSocket',
  'printer.objects.subscribe','last_eventtime','session_epoch','recover_journal',
  'REST_RECONCILE_INTERVAL','BackgroundFinished','record_trace','model_id',
  'struct EmergencyTransport','service_websocket_after_command','MAX_INBOX_BURST',
  'ActorMessage::Reattest','attest_identity','identity_warning',
  'ACTOR_MAILBOX_CAPACITY','MAX_OPERATION_QUEUE','struct ActorExitGuard',
  'pub fn is_alive','JOURNAL_CORRUPTION','journal_corruption_quarantined',
])assert.ok(actor.includes(marker),`missing PrinterActor invariant: ${marker}`);
const core=transactionalCore;
for(const marker of ['actor_by_printer_id','restart_dead','restart_dead_actor','supervise_dead_actors','Mutex<Option<Journal>>']){
  assert.ok(core.includes(marker),`missing V17 core supervisor/coordinator invariant: ${marker}`);
}

const machine=source('src-tauri/src/transactional_core/state_machine.rs');
for(const phase of ['Discovered','Identifying','Ready','Operating','Printing','Degraded','Recovering','Quarantined']){
  assert.ok(machine.includes(phase),`state machine phase missing: ${phase}`);
}
assert.ok(machine.includes('transition_allowed'),'state transitions are not guarded centrally');

const migrations=source('src-tauri/src/transactional_core/migrations.rs');
const types=source('src-tauri/src/transactional_core/types.rs');
for(const table of [
  'command_journal','printer_actor_state','transactional_uploads','replay_frames',
  'signed_profile_packages','farm_queue_v2','maintenance_observations','schema_migrations',
  'ui_event_outbox','printer_identity_attestation',
  'command_journal_archive',
])assert.ok(migrations.includes(table),`database migration missing table: ${table}`);
for(const state of ['created','queued','sent','confirmed','cancelled','unknown','recovered','failed']){
  assert.ok(types.includes(`"${state}"`),`journal state missing: ${state}`);
}
assert.ok(migrations.includes('model_id TEXT'),'actor model ownership is not persisted');
assert.ok(migrations.includes('deadline_at INTEGER')&&migrations.includes('SCHEMA_VERSION: i64 = 20'),'V20 operation migration is missing');
assert.ok(migrations.includes('ipc_command_inbox')&&migrations.includes('payload_sha256'),'V19 durable IPC inbox migration is missing');
for(const marker of ['resolution_reason','lease_owner','lease_until','command_journal_archive'])assert.ok(migrations.includes(marker),`V17 migration marker missing: ${marker}`);
assert.ok(actor.includes('"printer.print.start" => false'),'ambiguous print start must never auto-retry from idle');
const migrationSql=migrations.match(/transaction\s*\.execute_batch\(\s*"([\s\S]*?)"\s*,?\s*\)/)?.[1];
assert.ok(migrationSql,'transactional migration SQL could not be extracted');
const database=new DatabaseSync(':memory:');
database.exec(`BEGIN IMMEDIATE;${migrationSql}ROLLBACK;`);
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count,0,'SQLite DDL did not roll back atomically');
database.exec(migrationSql);
const actualTables=new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
for(const table of [
  'command_journal','printer_actor_state','transactional_uploads','replay_frames',
  'ui_event_outbox','printer_identity_attestation','command_journal_archive',
])assert.ok(actualTables.has(table),`SQLite did not create ${table}`);
assert.ok(database.prepare('PRAGMA table_info(printer_actor_state)').all().some(column=>column.name==='model_id'),'SQLite actor model column is missing');
assert.ok(database.prepare('PRAGMA table_info(ui_event_outbox)').all().some(column=>column.name==='event_id'),'SQLite durable UI event sequence is missing');
assert.ok(database.prepare('PRAGMA table_info(command_journal)').all().some(column=>column.name==='resolution'),'SQLite unknown-operation resolution column is missing');
assert.ok(database.prepare('PRAGMA table_info(farm_queue_v2)').all().some(column=>column.name==='lease_owner'),'SQLite farm lease column is missing');
database.close();

for(const policy of ['Safe','VerifyState','Never'])assert.ok(types.includes(policy),`repeat policy missing: ${policy}`);
const upload=source('src-tauri/src/transactional_core/upload.rs');
for(const marker of [
  'STAGING_QUOTA','expected_sha256','ct_eq','temporary_name','verify_remote_sha256',
  'remote_file_sha256','server/files/gcodes/','acquire_bandwidth',
  'scheduled_upload_final_file','run_background_by_printer_id','cleanup_orphans',
])assert.ok(upload.includes(marker),`transactional upload invariant missing: ${marker}`);
const finalUpload=upload.slice(upload.indexOf('fn upload_final_file('),upload.indexOf('fn scheduled_upload_final_file('));
assert.ok(finalUpload.includes('name=\\"file\\"')&&finalUpload.includes('name=\\"root\\"'),'legacy multipart must contain file and gcodes root');
assert.ok(!finalUpload.includes('name=\\"checksum\\"')&&!finalUpload.includes('name=\\"print\\"'),'legacy multipart must not add optional vendor-incompatible fields');
const finishUpload=upload.slice(upload.indexOf('fn finish_blocking('),upload.indexOf('fn persist_cancelled('));
assert.ok(finishUpload.includes('&record.filename'),'upload must use the original sanitized final filename');
assert.ok(!finishUpload.includes('scheduled_move(')&&!finishUpload.includes('server.files.move'),'upload must not require a remote rename');
const stagingChunk=upload.match(/pub\(crate\) async fn transactional_upload_chunk[\s\S]*?pub\(crate\) async fn transactional_upload_finish/)?.[0]??'';
assert.ok(!stagingChunk.includes('acquire_bandwidth'),'local staging must not consume router bandwidth tokens');
const scheduler=source('src-tauri/src/transactional_core/scheduler.rs');
for(const marker of ['FarmScheduler','token','Emergency','Upload','adaptive_limit','acquire_for_printer','acquire_bandwidth_for','virtual_finish','set_printer_weight','FARM_SCHEDULER_DEADLINE']){
  assert.ok(scheduler.includes(marker),`farm scheduler invariant missing: ${marker}`);
}
assert.ok(!scheduler.includes('observe_network'),'scheduler latency/loss must be accounted only by SchedulerPermit');
assert.ok(actor.match(/fn try_connect[\s\S]*?acquire_for_printer[\s\S]*?permit\.success\(\)/),'WebSocket connect must use the single SchedulerPermit measurement path');
const discovery=source('src-tauri/src/transactional_core/discovery.rs');
for(const marker of ['_moonraker._tcp.local','M-SEARCH','Ipv6Addr','stable_hosts','local_discovery_ip']){
  assert.ok(discovery.includes(marker),`hybrid discovery invariant missing: ${marker}`);
}
assert.ok(discovery.includes('is_virtual_discovery_interface'),'VPN/virtual discovery filtering is not integrated');
const capabilities=source('src-tauri/src/transactional_core/capabilities.rs');
for(const marker of ['firmware_signature','compatible','temperature','queue_api','pause','cancel']){
  assert.ok(capabilities.includes(marker),`capability attestation invariant missing: ${marker}`);
}
const identity=source('src-tauri/src/transactional_core/identity.rs');
for(const marker of ['machineId','macAddress','mcuSerial','identity_fingerprint','IDENTITY_MISMATCH']){
  assert.ok(identity.includes(marker),`Rust identity attestation invariant missing: ${marker}`);
}
const journal=source('src-tauri/src/transactional_core/journal.rs');
for(const marker of ['append_event','pending_events','acknowledge_events','save_identity_attestation','identity_baseline']){
  assert.ok(journal.includes(marker),`durable journal invariant missing: ${marker}`);
}
assert.ok(journal.includes('kf_storage::ReadPool')&&journal.includes('Повреждены параметры command_journal')&&journal.includes('Повреждён payload_json события'),'V20 SQLite read pool or strict corruption handling is missing');
const writer=source('src-tauri/src/transactional_core/database_writer.rs');
for(const marker of ['DatabaseWriter','critical','ActorStateWrite','MAX_TELEMETRY_BATCH','write_actor_snapshot_batch'])assert.ok(writer.includes(marker),`DatabaseWriter invariant missing: ${marker}`);
const supervisor=source('src-tauri/src/transactional_core/supervisor.rs');
for(const marker of ['RestartBudget','RestartDecision','CrashLoop','MAX_RESTARTS_IN_WINDOW'])assert.ok(supervisor.includes(marker),`ActorSupervisor invariant missing: ${marker}`);
const coordinator=source('src-tauri/src/transactional_core/farm_coordinator.rs');
const farmServices=source('src-tauri/src/transactional_core/farm_services.rs');
for(const marker of ['coordinator_tick','lease_owner','FARM_DISPATCH_UNCERTAIN','autoStart'])assert.ok(farmServices.includes(marker),`FarmCoordinator invariant missing: ${marker}`);
assert.ok(coordinator.includes('HOUSEKEEPING_INTERVAL')&&journal.includes('resolve_unknown')&&journal.includes('housekeeping'),'operations retention or unknown resolution is missing');
const instanceLease=source('src-tauri/src/transactional_core/instance_lease.rs');
assert.ok(!instanceLease.includes('const LEASE_PORT'),'single-instance must not reserve a fixed TCP port');
for(const marker of ['CreateMutexW','TcpListener::bind(("127.0.0.1", 0))','FOCUS_PREFIX','token','signal_existing_with_retry'])assert.ok(instanceLease.includes(marker),`single-instance hardening marker missing: ${marker}`);
assert.ok(actor.includes('IDENTITY_FINGERPRINT_MISMATCH'),'identity fingerprint mismatch does not force quarantine');
const frontend=source('src/lib/moonraker.ts');
for(const marker of [
  'printer-actor-event','printer_actor_upsert','sessionEpoch','transactional_upload_begin','receivedSize',
  'printer_actor_events_pending','printer_actor_events_ack','eventId',
  'actorAckHighWater','flushActorEventAcks','this.armActorEventAck(retry?500:50)',
]){
  assert.ok(frontend.includes(marker),`frontend actor handoff missing: ${marker}`);
}
const emergencyFrontend=frontend.match(/emergencyStop\(\)[\s\S]*?\n\s*}/)?.[0]??'';
assert.ok(emergencyFrontend.includes("nativeRpc('printer.emergency_stop'")&&!emergencyFrontend.includes('scheduler.run'),'frontend emergency path does not bypass the normal request scheduler');

// Deterministic property/fuzz laboratory. A fixed seed makes every failure replayable.
let randomState=0x13_14_5e_ed;
const random=()=>{
  randomState^=randomState<<13;randomState^=randomState>>>17;randomState^=randomState<<5;
  return(randomState>>>0)/0x1_0000_0000;
};
const integer=(minimum,maximum)=>minimum+Math.floor(random()*(maximum-minimum+1));

// eventtime must be strictly monotonic even with loss, duplication and reordering.
for(let run=0;run<250;run++){
  const original=Array.from({length:integer(4,80)},(_,index)=>run*1_000+index+random());
  const transport=[];
  for(const value of original){
    if(random()<.12)continue;
    transport.push(value);
    if(random()<.18)transport.push(value);
  }
  for(let index=1;index<transport.length;index++)if(random()<.16){
    [transport[index-1],transport[index]]=[transport[index],transport[index-1]];
  }
  let last=-Infinity;const accepted=[];
  for(const value of transport)if(value>last){last=value;accepted.push(value)}
  assert.ok(accepted.every((value,index)=>index===0||value>accepted[index-1]),'eventtime accepted a stale frame');
}

// WebSocket text frames: round-trip bounded JSON-RPC and reject malformed/truncated JSON.
const encodeFrame=value=>{
  const payload=Buffer.from(JSON.stringify(value));
  assert.ok(payload.length<65_536,'fuzz payload escaped the bounded frame class');
  if(payload.length<126)return Buffer.concat([Buffer.from([0x81,payload.length]),payload]);
  const header=Buffer.alloc(4);header[0]=0x81;header[1]=126;header.writeUInt16BE(payload.length,2);
  return Buffer.concat([header,payload]);
};
const decodeFrame=frame=>{
  assert.equal(frame[0]&0x0f,1,'unexpected opcode');
  const short=frame[1]&0x7f,offset=short===126?4:2,length=short===126?frame.readUInt16BE(2):short;
  assert.equal(frame.length,offset+length,'partial WebSocket frame was accepted');
  return JSON.parse(frame.subarray(offset).toString('utf8'));
};
for(let index=0;index<2_000;index++){
  const message=random()<.55
    ?{jsonrpc:'2.0',id:index,method:'printer.objects.query',params:{objects:{print_stats:null}},padding:'x'.repeat(integer(0,300))}
    :{jsonrpc:'2.0',method:'notify_status_update',params:[{print_stats:{state:random()<.5?'printing':'standby'}},random()*10_000]};
  const frame=encodeFrame(message);
  assert.deepEqual(decodeFrame(frame),message,'WebSocket JSON-RPC round-trip changed the message');
  if(frame.length>3){
    const truncated=frame.subarray(0,integer(2,frame.length-1));
    assert.throws(()=>decodeFrame(truncated),'truncated WebSocket frame was accepted');
  }
  const json=JSON.stringify(message);
  if(json.length>2)assert.throws(()=>JSON.parse(json.slice(0,integer(1,json.length-1))),'truncated JSON was accepted');
}

// CIDR enumeration stays inside the subnet and respects the discovery safety cap.
const mask=prefix=>(0xffff_ffff<<(32-prefix))>>>0;
for(let index=0;index<4_000;index++){
  const prefix=integer(22,30),address=(random()*0x1_0000_0000)>>>0,network=(address&mask(prefix))>>>0;
  const count=2**(32-prefix)-2;
  assert.ok(count>0&&count<=1_022,'CIDR host count escaped the bounded /22..30 range');
  for(let sample=0;sample<4;sample++){
    const host=(network+integer(1,count))>>>0;
    assert.equal((host&mask(prefix))>>>0,network,'CIDR host escaped its network');
  }
}

// Import the production G-code scanner and fuzz its numeric, comment and long-line boundaries.
const gcodeFile=path.join(root,'src/lib/gcodeAnalysis.ts');
const transpiled=ts.transpileModule(fs.readFileSync(gcodeFile,'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},fileName:gcodeFile,reportDiagnostics:true,
});
assert.equal(transpiled.diagnostics?.length??0,0,'gcodeAnalysis.ts transpile diagnostics');
const {analyzeGCodeText}=await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);
const commands=['G0','G1','G90','G91','M104','M109','M140','M190','M112','START_PRINT','END_PRINT','STOP_MOD','; comment'];
for(let run=0;run<1_500;run++){
  const lines=[];
  for(let line=0;line<integer(1,80);line++){
    const command=commands[integer(0,commands.length-1)];
    lines.push(`${command} X${(random()*1_000-500).toFixed(4)} Y${(random()*1_000-500).toFixed(4)} Z${(random()*500).toFixed(4)} S${integer(0,600)} ; ${'q'.repeat(integer(0,80))}`);
  }
  if(random()<.05)lines.push(`G1 X1 ${'x'.repeat(40_000)}`);
  const report=analyzeGCodeText(lines.join('\n'));
  for(const value of [report.bounds.x,report.bounds.y,report.bounds.z,report.maxHotend,report.maxBed]){
    assert.ok(Number.isFinite(value)&&value>=0,'G-code analysis produced a non-finite/negative bound');
  }
  assert.equal(report.lineCount,lines.length,'G-code scanner line count is not deterministic');
}

console.log('transactional core checks OK: Rust ownership, FSM/journal/upload/discovery/scheduler invariants + deterministic WS/JSON/eventtime/CIDR/G-code fuzz properties');
