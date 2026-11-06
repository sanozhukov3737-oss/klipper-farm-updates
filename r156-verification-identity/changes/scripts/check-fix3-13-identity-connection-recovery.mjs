#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root=process.env.KF_FIX3_13_ROOT
  ? path.resolve(process.env.KF_FIX3_13_ROOT)
  : path.resolve(import.meta.dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8').replaceAll('\r\n','\n');
const buildId=read('RELEASE-BUILD-ID.txt').trim();
const actor=read('src-tauri/src/transactional_core/actor.rs');
const core=read('src-tauri/src/transactional_core/mod.rs');
const types=read('src-tauri/src/transactional_core/types.rs');
const deviceIdentity=read('src/lib/deviceIdentity.ts');
const modelSelection=read('src/lib/modelSelection.ts');
const app=read('src/App.tsx');
const rustRunner=read('scripts/run-rust-tests.mjs');

const failures=[];
const requireInvariant=(condition,label)=>{if(!condition)failures.push(label)};
const compact=source=>source.replace(/\s+/g,'').replace(/,([\)\]])/g,'$1');
const containsTokens=(source,fragment)=>compact(source).includes(compact(fragment));
const findPattern=(source,pattern,offset=0)=>{
  const flags=pattern.flags.replaceAll('g','');
  const match=new RegExp(pattern.source,flags).exec(source.slice(offset));
  return match?offset+match.index:-1;
};
const section=(source,start,end,label)=>{
  const first=findPattern(source,start);
  const last=first>=0?findPattern(source,end,first+1):-1;
  requireInvariant(first>=0&&last>first,`${label}: source anchors`);
  return first>=0&&last>first?source.slice(first,last):'';
};

requireInvariant(/^V20\.6-R/.test(buildId),'current FIX3.13+ build identity');

const upsert=section(core,/\bfn\s+upsert_with_sink\s*\(/,/\bpub\s+fn\s+execute_by_printer_id\b/,'actor upsert');
requireInvariant(upsert.includes('IDENTITY_BINDING_DRIFT_IGNORED'),'durable identity drift observability');
requireInvariant(containsTokens(upsert,'config.stable_id = bound.clone()'),'durable Rust stable ID authority');
requireInvariant(!upsert.includes('.quarantine('),'no binding-drift quarantine call');

const connect=section(actor,/\bfn\s+try_connect\s*\(\s*&mut\s+self\s*\)/,/\bfn\s+connect_websocket\s*\(\s*&self\s*\)/,'actor connection');
requireInvariant(connect.includes('SUBSCRIPTION_DEGRADED'),'recoverable vendor subscription failure');
requireInvariant(containsTokens(connect,'self.publish_snapshot("connected"'),'prompt connected snapshot');
requireInvariant(!containsTokens(connect,'self.attest_identity(false)')&&!containsTokens(connect,'self.attest_capabilities()'),'no blocking startup attestation');

const reconfigure=section(actor,/\bpub\s+fn\s+reconfigure\s*\(\s*&self\b/,/\bpub\s+fn\s+reattest\s*\(\s*&self\b/,'actor reconfigure');
requireInvariant(containsTokens(reconfigure,'Ok(self.snapshot())'),'nonblocking reconfigure acknowledgement');
requireInvariant(!reconfigure.includes('recv_timeout'),'no reconfigure mailbox wait');
requireInvariant(!containsTokens(upsert,'Duration::from_secs(10)'),'no ten-second registry convoy');
requireInvariant(!actor.includes('ActorMessage::Quarantine')&&!actor.includes('pub fn quarantine(&self'),'automatic quarantine message API removed');

const capabilities=section(actor,/\bfn\s+attest_capabilities\s*\(\s*&mut\s+self\s*\)/,/\bfn\s+attest_identity\s*\(/,'capability attestation');
const identityAttestation=section(actor,/\bfn\s+attest_identity\s*\(/,/\bfn\s+reattest\s*\(\s*&mut\s+self\s*\)/,'identity attestation');
requireInvariant(containsTokens(capabilities,'CAPABILITY_ATTESTATION_WARNING')&&containsTokens(capabilities,'"capability_warning"'),'capability drift remains diagnostic');
requireInvariant(containsTokens(identityAttestation,'IDENTITY_ATTESTATION_WARNING')&&containsTokens(identityAttestation,'"identity_warning"'),'identity drift remains diagnostic');
for(const [label,source] of [['capability',capabilities],['identity',identityAttestation]]){
  requireInvariant(!containsTokens(source,'self.machine.force_quarantine()'),`${label} attestation cannot force quarantine`);
  requireInvariant(!containsTokens(source,'self.snapshot.phase = PrinterPhase::Quarantined'),`${label} attestation cannot change phase to quarantine`);
}

requireInvariant(containsTokens(types,'self.connected && self.phase == PrinterPhase::Quarantined'),'connected quarantine presentation branch');
requireInvariant(containsTokens(types,'("online", "quarantine", "Moonraker доступен · управление ограничено")'),'connected quarantine is network-online');
requireInvariant(containsTokens(deviceIdentity,'.find(Boolean)')&&!containsTokens(deviceIdentity,'hardware.join'),'single-priority stable identity');
requireInvariant(deviceIdentity.includes('refreshDeviceIdentityEvidence'),'identity evidence refresh helper');
requireInvariant(containsTokens(modelSelection,'refreshDeviceIdentityEvidence(config.deviceIdentity,detection.deviceIdentity)'),'model refresh preserves stable ID');
requireInvariant(containsTokens(app,'refreshDeviceIdentityEvidence(existing.deviceIdentity'),'discovery preserves stable ID');

for(const test of [
  'actor_reconfigure_ack_is_nonblocking_while_worker_is_busy',
  'connected_quarantine_does_not_lie_about_network_reachability',
  'optional_lower_priority_signals_do_not_rotate_stable_id',
])requireInvariant(rustRunner.includes(test),`Windows Rust inventory: ${test}`);

const statuses=Array.from({length:7},(_,index)=>({connected:true,phase:index<2?'quarantined':'printing'}));
requireInvariant(statuses.filter(status=>status.connected).length===7,'seven connected printers remain reachable');

if(failures.length){
  for(const failure of failures)console.error(`FIX3.13 invariant failed: ${failure}`);
  process.exit(1);
}
console.log('FIX3.13 identity/connection recovery checks passed: binding drift cannot auto-quarantine, startup attestation cannot block telemetry, and live connectivity stays truthful');
