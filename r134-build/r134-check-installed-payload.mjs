import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [installDir,packageDir,output]=process.argv.slice(2);
assert.ok(installDir&&packageDir&&output);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const report={schemaVersion:1,passed:true,comparison:'nsis-extracted-exact-v1',binaries:{}};
const expectedChannel={
 endpoint:'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json',
 publicKeyHex:'28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb',
 channel:'stable',installedSequence:134,
};
const files=[];
const walk=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
 assert.ok(!entry.isSymbolicLink(),'Extracted NSIS payload must not contain symlinks');
 const name=path.join(folder,entry.name);if(entry.isDirectory())walk(name);else if(entry.isFile())files.push(name);
}};
walk(packageDir);
for(const name of ['klipper-farm-client.exe','klipper-farmd.exe']){
 const packagedFiles=files.filter(file=>path.basename(file).toLowerCase()===name);
 assert.equal(packagedFiles.length,1,`Expected one exact NSIS payload file: ${name}`);
 const packaged=fs.readFileSync(packagedFiles[0]);
 const installed=fs.readFileSync(path.join(installDir,name));
 const entry={sizeBytes:installed.length,packagedSha256:sha(packaged),installedSha256:sha(installed),expectedInstalledSha256:sha(packaged),packagedPath:path.relative(packageDir,packagedFiles[0]).replaceAll('\\','/')};
 assert.equal(installed.length,packaged.length,`Installed binary length differs from extracted NSIS payload: ${name}`);
 assert.equal(entry.installedSha256,entry.packagedSha256,`Installed SHA-256 differs from extracted NSIS payload: ${name}`);
 assert.ok(packaged.equals(installed),`Installed bytes differ from extracted NSIS payload: ${name}`);
 if(name==='klipper-farm-client.exe'){
  assert.ok(installed.includes(Buffer.from('V20.6-R13.4-PRINT-TRANSFER-FIX-2026-10-21')),'Installed desktop build identity differs');
  assert.ok(installed.includes(Buffer.from('28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb')),'Installed publisher public key differs');
  assert.ok(installed.includes(Buffer.from(JSON.stringify(expectedChannel,null,2)+'\n')),'Installed native updater does not embed the exact stable R134 channel');
  report.installedSequence=133;
  report.embeddedUpdateChannelVerified=true;
 }
 report.binaries[name]=entry;
}
fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
