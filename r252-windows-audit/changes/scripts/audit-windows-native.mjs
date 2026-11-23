#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const rustFiles=[];
const walk=directory=>{
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const absolute=path.join(directory,entry.name);
    if(entry.isDirectory())walk(absolute);
    else if(entry.isFile()&&entry.name.endsWith('.rs'))rustFiles.push(absolute);
  }
};
walk(path.join(root,'src-tauri','src'));
walk(path.join(root,'src-tauri','crates'));
rustFiles.sort();
assert.ok(rustFiles.length>=40,'Rust source inventory is unexpectedly incomplete');

let syncSites=0;
for(const file of rustFiles){
  const source=fs.readFileSync(file,'utf8');
  const relative=path.relative(root,file).split(path.sep).join('/');
  assert.ok(!/\.and_then\(\|file\|\s*file\.sync_all\(\)\)/s.test(source),`${relative}: read-only Windows fsync regression returned`);
  syncSites+=(source.match(/\.sync_all\(\)/g)??[]).length;
}

const durable=read('src-tauri/src/transactional_core/durable_fs.rs');
for(const marker of ['.read(true)','.write(true)','rename_atomic','WINDOWS_RENAME_ATTEMPTS','Some(5) | Some(32) | Some(33)','existing_file_is_flushed_without_truncation','atomic_rename_publishes_exact_contents']){
  assert.ok(durable.includes(marker),`durable_fs.rs is missing ${marker}`);
}
assert.ok(durable.indexOf('.write(true)')<durable.indexOf('sync_all()'),'durable fsync handle is not write-capable');
assert.ok(!durable.includes('.truncate(true)')&&!durable.includes('.create(true)'),'durable fsync helper can mutate an existing file');

for(const relative of ['src-tauri/src/transactional_core/backup.rs','src-tauri/src/transactional_core/migrations.rs']){
  const source=read(relative);
  for(const marker of ['durable_fs::sync_file','durable_fs::rename_atomic','.close()'])assert.ok(source.includes(marker),`${relative} is missing ${marker}`);
}
const backup=read('src-tauri/src/transactional_core/backup.rs');
assert.ok(backup.indexOf('.close()')<backup.indexOf('durable_fs::sync_file(&partial_path)'),'backup file can be flushed before SQLite closes it');
const migrations=read('src-tauri/src/transactional_core/migrations.rs');
assert.ok(migrations.indexOf('.close()')<migrations.indexOf('durable_fs::sync_file(&partial)'),'migration backup can be flushed before SQLite closes it');

