#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const rustCore=read('src-tauri/src/transactional_core/mod.rs');
const rustRoot=read('src-tauri/src/lib.rs');
const daemon=read('src-tauri/src/headless_engine.rs');
const client=read('src-tauri/src/engine_client.rs');
const actor=read('src-tauri/src/transactional_core/actor.rs');
const moonraker=read('src/lib/moonraker.ts');
const app=read('src/App.tsx');

assert.match(rustRoot,/fn stored_api_key_for_headless\([^)]*\) -> Option<String>/,'headless credential reads are not isolated from strict desktop secret operations');
assert.match(rustRoot,/HEADLESS_CREDENTIAL_READ_SKIPPED/,'headless credential-store degradation is not observable');
assert.match(rustRoot,/continuing without cached API key/,'credential-store failure can still be silent');

assert.match(rustCore,/HEADLESS_ACTOR_BOOTSTRAP_DEGRADED/,'saved actor bootstrap still has no daemon-availability boundary');
assert.match(rustCore,/saved actor bootstrap degraded; IPC startup continues/,'saved actor bootstrap can still fail silently');
assert.match(rustCore,/stored_api_key_for_headless\(&registration\.printer_id\)/,'saved actors still use a fatal optional keyring read');
assert.doesNotMatch(rustCore,/api_key:\s*stored_api_key\(Some\(printer_id\)\)\?/,'one saved credential can still abort klipper-farmd');
assert.match(rustCore,/HEADLESS_ACTOR_RESTORE_SKIPPED/,'one malformed actor is not isolated from the remaining farm');

assert.match(daemon,/or_else\(\|\| crate::stored_api_key_for_headless/,'runtime daemon upsert still performs a fatal optional keyring read');
assert.doesNotMatch(daemon,/\.or\(crate::stored_api_key\(Some\(&input\.config\.printer_id\)\)\?\)/,'legacy fatal daemon keyring fallback returned');

for(const marker of ['STARTUP_LOG_TAIL_BYTES','daemon_exit_error','startup_error_with_detail','startup_log_error_detail','sanitize_startup_error_detail'])assert.ok(client.includes(marker),`daemon exit diagnostics are missing ${marker}`);
assert.match(client,/startup_error_with_detail\(format!\("HEADLESS_ENGINE_EXITED: \{status\}"\), data_dir\)/,'daemon exit status is not preserved');
assert.match(client,/Some\(detail\) => format!\("\{base\}; \{detail\}"\)/,'daemon exit status still hides the startup-log cause');
assert.match(client,/authorization:.*api_key=.*access_token=.*bearer /s,'startup detail redaction markers are incomplete');

assert.match(app,/const engineFailureDetail=/,'engine failure detail is not bounded before rendering');
assert.match(app,/Причина: \$\{engineRuntimeDetail\}/,'the visible engine banner still hides the startup cause');
assert.match(moonraker,/actorAuthoritativeConnectionState/,'native offline state is not retained');
assert.match(moonraker,/preserveAuthoritativeOffline\(this\.actorAuthoritativeConnectionState,connectionStatusPatch\(this\.health\)\)/,'compatibility polling can still revert a confirmed offline printer to connecting');
assert.match(actor,/CONNECTION_STALE_RECONNECT_MS: i64 = 30_000/,'stale WebSocket sessions have no bounded reconnect deadline');
assert.match(actor,/ACTOR_TELEMETRY_STALE_RECONNECT/,'stale-telemetry reconnect is not observable');
assert.match(actor,/connection_observation_stale\(self\.snapshot\.last_seen_at, observed_at\)/,'failed REST reconciliation can still leave a half-open WebSocket marked online');
assert.doesNotMatch(actor,/let _ = self\.reconcile_status\(\)/,'REST reconciliation failures are silently discarded again');
assert.match(actor,/fn stale_connection_observation_has_bounded_reconnect_deadline\(\)/,'stale-connection watchdog has no native regression test');

console.log('FIX3.3 daemon boot recovery checks passed');
