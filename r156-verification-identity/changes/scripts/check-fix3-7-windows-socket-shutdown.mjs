#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const headless=read('src-tauri/src/headless_engine.rs');

assert.match(
  read('RELEASE-BUILD-ID.txt').trim(),
  /^V20\.6-R/,
  'FIX3.7 socket shutdown fix is not carried by the current build',
);

const shutdown=headless.slice(
  headless.indexOf('let server_result = loop'),
  headless.indexOf('\n}\n\nfn handle_connection'),
);
for(const marker of ['break Ok(())','break Err(format!("Local IPC accept failed: {error}"))','drop(listener);','drop(endpoint_guard);','server_result']){
  assert.ok(shutdown.includes(marker),`daemon shutdown boundary is missing ${marker}`);
}
assert.ok(
  shutdown.indexOf('drop(listener);')<shutdown.indexOf('drop(endpoint_guard);'),
  'EndpointGuard can remove the Windows AF_UNIX path before LocalListener closes',
);

const restartTest=headless.slice(
  headless.indexOf('fn headless_daemon_serves_authenticated_health_and_shutdown'),
);
assert.ok(restartTest.includes('!Path::new(&endpoint.endpoint).exists()'),'native restart test does not require socket cleanup');
assert.ok(restartTest.includes('daemon socket survived listener shutdown'),'native socket-cleanup failure has no precise assertion');
assert.ok(
  restartTest.indexOf('daemon socket survived listener shutdown')<restartTest.indexOf('let restart_dir = data_dir.clone();'),
  'native test restarts before proving the first listener released its socket',
);

console.log('FIX3.7 Windows socket shutdown checks passed: listener closes before endpoint cleanup and restart requires no stale e.sock');
