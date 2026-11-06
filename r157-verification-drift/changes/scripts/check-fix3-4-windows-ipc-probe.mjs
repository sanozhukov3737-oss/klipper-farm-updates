#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const cargo=read('src-tauri/Cargo.toml');
const probeMain=read('src-tauri/src/bin/klipper-farm-ipc-probe.rs');
const daemon=read('src-tauri/src/headless_engine.rs');
const client=read('src-tauri/src/engine_client.rs');
const harness=read('scripts/check-headless-telemetry-runtime.mjs');
const windowsBuild=read('scripts/build-and-install-windows.mjs');

for(const marker of ['name="klipper-farm-ipc-probe"','path="src/bin/klipper-farm-ipc-probe.rs"']){
  assert.ok(cargo.includes(marker),`native IPC probe target is missing ${marker}`);
}
assert.match(probeMain,/run_ipc_probe_from_args\(std::env::args_os\(\)\)/,'native probe does not enter the production AF_UNIX client path');
for(const marker of ['struct IpcProbeInput','deny_unknown_fields','pub fn run_ipc_probe_from_args','fn call_published_endpoint','crate::engine_client::call_path_with_request_id']){
  assert.ok(daemon.includes(marker),`native IPC probe is missing ${marker}`);
}
assert.match(daemon,/\.take\(\(MAX_FRAME_BYTES \+ 1\) as u64\)/,'native probe stdin is not bounded');
assert.match(daemon,/fn ipc_probe_schema_is_strict_and_never_accepts_a_caller_token\(\)/,'native probe has no strict-schema regression test');
for(const marker of ['pub(crate) fn call_path_with_request_id','endpoint.minimum_client_version > kf_ipc::PROTOCOL_VERSION','token: endpoint.token','LocalStream::connect(&endpoint.endpoint)','IPC_RESPONSE_REQUEST_ID_MISMATCH']){
  assert.ok(client.includes(marker),`shared production IPC client is missing ${marker}`);
}

assert.doesNotMatch(harness,/net\.createConnection|\\\.\pipe/,'Windows physical runtime still treats AF_UNIX as a Node named pipe');
assert.match(harness,/net\.createServer/,'physical runtime lost its stalled-server fixture');
assert.match(harness,/argument\('probe'\)/,'physical runtime does not require the native IPC probe');
assert.match(harness,/spawn\(probePath,\['--data-dir',temporary\]/,'physical runtime never executes the native IPC probe');
assert.match(harness,/const request=\{requestId,command,payload\}/,'physical runtime still reads or forwards the endpoint token through Node');
assert.doesNotMatch(harness,/current\.token|token:current/,'physical runtime leaks the daemon token into Node');
for(const marker of ['headless WebSocket telemetry snapshot','REST-only actor fallback readiness','persisted headless actor recovery']){
  assert.ok(harness.includes(marker),`physical daemon coverage regressed: ${marker}`);
}


assert.match(windowsBuild,/'--bin','klipper-farm-ipc-probe'/,'Windows build never compiles the native IPC probe');
console.log('FIX3.4 Windows IPC probe checks passed: Node named-pipe mismatch removed and physical daemon coverage retained');
