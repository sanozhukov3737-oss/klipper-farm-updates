import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [incoming,source]=process.argv.slice(2).map(p=>path.resolve(p));
const read=name=>JSON.parse(fs.readFileSync(path.join(incoming,name),'utf8').replace(/^\uFEFF/,''));
const manifest=read('update-v20.json'),installed=read('source-inspection.json');
const channel=JSON.parse(fs.readFileSync(path.join(source,'UPDATE-CHANNEL.json'),'utf8'));
const native=fs.readFileSync(path.join(source,'src-tauri/src/online_updates.rs'),'utf8');
assert.ok(native.includes('Ok(if value.manifest.sequence > channel()?.installed_sequence { Some(UpdateInfo::from(&value)) } else { None })'));
assert.equal(channel.installedSequence,135);assert.equal(installed.installedSequence,135);
assert.equal(installed.embeddedUpdateChannelVerified,true);assert.equal(manifest.sequence,135);
assert.equal(manifest.channel,channel.channel);
const report={passed:true,manifestSequence:manifest.sequence,previousInstalledSequence:134,installedSequence:channel.installedSequence,
 availableFromR134:manifest.sequence>134,noRepeatedUpdateFromR135:!(manifest.sequence>channel.installedSequence),
 nativeComparisonVerified:true,installedExecutableChannelVerified:installed.embeddedUpdateChannelVerified};
assert.equal(report.availableFromR134,true);assert.equal(report.noRepeatedUpdateFromR135,true);
fs.writeFileSync(path.join(incoming,'update-sequence-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
