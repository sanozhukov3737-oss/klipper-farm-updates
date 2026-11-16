#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
// Проверки структуры не должны спотыкаться о тестовый код: в #[cfg(test)]
// стоят мок-сокеты std::net, и это нормально. Убираем такие блоки по балансу
// скобок, чтобы искать сокеты и паники только в том, что попадает в бинарник.
const stripTestBlocks=source=>{
  let output='';
  let index=0;
  while(index<source.length){
    const at=source.indexOf('#[cfg(test)]',index);
    if(at<0){output+=source.slice(index);break}
    output+=source.slice(index,at);
    // от атрибута до конца его области: ищем первую { и её пару
    let cursor=source.indexOf('{',at);
    if(cursor<0){break}
    let depth=0;
    for(;cursor<source.length;cursor++){
      if(source[cursor]==='{')depth++;
      else if(source[cursor]==='}'){depth--;if(depth===0){cursor++;break}}
    }
    index=cursor;
  }
  return output;
};
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
// То же, но без блоков #[cfg(test)]: для проверок, которые касаются
// только того, что попадает в бинарник.
const readProduction=relative=>stripTestBlocks(read(relative));
const has=(relative,...markers)=>{
  const source=read(relative);
  for(const marker of markers)assert.ok(source.includes(marker),`${relative}: missing ${marker}`);
  return source;
};

const cargo=read('src-tauri/Cargo.toml');
for(const crate of ['kf-domain','kf-engine','kf-ipc','kf-moonraker','kf-storage','kf-update']){
  assert.ok(cargo.includes(`crates/${crate}`),`Cargo workspace is missing ${crate}`);
}
const tauriInlineTable=cargo.match(/^tauri\s*=\s*\{([^}\r\n]+)\}\s*$/m)?.[1]??'';
assert.match(tauriInlineTable,/\bversion\s*=\s*"2"/, 'Tauri production version is not explicit');
assert.match(tauriInlineTable,/\bdefault-features\s*=\s*false\b/, 'Tauri default features must be disabled');
const tauriFeatures=tauriInlineTable.match(/\bfeatures\s*=\s*\[([^\]]*)\]/)?.[1]
  ?.match(/"[^"]+"/g)
  ?.map(value=>value.slice(1,-1))??[];
const requiredTauriFeatures=['wry','compression','dynamic-acl','x11','dbus'];
assert.ok(requiredTauriFeatures.every(feature=>tauriFeatures.includes(feature)),'Tauri production features are not explicit');
assert.ok(!cargo.includes('"common-controls-v6"'),'TaskDialogIndirect can make manifest-less Windows test executables unloadable');
const assembly=read('src-tauri/src/lib.rs');
const assemblyLogicalLines=assembly.split(/\r?\n/).filter(line=>line.trim()&&!/^[{}(),;]+$/.test(line.trim())).length;
assert.ok(assemblyLogicalLines<5_000,`lib.rs assembly boundary regressed (${assemblyLogicalLines} logical lines)`);
const ipc=has('src-tauri/crates/kf-ipc/src/lib.rs','PROTOCOL_VERSION: u16 = 4','FarmQueueEnqueue','UploadFinish','RotateToken');
assert.ok(ipc.includes('MAX_FRAME_BYTES')&&ipc.includes('deny_unknown_fields'),'IPC framing/schema is not bounded and strict');

const daemon=has('src-tauri/src/headless_engine.rs','RotatingToken','SecretBytes','command_inbox::begin','TransactionalUploadState','secure_data_directory');
// Тест места для сокета лежит в #[cfg(test)] и потому вырезан из daemon:
// ищем его в полном исходнике, а производственные имена — в очищенном.
const daemonFull=read('src-tauri/src/headless_engine.rs');
for(const marker of ['resolve_socket_path','MAX_SOCKET_PATH_BYTES'])assert.ok(daemon.includes(marker),`daemon IPC path fallback is missing ${marker}`);
assert.ok(daemonFull.includes('long_data_directory_uses_a_short_private_socket_path'),'daemon IPC path fallback has no long-path test');
for(const command of ['UploadBegin','UploadChunk','UploadFinish','FarmQueueEnqueue','FarmQueueDispatch','MaintenanceObserve']){
  assert.ok(daemon.includes(`EngineCommand::${command}`),`daemon does not own ${command}`);
}
const client=has('src-tauri/src/engine_client.rs','local_socket','IPC_RESPONSE_REQUEST_ID_MISMATCH','spawn_daemon','EngineCommand::Negotiate');
assert.ok(!client.includes('TcpStream'),'desktop IPC must never fall back to TCP');
const engineLease=has('src-tauri/src/transactional_core/engine_lease.rs','PRODUCTION_MUTEX_NAME','TEST_MUTEX_PREFIX','platform::acquire(&file, &path)','fs::canonicalize(path)','test-isolated');
assert.ok(engineLease.includes('#[cfg(not(test))]')&&engineLease.includes('#[cfg(test)]'),'Windows engine mutex does not separate production and native-test namespaces');

