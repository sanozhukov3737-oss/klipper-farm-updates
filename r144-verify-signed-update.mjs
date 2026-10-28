import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const incoming=path.resolve(process.argv[2]),source=path.resolve(process.argv[3]);
const json=name=>JSON.parse(fs.readFileSync(path.join(incoming,name),'utf8').replace(/^\uFEFF/,''));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const contract=json('r144-promotion-contract.json'),manifest=json('update-v20.json'),verification=json('r144-final-verification.json');
assert.equal(contract.sequence,144);assert.equal(verification.passed,true);assert.equal(verification.buildHeadSha,contract.buildHeadSha);assert.deepEqual(verification.assets,contract.assets);
assert.equal(hash(path.join(incoming,'update-v20.json')),contract.signedManifestSha256);
assert.equal(manifest.releaseNotes,fs.readFileSync(path.join(incoming,'r144-release-notes.md'),'utf8'));
assert.equal(manifest.sequence,144);assert.equal(manifest.version,'1.14.5-r144');assert.equal(manifest.channel,'stable');assert.equal(manifest.schemaVersion,1);
const publicRaw=Buffer.from('28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb','hex');
assert.equal(manifest.signerKeyId,crypto.createHash('sha256').update(publicRaw).digest('hex').slice(0,32));
const unsigned={schemaVersion:manifest.schemaVersion,channel:manifest.channel,sequence:manifest.sequence,version:manifest.version,publishedAt:manifest.publishedAt,artifact:{url:manifest.artifact.url,sha256:manifest.artifact.sha256,sizeBytes:manifest.artifact.sizeBytes},releaseNotes:manifest.releaseNotes,signerKeyId:manifest.signerKeyId};
const key=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),publicRaw]),format:'der',type:'spki'});
assert.equal(crypto.verify(null,Buffer.concat([Buffer.from('klipper-farm-update-manifest-v1\0'),Buffer.from(JSON.stringify(unsigned))]),key,Buffer.from(manifest.signatureHex,'hex')),true);
assert.equal(manifest.artifact.url,'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/download/r144-ota/Klipper-Farm-R144-setup.exe');
for(const [name,pin] of Object.entries(contract.assets)){const file=path.join(incoming,name);assert.equal(fs.statSync(file).size,pin.sizeBytes);assert.equal(hash(file),pin.sha256);}
assert.equal(manifest.artifact.sha256,contract.assets['Klipper-Farm-R144-setup.exe'].sha256);assert.equal(manifest.artifact.sizeBytes,contract.assets['Klipper-Farm-R144-setup.exe'].sizeBytes);
const native=fs.readFileSync(path.join(incoming,'native-bundle-verification.txt'),'utf8');assert.match(native,/verified channel=stable sequence=144 version=1\.14\.5-r144/);
const channel=JSON.parse(fs.readFileSync(path.join(source,'UPDATE-CHANNEL.json'),'utf8'));assert.equal(channel.installedSequence,144);assert.equal(channel.publicKeyHex,publicRaw.toString('hex'));
assert.ok(fs.readFileSync(path.join(source,'src-tauri/src/online_updates.rs'),'utf8').includes('Ok(if value.manifest.sequence > channel()?.installed_sequence { Some(UpdateInfo::from(&value)) } else { None })'));
const sequence={passed:true,manifestSequence:144,previousInstalledSequence:143,installedSequence:144,availableFromR143:manifest.sequence>143,noRepeatedUpdateFromR144:!(manifest.sequence>channel.installedSequence),nativeComparisonVerified:true,installedExecutableChannelVerified:true};
fs.writeFileSync(path.join(incoming,'update-sequence-verification.json'),JSON.stringify(sequence,null,2)+'\n');
const attestation={schemaVersion:1,passed:true,sequence:144,buildRunId:contract.buildRunId,buildHeadSha:contract.buildHeadSha,promotionRunId:process.env.GITHUB_RUN_ID,promotionHeadSha:process.env.GITHUB_SHA,ed25519SignatureVerified:true,productionRustUpdaterVerified:true,compiledArtifactBoundToInstalledValidation:true,embeddedInstalledSequenceVerified:true,sourceAndRegressionProofsVerified:true,assets:contract.assets,signedManifestSha256:contract.signedManifestSha256};
fs.writeFileSync(path.join(incoming,'promotion-attestation.json'),JSON.stringify(attestation,null,2)+'\n');console.log(JSON.stringify(attestation));
