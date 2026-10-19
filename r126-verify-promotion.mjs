import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root=path.resolve(process.argv[2]);
const json=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8').replace(/^\uFEFF/,''));
const hash=async name=>{const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(path.join(root,name)))h.update(chunk);return h.digest('hex')};
const contract=json('r126-promotion-contract.json'), run=json('build-run.json'), jobs=json('build-jobs.json').jobs;
const release=json('release.json'), provenance=json('provenance.json'), acceptance=json('exact-validation.json');
const manifest=json('update-v20.json'), inspection=json('source-inspection.json'), tag=json('tag-commit.json');
const repo='sanozhukov3737-oss/klipper-farm-updates', publicHex='28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb';
assert.equal(contract.repository,repo);assert.equal(contract.sequence,126);assert.equal(contract.patchSha256,'20d20017dfa46ccbb53ffca6b243aeb4691a88e4f4c8c670f3fda83512ddfeae');
assert.equal(String(run.id),String(contract.buildRunId));assert.equal(run.head_sha,contract.buildHeadSha);
assert.equal(run.head_branch,'r126-flashforge-files');assert.equal(run.event,'push');assert.equal(run.status,'completed');assert.equal(run.conclusion,'success');
assert.equal(run.path,'.github/workflows/windows-r126.yml');
assert.equal(await hash('build-workflow.yml'),contract.buildWorkflowSha256);
for(const name of ['build','validate','publish']){const matches=jobs.filter(job=>job.name===name);assert.equal(matches.length,1);assert.equal(matches[0].status,'completed');assert.equal(matches[0].conclusion,'success')}
assert.equal(release.id,contract.releaseId);assert.equal(release.tag_name,'r126');assert.equal(release.draft,false);assert.equal(release.prerelease,true);
assert.equal(release.target_commitish,contract.buildHeadSha);assert.equal(tag.commitSha,contract.buildHeadSha);
assert.equal(String(provenance.runId),String(run.id));assert.equal(provenance.headSha,run.head_sha);assert.equal(provenance.sequence,126);assert.equal(provenance.baselineSequence,125);
assert.equal(String(acceptance.runId),String(run.id));assert.equal(acceptance.headSha,run.head_sha);assert.equal(acceptance.upgradeFrom,125);
for(const flag of ['passed','installedBinaryHashesMatch','desktopWebViewLoaded','legacyDataPreserved','printerConfigurationPreserved','filamentInventoryPreserved','installedRestartVerified'])assert.equal(acceptance[flag],true,flag);
assert.equal(inspection.passed,true);assert.equal(inspection.reviewedFileCount,30);assert.equal(inspection.exactPublishedSourceMatchesReviewedPatch,true);
assert.equal(inspection.installedUpgradeAndRestartDataPreserved,true);assert.equal(inspection.nativeRuntimeEmulatorVerified,true);
for(const [name,pin] of Object.entries(contract.assets)){
 const a=release.assets.filter(asset=>asset.name===name);assert.equal(a.length,1,name);
 assert.equal(a[0].size,pin.sizeBytes,name);assert.equal(a[0].digest,'sha256:'+pin.sha256,name);
 assert.equal(fs.statSync(path.join(root,name)).size,pin.sizeBytes,name);assert.equal(await hash(name),pin.sha256,name);
 if(provenance.assets[name]){assert.equal(provenance.assets[name].sizeBytes,pin.sizeBytes);assert.equal(provenance.assets[name].sha256,pin.sha256)}
}
assert.equal(manifest.schemaVersion,1);assert.equal(manifest.channel,'stable');assert.equal(manifest.sequence,126);assert.equal(manifest.version,'1.14.5-r126');
assert.equal(manifest.artifact.url,`https://github.com/${repo}/releases/download/r126/Klipper-Farm-R126-setup.exe`);
assert.equal(manifest.artifact.sha256,contract.assets['Klipper-Farm-R126-setup.exe'].sha256);assert.equal(manifest.artifact.sizeBytes,contract.assets['Klipper-Farm-R126-setup.exe'].sizeBytes);
assert.ok(Number.isSafeInteger(manifest.publishedAt)&&manifest.publishedAt>1792406476000&&manifest.publishedAt<Date.now()+300000);
const keyId=crypto.createHash('sha256').update(Buffer.from(publicHex,'hex')).digest('hex').slice(0,32);assert.equal(manifest.signerKeyId,keyId);
assert.match(manifest.signatureHex,/^[a-f0-9]{128}$/);
const unsigned={schemaVersion:manifest.schemaVersion,channel:manifest.channel,sequence:manifest.sequence,version:manifest.version,publishedAt:manifest.publishedAt,artifact:{url:manifest.artifact.url,sha256:manifest.artifact.sha256,sizeBytes:manifest.artifact.sizeBytes},releaseNotes:manifest.releaseNotes,signerKeyId:manifest.signerKeyId};
const signingBytes=Buffer.concat([Buffer.from('klipper-farm-update-manifest-v1\0'),Buffer.from(JSON.stringify(unsigned))]);
const publicKey=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(publicHex,'hex')]),type:'spki',format:'der'});
assert.ok(crypto.verify(null,signingBytes,publicKey,Buffer.from(manifest.signatureHex,'hex')),'Publisher root signature invalid');
assert.equal(manifest.releaseNotes,fs.readFileSync(path.join(root,'r126-release-notes.md'),'utf8'));
const evidenceAssets={...contract.assets,'update-v20.json':{sha256:await hash('update-v20.json'),sizeBytes:fs.statSync(path.join(root,'update-v20.json')).size}};
const attestation={schemaVersion:1,release:'R126',sequence:126,passed:true,repository:repo,releaseId:release.id,buildRunId:String(run.id),buildHeadSha:run.head_sha,buildWorkflowSha256:contract.buildWorkflowSha256,patchSha256:contract.patchSha256,sourceAndInstalledValidationSameRun:true,ed25519SignatureVerified:true,signerKeyId:keyId,promotionHeadSha:process.env.GITHUB_SHA??null,physicalPrinterTested:false,inspection,assets:evidenceAssets,verifiedAt:new Date().toISOString()};
fs.writeFileSync(path.join(root,'promotion-attestation.json'),JSON.stringify(attestation,null,2)+'\n');
const sums=[];for(const name of [...Object.keys(evidenceAssets),'promotion-attestation.json','r126-promotion-contract.json'])sums.push(`${await hash(name)}  ${name}`);
fs.writeFileSync(path.join(root,'SHA256SUMS.txt'),sums.join('\n')+'\n');
console.log(JSON.stringify(attestation,null,2));
