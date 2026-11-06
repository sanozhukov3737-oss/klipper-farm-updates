#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8').replaceAll('\r\n','\n');
const actor=read('src-tauri/src/transactional_core/actor.rs');
const fix313=read('scripts/check-fix3-13-identity-connection-recovery.mjs');

assert.match(read('RELEASE-BUILD-ID.txt').trim(),/^V20\.6-R/);
for(const removed of [
  'ActorMessage::Quarantine',
  'pub fn quarantine(&self',
  'fn force_quarantine(&mut self, reason:',
  'identity_binding_quarantined',
])assert.ok(!actor.includes(removed),`dead automatic-quarantine path remains: ${removed}`);
for(const marker of [
  "replaceAll('\\r\\n','\\n')",
  'FIX3.13 invariant failed:',
  'const containsTokens=',
  'const findPattern=',
  'section(core,/\\bfn\\s+upsert_with_sink',
  'section(actor,/\\bfn\\s+try_connect',
  'section(actor,/\\bfn\\s+attest_capabilities',
  'automatic quarantine message API removed',
])assert.ok(fix313.includes(marker),`FIX3.13 gate is still opaque or line-ending-sensitive: ${marker}`);

console.log('FIX3.15 clean quarantine gate checks passed: dead message API removed and FIX3.13 reports every failed invariant explicitly');
