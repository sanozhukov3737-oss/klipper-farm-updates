import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [installDir,compiledDir,output]=process.argv.slice(2);
assert.ok(installDir&&compiledDir&&output);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={schemaVersion:1,passed:true,comparison:'tauri-nsis-bundle-type-marker-v1',binaries:{}};
for(const name of ['klipper-farm-client.exe','klipper-farmd.exe']){
 const raw=fs.readFileSync(path.join(compiledDir,name));
 const installed=fs.readFileSync(path.join(installDir,name));
 const entry={sizeBytes:installed.length,compiledSha256:sha(raw),installedSha256:sha(installed),bundleMarkerPatched:false};
 assert.equal(installed.length,raw.length,`Installed binary length differs: ${name}`);
 let expected=raw;
 if(!raw.equals(installed)){
  assert.equal(name,'klipper-farm-client.exe','Only desktop EXE may have a Tauri bundle type marker patch');
  const before=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const after=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const offset=raw.indexOf(before);
  assert.ok(offset>=0,'Compiled desktop does not contain the documented Tauri bundle type token');
  expected=Buffer.from(raw);after.copy(expected,offset);
  const differences=[];for(let i=0;i<raw.length;i++)if(raw[i]!==installed[i]&&differences.length<32)differences.push(i);
  assert.ok(expected.equals(installed),`Installed desktop differs beyond the exact first Tauri NSIS token: ${JSON.stringify({compiledSha256:sha(raw),installedSha256:sha(installed),tokenOffset:offset,firstDifferences:differences})}`);
  entry.bundleMarkerPatched=true;entry.tokenOffset=offset;entry.tokenBefore=before.toString();entry.tokenAfter=after.toString();entry.changedByteCount=differences.length;
  assert.equal(differences.length,3,'Unexpected number of Tauri token byte changes');
 }
 entry.expectedInstalledSha256=sha(expected);
 assert.equal(entry.installedSha256,entry.expectedInstalledSha256,`Installed exact payload hash differs: ${name}`);
 if(name==='klipper-farm-client.exe'){
  assert.ok(installed.includes(Buffer.from('V20.6-R12.6-FLASHFORGE-FILES-2026-10-19')),'Installed desktop build identity differs');
  assert.ok(installed.includes(Buffer.from('28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb')),'Installed publisher public key differs');
 }
 report.binaries[name]=entry;
}
fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
