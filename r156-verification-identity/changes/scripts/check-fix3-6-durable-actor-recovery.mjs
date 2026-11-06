#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const core=read('src-tauri/src/transactional_core/mod.rs');
const headless=read('src-tauri/src/headless_engine.rs');
const runtime=read('scripts/check-headless-telemetry-runtime.mjs');
const rustRunner=read('scripts/run-rust-tests.mjs');
const ipc=read('src-tauri/crates/kf-ipc/src/lib.rs');

for(const marker of [
  'headless.actor_registry.v1',
  'PersistedActorRegistration',
  'MAX_ACTOR_REGISTRY_BYTES',
  'MAX_FIRMWARE_SIGNATURE_BYTES',
  'validate_persisted_actor_registration',
  'write_actor_registration_row',
  'delete_actor_registration_row',
  'read_actor_registry',
  'self.persist_actor_registration(&config)?',
  'let registration_removed = self.delete_actor_registration(stable_id)?',
  'durable_actor_registry_round_trips_replaces_and_deletes_without_secrets',
])assert.ok(core.includes(marker),`durable actor recovery is missing ${marker}`);

const registration=core.slice(
  core.indexOf('struct PersistedActorRegistration'),
  core.indexOf('fn read_actor_registry'),
);
assert.ok(!registration.includes('api_key')&&!registration.includes('token'),'actor registry must never persist credentials');

const upsert=core.slice(core.indexOf('fn upsert_with_sink'),core.indexOf('pub fn execute_by_printer_id'));
assert.ok(upsert.indexOf('self.persist_actor_registration(&config)?')<upsert.indexOf('ActorHandle::spawn'),'actor registration is not durable before actor spawn');
const remove=core.slice(core.indexOf('pub fn remove('),core.indexOf('pub fn scheduler('));
assert.ok(remove.indexOf('self.delete_actor_registration(stable_id)?')<remove.indexOf('.remove(stable_id)'),'actor can be removed from memory before its durable registration');

const durable=ipc.slice(ipc.indexOf('pub const fn durable'),ipc.indexOf('\n}\n\n#[derive',ipc.indexOf('pub const fn durable')));
assert.ok(durable.includes('Self::ActorUpsert'),'ActorUpsert is no longer a durable IPC command');
for(const marker of [
  'runtime-restart-actor',
  'restarted daemon endpoint',
  'actorsBootstrapped',
])assert.ok(headless.includes(marker),`native daemon restart regression is missing ${marker}`);
for(const marker of [
  'beforeRestart.actorsLive',
  'restartedHealth.actorsBootstrapped',
  "new Set(['printer-ws','printer-rest'])",
  'restored actor is not connected',
])assert.ok(runtime.includes(marker),`physical actor-recovery gate is missing ${marker}`);
assert.ok(rustRunner.includes("'transactional_core::tests::durable_actor_registry_round_trips_replaces_and_deletes_without_secrets'"),'native registry regression is not mandatory');
assert.ok(rustRunner.includes("const MIN_ROOT_TEST_COUNT=process.platform==='win32'?129:127"),'Rust test inventory floor was not advanced');

console.log('FIX3.6 durable actor recovery checks passed: upsert/delete are synchronous, registry is secret-free, and native restart restoration is mandatory');