// The ACL path lives in permissions.rs (r234) and the desktop launch assembly in app.rs (r243);
// both used to sit in lib.rs. Concatenating all three keeps the ordering assertions below valid,
// since InstanceLease::acquire, tauri::Builder::default and app.manage(lease) all live in app.rs.
const assembly=`${read('src-tauri/src/lib.rs')}\n${read('src-tauri/src/permissions.rs')}\n${read('src-tauri/src/app.rs')}`;
for(const marker of ['whoami.exe','/user','parse_windows_sid','format!("*{sid}")','*S-1-5-18','windowless_windows_command','CREATE_NO_WINDOW'])assert.ok(assembly.includes(marker),`Windows ACL path is missing ${marker}`);
assert.ok(!assembly.includes('std::env::var("USERNAME")')&&!assembly.includes('std::env::var("USERDOMAIN")'),'Windows ACL trusts locale/account-name environment variables');
for(const marker of ['window.show()','window.is_visible()','EngineClient::initialize_background','DesktopSmoke::from_process_args','DESKTOP_WINDOW_READY_TIMEOUT','app.manage(lease)'])assert.ok(assembly.includes(marker),`desktop startup recovery is missing ${marker}`);
assert.ok(assembly.indexOf('InstanceLease::acquire()')<assembly.indexOf('tauri::Builder::default()'),'a duplicate launch can create a second WebView before deciding instance ownership');
assert.ok(assembly.includes('run_desktop(smoke, lease)'),'the pre-window instance lease is not passed to Tauri setup');
assert.ok(!/\.manage\(lease\)[\s\S]*?\.setup\(/.test(assembly),'desktop lease returned to the pre-window Tauri builder chain');
const desktopStartup=read('src-tauri/src/desktop_startup.rs');
for(const marker of ['--desktop-startup-smoke','DESKTOP_BINARY_IDENTITY_MISMATCH','DESKTOP_WINDOW_READY','desktop-startup.log','MessageBoxW','create_new(true)'])assert.ok(desktopStartup.includes(marker),`desktop startup diagnostics are missing ${marker}`);
const engineClient=read('src-tauri/src/engine_client.rs');
for(const marker of ['initialize_background','CREATE_NO_WINDOW','HEADLESS_ENGINE_START_FAILED','STARTUP_ATTEMPTS'])assert.ok(engineClient.includes(marker),`background engine launch is missing ${marker}`);
const engineLease=read('src-tauri/src/transactional_core/engine_lease.rs');
for(const marker of ['PRODUCTION_MUTEX_NAME','TEST_MUTEX_PREFIX','platform::acquire(&file, &path)','fs::canonicalize(path)','test-isolated'])assert.ok(engineLease.includes(marker),`Windows engine lease test isolation is missing ${marker}`);
assert.ok(engineLease.includes('#[cfg(not(test))]')&&engineLease.includes('#[cfg(test)]'),'production and test engine mutex namespaces are not compile-time separated');
const instanceLease=read('src-tauri/src/transactional_core/instance_lease.rs');
for(const marker of ['FOCUS_ACK','INSTANCE_RUNNING_WITHOUT_READY_WINDOW','read_focus_ack','write_all(FOCUS_ACK)','signal_existing_until_ready','run_on_main_thread','FOCUS_READY_TIMEOUT','owner_present','AllowSetForegroundWindow','hello_busy.load'])assert.ok(instanceLease.includes(marker),`desktop focus readiness handshake is missing ${marker}`);
const daemonMain=read('src-tauri/src/bin/klipper-farmd.rs');
assert.ok(daemonMain.includes('windows_subsystem = "windows"'),'klipper-farmd would open a visible Windows console');
const ipcProbeMain=read('src-tauri/src/bin/klipper-farm-ipc-probe.rs');
assert.ok(ipcProbeMain.includes('run_ipc_probe_from_args(std::env::args_os())'),'native Windows IPC probe bypasses the production AF_UNIX client path');
const tauriConfig=JSON.parse(read('src-tauri/tauri.conf.json'));
assert.equal(tauriConfig.bundle.windows.nsis.installerHooks,'windows/installer-hooks.nsh','NSIS upgrade does not install the process-stop hook');
for(const relative of ['src-tauri/tauri.conf.json','src-tauri/tauri.offline.conf.json','src-tauri/tauri.release.conf.json'])assert.equal(JSON.parse(read(relative)).mainBinaryName,'klipper-farm-client',`${relative} does not pin the GUI main binary`);
const cargoManifest=read('src-tauri/Cargo.toml');
for(const marker of ['default-run="klipper-farm-client"','name="klipper-farm-client"','path="src/main.rs"','name="klipper-farmd"','path="src/bin/klipper-farmd.rs"','name="klipper-farm-ipc-probe"','path="src/bin/klipper-farm-ipc-probe.rs"'])assert.ok(cargoManifest.includes(marker),`Cargo binary identity is missing ${marker}`);
const installerHooks=read('src-tauri/windows/installer-hooks.nsh');
for(const marker of ['NSIS_HOOK_PREINSTALL','NSIS_HOOK_POSTINSTALL','NSIS_HOOK_PREUNINSTALL','klipper-farmd.exe','klipper-farm-client.exe','taskkill.exe','WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"','CreateShortcut "$SMPROGRAMS\\${PRODUCTNAME}.lnk" "$INSTDIR\\${MAINBINARYNAME}.exe"'])assert.ok(installerHooks.includes(marker),`NSIS process/shortcut recovery hook is missing ${marker}`);
const libTests=read('src-tauri/src/lib_tests.rs');
assert.ok(libTests.includes('windows_sid_parser_accepts_unicode_account_names_without_trusting_them'),'Unicode Windows account/SID regression test is missing');

for(const relative of ['src-tauri/src/transactional_core/backup.rs','src-tauri/src/transactional_core/database_writer.rs','src-tauri/src/transactional_core/journal.rs','src-tauri/src/transactional_core/workflow.rs']){
  assert.ok(read(relative).includes('drop('),`${relative} does not close Windows test handles before cleanup`);
}

const runner=read('scripts/run-rust-tests.mjs');
for(const marker of ["['clean','-p','klipper-farm-client'","MIN_ROOT_TEST_COUNT=process.platform==='win32'?129:127",'--list','--test-threads=1','check-windows-test-loader.mjs','RELEASE-BUILD-ID.txt'])assert.ok(runner.includes(marker),`Rust test runner is missing ${marker}`);
const headless=read('src-tauri/src/headless_engine.rs');
for(const marker of ['resolve_socket_path','MAX_SOCKET_PATH_BYTES','LOCALAPPDATA','XDG_RUNTIME_DIR','long_data_directory_uses_a_short_private_socket_path','IPC_SOCKET_PATH_UNAVAILABLE','run_ipc_probe_from_args','call_published_endpoint','ipc_probe_schema_is_strict_and_never_accepts_a_caller_token','retire_stale_endpoint_after_lease','crash_left_endpoint_is_retired_before_rebinding_the_socket','runtime-restart-actor','actorsBootstrapped'])assert.ok(headless.includes(marker),`headless IPC path hardening is missing ${marker}`);
const headlessBootstrap=headless.slice(headless.indexOf('async fn run_server'),headless.indexOf('fn handle_connection'));
assert.ok(headlessBootstrap.indexOf('retire_stale_endpoint_after_lease')<headlessBootstrap.indexOf('LocalListener::bind'),'replacement daemon can self-probe a crash-left endpoint before its accept loop starts');
const launcher=read('FIX_AND_INSTALL.bat');
const installer=read('scripts/build-and-install-windows.mjs');
assert.ok(launcher.includes('scripts\\build-and-install-windows.mjs'),'Windows launcher bypasses the clean orchestrator');
for(const marker of ['RELEASE-BUILD-ID.txt','prepare-windows-build-cache.mjs','check-windows-gui-binaries.mjs','check-desktop-packaging.mjs'])assert.ok(installer.includes(marker),`offline installer is missing ${marker}`);

const peSelfTest=spawnSync(process.execPath,[path.join(root,'scripts','check-windows-gui-binaries.mjs'),'--self-test'],{cwd:root,stdio:'inherit',shell:false});
if(peSelfTest.error)throw peSelfTest.error;
assert.equal(peSelfTest.status,0,'Windows GUI PE parser self-test failed');

const selfTest=spawnSync(process.execPath,[path.join(root,'scripts','prepare-windows-build-cache.mjs'),'--self-test'],{cwd:root,stdio:'inherit',shell:false});
if(selfTest.error)throw selfTest.error;
assert.equal(selfTest.status,0,'Windows build cache self-test failed');
for(const [script,args,label] of [
  ['check-desktop-packaging.mjs',[],'desktop packaging source contract'],
  ['check-desktop-packaging.mjs',['--self-test'],'desktop packaging parser'],
  ['check-desktop-startup-smoke.mjs',['--self-test'],'desktop startup smoke marker'],
]){
  const result=spawnSync(process.execPath,[path.join(root,'scripts',script),...args],{cwd:root,stdio:'inherit',shell:false});
  if(result.error)throw result.error;
  assert.equal(result.status,0,`${label} self-test failed`);
}
console.log(`Windows native audit OK: ${rustFiles.length} Rust files, ${syncSites} durable flush sites, explicit GUI/daemon packaging, startup watchdog, focus ACK and physical smoke gates verified`);
