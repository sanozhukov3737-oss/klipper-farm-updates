#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const client=read('src-tauri/src/engine_client.rs');
const actor=read('src-tauri/src/transactional_core/actor.rs');
const identity=read('src-tauri/src/transactional_core/identity.rs');
const capabilities=read('src-tauri/src/transactional_core/capabilities.rs');
const css=read('src/styles.css');
const rustRunner=read('scripts/run-rust-tests.mjs');

assert.match(
  read('RELEASE-BUILD-ID.txt').trim(),
  /^V20\.6-R/,
  'FIX3.10 recovery is not carried by the current build',
);

for(const marker of [
  'impl Drop for EngineClient',
  'Arc::strong_count(&self.spawned_daemon) == 1',
  'self.shutdown_owned_daemon()',
  'self.retire_authenticated_daemon(&endpoint_path)?',
  'EngineCommand::Shutdown',
  'HEADLESS_ENGINE_PREVIOUS_DAEMON_SHUTDOWN_TIMEOUT',
  'The fallback only touches the Child handle spawned by this client',
])assert.ok(client.includes(marker),`daemon ownership recovery is missing ${marker}`);
assert.ok(client.indexOf('self.retire_authenticated_daemon(&endpoint_path)?')<client.indexOf('self.start_daemon_until_ready('),'old authenticated daemon is not retired before the replacement starts');

for(const marker of [
  'let verified = !enforced || observed_stable_id.as_deref() == Some(expected_stable_id)',
  'legacy_config_identity_survives_missing_optional_hardware_signals',
  'enforced_hardware_identity_still_requires_proof',
  'IDENTITY_EVIDENCE_UNAVAILABLE',
])assert.ok(identity.includes(marker),`identity recovery is missing ${marker}`);
for(const marker of [
  'object_catalog_confirmed',
  'let compatible = !object_catalog_confirmed',
  'missing_object_catalog_does_not_prove_incompatibility',
  'confirmed_incomplete_catalog_remains_quarantinable',
])assert.ok(capabilities.includes(marker),`capability recovery is missing ${marker}`);
for(const marker of [
  'transient_attestation_quarantine',
  'self.attest_identity(false)',
  'self.attest_capabilities()',
  'attestation_recovered',
  'expected_stable_id.starts_with("kf-device-")',
])assert.ok(actor.includes(marker),`automatic quarantine recovery is missing ${marker}`);
for(const test of [
  'only_transient_attestation_quarantine_is_automatically_retried',
  'legacy_config_identity_survives_missing_optional_hardware_signals',
  'enforced_hardware_identity_still_requires_proof',
  'missing_object_catalog_does_not_prove_incompatibility',
  'confirmed_incomplete_catalog_remains_quarantinable',
])assert.ok(rustRunner.includes(test),`Windows Rust gate does not require ${test}`);

const lightFix=css.lastIndexOf('V20.6 R8 FIX3.10');
assert.ok(lightFix>0,'FIX3.10 light-theme boundary is missing');
assert.ok(lightFix>css.indexOf('.modelDetectionReport{'),'light-theme fix does not follow the legacy dark report rule');
const scoped=css.slice(lightFix);
for(const marker of [
  ':root[data-theme="light"] .settingsModal.printerSetup',
  ':root[data-theme="light"] .printerSetup .modelDetectionReport',
  ':root[data-theme="light"] .printerSetupActions',
  'background:#fff!important',
  'backdrop-filter:none!important',
])assert.ok(scoped.includes(marker),`light printer-settings isolation is missing ${marker}`);

console.log('FIX3.10 engine/quarantine/UI recovery checks passed: owned daemon lifecycle is bounded, transient attestation retries and light settings remain light');