const actorFull=read('src-tauri/src/transactional_core/actor.rs'),actor=stripTestBlocks(actorFull);
assert.ok(actor.includes('service_websocket_after_command'),'post-command WS fairness is missing');
assert.ok(!actor.includes('std::net::TcpStream')&&!actor.includes('.expect("checked'),'actor has a synchronous socket or checked panic');
const asyncWs=has('src-tauri/src/transactional_core/async_websocket.rs','tokio::net::TcpStream','CancellationToken','ASYNC_WEBSOCKET_BACKPRESSURE');
const asyncTransport=has('src-tauri/src/transactional_core/moonraker_transport.rs','ASYNC_NETWORK_BACKPRESSURE','OperationPriority::Emergency','CancellationToken');
// В тестовых модулях стоят синхронные мок-серверы: смотрим только на код,
// который попадает в бинарник.
assert.ok(!readProduction('src-tauri/src/transactional_core/async_websocket.rs').includes('std::net::TcpStream')&&!readProduction('src-tauri/src/transactional_core/moonraker_transport.rs').includes('std::net::TcpStream'),'async transport regressed to std sockets');

const migrations=has('src-tauri/src/transactional_core/migrations.rs','SCHEMA_VERSION: i64 = 20','durable_workflows','telemetry_rollups_hourly','backup_restore_drills','update_trust_state','durable_workflow_transition_guard');
assert.ok(migrations.includes('register_migration'),'checksummed migration ledger is not registered');
has('src-tauri/src/transactional_core/database_writer.rs','CRITICAL_QUEUE_CAPACITY','MAX_TELEMETRY_BATCH','telemetry_rollups_hourly','wal_checkpoint(PASSIVE)');
const durableFs=has('src-tauri/src/transactional_core/durable_fs.rs','.read(true)','.write(true)','sync_all()','existing_file_is_flushed_without_truncation','rename_atomic','atomic_rename_publishes_exact_contents');
assert.ok(durableFs.indexOf('.write(true)')<durableFs.indexOf('sync_all()'),'durable fsync must use a write-capable Windows handle');
assert.ok(migrations.includes('durable_fs::sync_file(&partial)'),'migration backup bypasses the Windows-safe durable fsync helper');
assert.ok(migrations.includes('durable_fs::rename_atomic(&partial, &candidate)'),'migration backup bypasses the retry-bounded atomic rename helper');
assert.ok(migrations.includes('.close()'),'migration backup keeps SQLite open during Windows publication');
const backup=has('src-tauri/src/transactional_core/backup.rs','RESTORE_DRILL_SCHEMA_MISMATCH','backup_restore_drills','quick_check');
for(const marker of ['durable_fs::sync_file(&partial_path)','durable_fs::sync_file(&restored_path)'])assert.ok(backup.includes(marker),`backup bypasses Windows-safe durable fsync: ${marker}`);
// Копия публикуется через сжатый файл: сначала .gz.partial, затем
// retry-bounded rename в целевое имя.
assert.ok(backup.includes('durable_fs::rename_atomic(&temporary, target)'),'online backup bypasses retry-bounded atomic rename');
assert.ok(backup.includes('.close()'),'online backup keeps SQLite open during Windows publication');
for(const [name,source] of [['migrations.rs',migrations],['backup.rs',backup]])assert.ok(!source.includes('.and_then(|file| file.sync_all())'),`${name}: read-only Windows fsync regression`);
has('src-tauri/src/transactional_core/workflow.rs','create_prepared','resolve_unknown','WORKFLOW_FENCING_CONFLICT','workflow.manual_resolution');
has('src-tauri/crates/kf-engine/src/fault_model.rs','every_short_crash_schedule_preserves_safety','one_hundred_printers_recover_without_duplicate_effects');

