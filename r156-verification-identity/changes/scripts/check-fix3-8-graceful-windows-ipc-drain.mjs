#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const headless=read('src-tauri/src/headless_engine.rs');
const rustRunner=read('scripts/run-rust-tests.mjs');

assert.match(
  read('RELEASE-BUILD-ID.txt').trim(),
  /^V20\.6-R/,
  'FIX3.8 graceful drain is not carried by the current build',
);

for(const marker of [
  'use tokio::task::JoinSet;',
  'let mut connections = JoinSet::new();',
  'drop(connections.spawn(async move',
  'connections.try_join_next()',
  'connections.join_next().await',
  'WINDOWS_RUNTIME_FILE_ATTEMPTS',
  'remove_runtime_file(&self.socket_path, "IPC socket")?',
  'server_result.and(cleanup_result)',
])assert.ok(headless.includes(marker),`graceful Windows IPC drain is missing ${marker}`);

const shutdown=headless.slice(
  headless.indexOf('let server_result = loop'),
  headless.indexOf('\n}\n\nfn handle_connection'),
);
const close=shutdown.indexOf('drop(listener);');
const drain=shutdown.indexOf('connections.join_next().await');
const state=shutdown.indexOf('drop(state);');
const cleanup=shutdown.indexOf('let cleanup_result = endpoint_guard.cleanup();');
assert.ok(close>=0&&close<drain,'listener is not closed before accepted IPC tasks drain');
assert.ok(drain<state,'engine state is dropped before accepted IPC tasks finish');
assert.ok(state<cleanup,'endpoint cleanup starts before IPC state is released');

const cleanupHelper=headless.slice(
  headless.indexOf('fn remove_runtime_file'),
  headless.indexOf('\nfn secure_socket'),
);
for(const marker of ['ErrorKind::NotFound','Some(5) | Some(32) | Some(33)','std::thread::sleep','attempt + 1 < attempts']){
  assert.ok(cleanupHelper.includes(marker),`Windows runtime cleanup retry is missing ${marker}`);
}

const restartTest=headless.slice(
  headless.indexOf('fn headless_daemon_serves_authenticated_health_and_shutdown'),
);
assert.ok(restartTest.includes('daemon socket survived listener shutdown'),'native restart regression lost its socket cleanup assertion');
assert.ok(restartTest.includes('let restart_worker = std::thread::spawn'),'native daemon restart is no longer exercised');
for(const marker of ['let held_stream = LocalStream::connect','let held_stream_release = std::thread::spawn','held_stream_release.join().unwrap()']){
  assert.ok(restartTest.includes(marker),`native shutdown regression does not hold an accepted stream across cleanup: ${marker}`);
}

for(const marker of ['v20-rust-tests-last.log','Rust failing tests:','Complete Rust test log:']){
  assert.ok(rustRunner.includes(marker),`Windows Rust failure diagnostics are missing ${marker}`);
}

console.log('FIX3.8 graceful Windows IPC drain checks passed: listener closes, accepted streams join, cleanup retries and restart remains mandatory');
