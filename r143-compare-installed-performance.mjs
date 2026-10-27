import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [baselineFile,currentFile,output]=process.argv.slice(2);
assert.ok(baselineFile&&currentFile&&output);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const baseline=read(baselineFile),current=read(currentFile),checks=[];
for(const report of [baseline,current]){assert.equal(report.passed,true);assert.equal(report.actualInstalledWebView,true);assert.equal(report.wholeApplicationProcessTreeSampled,true);assert.equal(report.configuredPrinters,7);assert.equal(report.phases.length,3);assert.deepEqual(report.runtimeErrors,[])}
assert.equal(baseline.label,'R142');assert.equal(current.label,'R143');assert.notEqual(baseline.client.sha256,current.client.sha256);
for(const old of baseline.phases){const now=current.phases.find(row=>row.name===old.name);assert.ok(now);assert.ok(Math.abs(old.durationMs-now.durationMs)<3000);
 for(const [metric,factor,allowance]of [['peakPrivateCommitBytes',1.15,32*1024*1024],['sampledProcessCpuSeconds',1.25,2],['rendererScriptSeconds',1.25,.5]]){
  const limit=old[metric]*factor+allowance;checks.push({phase:old.name,metric,baseline:old[metric],current:now[metric],limit,passed:now[metric]<=limit});
 }
}
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={schemaVersion:1,passed:checks.every(row=>row.passed),checks,inputs:{baseline:{file:baselineFile,sha256:sha(baselineFile)},current:{file:currentFile,sha256:sha(currentFile)}},scope:current.scope,metricNotes:'Private commit covers current application descendants at each simultaneous sample. Working-set sums are diagnostic, not unique physical RAM. Budgets detect coarse short-duration regressions and do not certify all printer hardware or a long-running farm.'};
fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));assert.ok(result.passed,'Installed Windows resource regression budget exceeded');
