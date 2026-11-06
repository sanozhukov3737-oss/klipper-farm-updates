#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const actor=read('src-tauri/src/transactional_core/actor.rs');
const headless=read('src-tauri/src/headless_engine.rs');
const client=read('src-tauri/src/engine_client.rs');

assert.match(
  read('RELEASE-BUILD-ID.txt').trim(),
  /^V20\.6-R/,
  'FIX3.9 nonblocking snapshot is not carried by the current build',
);

const snapshot=actor.slice(
  actor.indexOf('pub fn snapshot(&self) -> ActorSnapshot'),
  actor.indexOf('\n    pub fn reconfigure',actor.indexOf('pub fn snapshot(&self) -> ActorSnapshot')),
);
for(const marker of ['self.snapshot','.lock()','snapshot.clone()','poisoned.into_inner().clone()']){
  assert.ok(snapshot.includes(marker),`shared-memory actor snapshot is missing ${marker}`);
}
for(const forbidden of ['mpsc::channel','ActorMessage::Snapshot','recv_timeout']){
  assert.ok(!snapshot.includes(forbidden),`actor snapshot still blocks on ${forbidden}`);
}
assert.ok(!actor.includes('ActorMessage::Snapshot'),'obsolete mailbox snapshot request remains reachable');

const helper=headless.slice(
  headless.indexOf('fn call_with_payload('),
  headless.indexOf('\n    #[test]',headless.indexOf('fn call_with_payload(')),
);
for(const phase of ['IPC_CONNECT','IPC_SET_READ_TIMEOUT','IPC_SET_WRITE_TIMEOUT','IPC_WRITE_HEADER','IPC_WRITE_BODY','IPC_FLUSH','IPC_READ_HEADER','IPC_READ_BODY','IPC_BAD_RESPONSE']){
  assert.ok(helper.includes(`{command_name}: ${phase}`),`native IPC regression has no command-scoped ${phase} diagnostic`);
}
for(const marker of ['set_read_timeout(Some(crate::engine_client::IPC_TIMEOUT))','set_write_timeout(Some(crate::engine_client::IPC_TIMEOUT))']){
  assert.ok(helper.includes(marker),`native IPC regression is not tied to the production deadline: ${marker}`);
}
assert.ok(client.includes('pub(crate) const IPC_TIMEOUT: Duration = Duration::from_secs(10);'),'shared production IPC timeout changed unexpectedly');

const native=headless.slice(headless.indexOf('fn headless_daemon_serves_authenticated_health_and_shutdown'));
for(const marker of ['EngineCommand::ActorUpsert','EngineCommand::RuntimeSnapshot','EngineCommand::Shutdown','let restart_worker = std::thread::spawn']){
  assert.ok(native.includes(marker),`native end-to-end regression lost ${marker}`);
}

console.log('FIX3.9 nonblocking actor snapshot checks passed: IPC reads cannot wait on actor mailbox I/O and failures name the exact command and phase');