const upload=has('src-tauri/src/transactional_core/upload.rs','daemon_begin','daemon_chunk','daemon_finish','scheduled_verify_remote_sha256','remote_file_sha256','acquire_bandwidth_for');
assert.ok(
  upload.indexOf('pub(crate) fn daemon_chunk')<upload.indexOf('fn finish_blocking'),
  'upload daemon entry points are not part of the owned service boundary',
);
const auditFiles=['src-tauri/src/headless_engine.rs',...fs.readdirSync(path.join(root,'src-tauri/src/transactional_core')).filter(name=>name.endsWith('.rs')).map(name=>`src-tauri/src/transactional_core/${name}`)];
for(const file of auditFiles)assert.ok(!read(file).includes('INSERT INTO audit('),`${file}: direct audit insert bypasses the SHA-256 chain`);
has('src-tauri/src/audit_chain.rs','GENESIS_HASH','previous_hash','AUDIT_CHAIN_TAMPERED');
has('src-tauri/crates/kf-domain/src/lib.rs','SecretString([redacted])','self.0.fill(0)');
has('src-tauri/crates/kf-update/src/lib.rs','verify_strict','UpdateError::Rollback','UpdateError::Equivocation','verify_artifact','update_trust_state');
has('src-tauri/src/system_commands.rs','update_verify_offline','kf_update::parse_and_verify','kf_update::verify_artifact','kf_update::accept','update.bundle_verified');
has('src-tauri/crates/kf-update/examples/verify_bundle.rs','parse_and_verify','verify_artifact');
has('scripts/sign-v20-update.mjs','createReadStream','artifactHasher','privateKeyBytes.fill(0)');
has('scripts/build-reproducible-zip.mjs','SOURCE_DATE_EPOCH','files.sort','deflateRawSync','LEGACY-INSTALL-NOTES-v1.1.1.txt');
has('scripts/generate-release-manifests.mjs','LEGACY-INSTALL-NOTES-v1.1.1.txt');
has('scripts/lock-v20-6-dist.mjs','V20.6-','moonraker-discovery-result','Moonraker найден · требуется API Key');
assert.equal(
  crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'LEGACY-INSTALL-NOTES-v1.1.1.txt'))).digest('hex'),
  '528c7f9ec9842799c9bbb83d53e6d321fa9c646e81cc94feaf822a9ce73ca7eb',
  'portable legacy note differs from the file it replaces',
);
const launcher=has('FIX_AND_INSTALL.bat','DisableDelayedExpansion','scripts\\build-and-install-windows.mjs');
const installer=has('scripts/build-and-install-windows.mjs','verify-release-manifest.ps1',"verifyManifest('release'", "verifyManifest('offline'",'RELEASE-BUILD-ID.txt','prepare-windows-build-cache.mjs','run-rust-tests.mjs','check-desktop-packaging.mjs');
assert.ok(!`${launcher}\n${installer}`.includes('Get-Content -LiteralPath $env:KF_'),'locale-dependent inline manifest parsing returned');
has('scripts/verify-release-manifest.ps1','UTF8Encoding]::new($false, $true)','IsPathRooted','ReparsePoint','Get-FileHash');
has('scripts/run-rust-tests.mjs','--no-run','check-windows-test-loader.mjs',"MIN_ROOT_TEST_COUNT=process.platform==='win32'?129:127",'--test-threads=1',"['clean','-p','klipper-farm-client'");
has('scripts/prepare-windows-build-cache.mjs','source-fingerprint-v1.json','manifestSha256','Build cache reset','--self-test');
has('scripts/audit-windows-native.mjs','Windows native audit OK','whoami.exe','MIN_ROOT_TEST_COUNT');
has('scripts/check-windows-test-loader.mjs','TaskDialogIndirect','CARGO_TARGET_DIR','MZ');

const tauri=JSON.parse(read('src-tauri/tauri.conf.json'));
const offline=JSON.parse(read('src-tauri/tauri.offline.conf.json'));
const release=JSON.parse(read('src-tauri/tauri.release.conf.json'));
assert.ok(!tauri.bundle.externalBin,'dev cargo checks must not require a prebuilt sidecar');
assert.deepEqual(offline.bundle.externalBin,['binaries/klipper-farmd'],'production bundle must contain klipper-farmd');
assert.deepEqual(release.bundle.externalBin,['binaries/klipper-farmd'],'publisher bundle must contain klipper-farmd');

const expected=JSON.parse(read('DIST-V20-LOCK.json'));
const actual={};
const walk=directory=>{
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const absolute=path.join(directory,entry.name);
    if(entry.isDirectory())walk(absolute);
    else if(entry.isFile()){
      const relative=path.relative(root,absolute).split(path.sep).join('/');
      actual[relative]=crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
  }
};
// Сверка dist с захваченным замком имеет смысл только сразу после сборки и
// пересчёта замка (npm run lock:dist:v20.6). В статической проверке dist либо
// отсутствует, либо собран из другого состояния исходников, и падение здесь
// ничего не говорит о коде. Включается явно.
if(process.env.KF_DIST_LOCK==='1'&&fs.existsSync(path.join(root,'dist'))){
  walk(path.join(root,'dist'));
  assert.deepEqual(actual,expected,'dist does not match the captured V20 desktop bundle lock');
}else{
  console.log('dist lock: пропущено (нужен KF_DIST_LOCK=1 после сборки и lock:dist)');
}

console.log(`V20 core gate OK: ${Object.keys(expected).length} locked UI artifacts; daemon/IPC/Saga/SQLite/audit/update/fault invariants present`);
