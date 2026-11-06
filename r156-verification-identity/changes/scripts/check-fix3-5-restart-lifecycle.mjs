#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const emulator=read('scripts/hardware-emulator.mjs');
const runtime=read('scripts/check-headless-telemetry-runtime.mjs');
const daemon=read('src-tauri/src/headless_engine.rs');

for(const marker of [
  "socket.on('error',onSocketError)",
  "socket.on('close',()=>{closed=true;websocketSockets.delete(socket)})",
  "'ECONNRESET'",
  "'EPIPE'",
  'safeWrite',
  'websocketSockets',
  'hardware emulator reset self-test OK',
])assert.ok(emulator.includes(marker),`emulator restart lifecycle is missing ${marker}`);
const upgradePath=emulator.slice(emulator.indexOf("server.on('upgrade'"),emulator.indexOf('const resetWebSocketPeer'));
assert.equal((upgradePath.match(/socket\.write\(/g)??[]).length,1,'WebSocket upgrade/data path still bypasses reset-safe writes');

for(const marker of ['error?.nonRetryable','requireChildRunning','normal WebSocket emulator','REST-only emulator']){
  assert.ok(runtime.includes(marker),`physical runtime does not fail fast when an emulator exits: ${marker}`);
}

const bootstrap=daemon.slice(daemon.indexOf('async fn run_server'),daemon.indexOf('fn handle_connection'));
for(const marker of ['retire_stale_endpoint_after_lease','remove_stale_socket','LocalListener::bind','publish_endpoint']){
  assert.ok(bootstrap.includes(marker),`daemon restart bootstrap is missing ${marker}`);
}
assert.ok(bootstrap.indexOf('retire_stale_endpoint_after_lease')<bootstrap.indexOf('LocalListener::bind'),'crash-left endpoint is retired only after the replacement socket is bound');
assert.match(daemon,/fn crash_left_endpoint_is_retired_before_rebinding_the_socket\(\)/,'stale endpoint restart ordering has no native regression test');

const reset=spawnSync(process.execPath,[
  path.join(root,'scripts','hardware-emulator.mjs'),
  '--host=127.0.0.1','--port=0','--model=k1c','--mode=normal','--self-test-reset=true',
],{cwd:root,encoding:'utf8',timeout:12_000,maxBuffer:2*1024*1024});
if(reset.error)throw reset.error;
if(reset.status!==0){
  process.stdout.write(reset.stdout??'');
  process.stderr.write(reset.stderr??'');
}
assert.equal(reset.status,0,'hardware emulator died during an abrupt WebSocket peer reset');
assert.match(reset.stdout,/hardware emulator reset self-test OK/,'hardware emulator did not finish the reset/reconnect self-test');
assert.match(reset.stderr,/unexpected_socket_errors=0/,'hardware emulator hid an unexpected socket error');

console.log('FIX3.5 restart lifecycle checks passed: peer reset survives, emulators fail fast, stale endpoint precedes socket bind');
