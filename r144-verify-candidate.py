"""Independently bind the complete R144 source to Windows build and installed evidence."""
import base64,hashlib,json,os,pathlib,re,runpy,shutil,zipfile

root=pathlib.Path.cwd();incoming=root/'incoming';contract=json.loads((root/'r144-promotion-contract.json').read_text());candidate=incoming/'candidate'
def load(path):return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))
def sha(path):
    with pathlib.Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def object_sha(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def find(directory,name):
    found=[path for path in pathlib.Path(directory).rglob(name) if path.is_file() and path.name==name];assert len(found)==1,(directory,name);return found[0]
patch=load(root/'r144-source-changes.json');assert sha(root/'r144-source-changes.json')==contract['sourcePatchSha256']
assert patch['sequence']==contract['sequence']==144 and contract['previousTag']=='r143-ota'
provenance=load(candidate/'provenance.json');assert provenance['sequence']==144 and provenance['stablePublished'] is False
assert str(provenance['buildRunId'])==str(contract['buildRunId']) and provenance['buildHeadSha']==contract['buildHeadSha']
assert provenance['sourcePatchSha256']==contract['sourcePatchSha256'] and provenance['assets']==contract['assets']
for name,pin in contract['assets'].items():assert sha(candidate/name)==pin['sha256'] and (candidate/name).stat().st_size==pin['sizeBytes']
baseline=incoming/'KF-R143-FULL.zip';assert sha(baseline)==patch['baselineSha256'] and baseline.stat().st_size==patch['baselineBytes']
source=candidate/'KF-R144-FULL.zip'
def entries(package,prefix):
    found={}
    for entry in package.infolist():
        assert entry.filename.startswith(prefix) and '\\' not in entry.filename
        path=pathlib.PurePosixPath(entry.filename);assert '..' not in path.parts and not path.is_absolute()
        assert (entry.external_attr>>16)&0o170000!=0o120000
        if entry.is_dir():continue
        name=entry.filename[len(prefix):];assert name and name not in found;found[name]=entry
    return found
with zipfile.ZipFile(baseline) as before,zipfile.ZipFile(source) as after:
    original=entries(before,'Klipper-Farm-R143/');current=entries(after,'Klipper-Farm-R144/')
    def hashes(package,mapping):
        result={}
        for name,entry in mapping.items():
            with package.open(entry) as f:result[name]=hashlib.file_digest(f,'sha256').hexdigest()
        return result
    old=hashes(before,original);actual=hashes(after,current);expected=dict(old)
    for row in patch['files']:
        assert row['beforeSha256']==old.get(row['path'])
        content=base64.b64decode(row['contentBase64'],validate=True);assert hashlib.sha256(content).hexdigest()==row['afterSha256']
        expected[row['path']]=row['afterSha256'];assert actual[row['path']]==row['afterSha256'],row['path']
    generated=lambda name:name.startswith('dist/') or name in {'DIST-V20-LOCK.json','MANIFEST-SHA256.txt','OFFLINE-PAYLOAD-SHA256.txt'}
    assert {name for name in actual if not generated(name)}=={name for name in expected if not generated(name)}
    for name,wanted in expected.items():
        if not generated(name):assert actual[name]==wanted,name
    manifest={}
    for line in after.read(current['MANIFEST-SHA256.txt']).decode().splitlines():
        if not line.strip() or line.startswith('#'):continue
        wanted,name=line.split(' *',1);assert name not in manifest and actual[name]==wanted,name;manifest[name]=wanted
    assert set(manifest)==set(current)-{'MANIFEST-SHA256.txt'}
    lock=json.loads(after.read(current['DIST-V20-LOCK.json']))
    assert set(lock)=={name for name in actual if name.startswith('dist/')}
    assert all(actual[name]==wanted for name,wanted in lock.items())
    build_id=after.read(current['RELEASE-BUILD-ID.txt']).decode().strip();assert build_id==patch['buildId']=='V20.6-R14.4-PRINTER-FAULT-RECOVERY-2026-10-28'
    channel=json.loads(after.read(current['UPDATE-CHANNEL.json']))
    assert channel=={'endpoint':'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json','publicKeyHex':'28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb','channel':'stable','installedSequence':144}
    frontend=json.loads(after.read(current['dist/BUILD-PROVENANCE.json']))
    frontend_names=[name for name in actual if name.startswith('src/')]+['index.html','package.json','package-lock.json','tsconfig.json','vite.config.ts','RELEASE-BUILD-ID.txt','scripts/frontend-build-contract.mjs']
    frontend_inputs=[{'path':name,'sha256':actual[name]} for name in sorted(frontend_names,key=lambda value:value.encode('utf-16-be'))]
    frontend_sha=hashlib.sha256(json.dumps(frontend_inputs,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    assert frontend['sourceSha256']==frontend_sha and frontend['buildId']==build_id
    original_frontend=json.loads(before.read(original['dist/BUILD-PROVENANCE.json']))
    assert frontend['nativeCommandsSha256']==original_frontend['nativeCommandsSha256']
    unchanged=sum(not generated(name) and name not in {row['path'] for row in patch['files']} for name in original)
    native_source=root/'native-source';native_source.mkdir(exist_ok=True);after.extractall(native_source)
print('Verified complete source manifest, frontend provenance and',unchanged,'preserved baseline files',flush=True)
assert sha(root/'r142-build.zip')=='5cd0ca3227de93b894cd2ce0bd0a8d3bcb9f1660b8415144c620ba2c5d815369'
assert sha(root/'r142-required-tests.json')=='2fad3b15c11c24167f88c4bfd1d96b4938b5741a9a8b71218cd74bd2093d6623'
with zipfile.ZipFile(root/'r142-build.zip') as z:
    assert all('/' not in name and '\\' not in name for name in z.namelist());z.extractall(root/'r142-build')
helper=runpy.run_path(str(root/'r142-build/check-r142-acceptance.py'))
snapshot={name:actual[name] for name in sorted(actual) if helper['selected'](name)}
requirements=load(root/'r142-required-tests.json')
requirements['nodeChecks'].append({'script':'scripts/check-printer-fault-recovery.mjs','proofEnv':'KF_FAULT_PROOF','report':'r144-fault-behavior.json'})
requirements['browserChecks'].append({'script':'ui-tests/printer-return-r144.mjs','proofEnv':'KF_RETURN_PROOF','report':'r144-printer-return.json'})
requirements['acceptanceReports'] += [{'filename':'r144-fault-behavior.json','count':15,'casesField':'report','passedField':'passed','errorFields':[]},{'filename':'r144-printer-return.json','count':4,'casesField':'report','passedField':'passed','errorFields':[]}]
browser=incoming/'browser-evidence';counts={}
for spec in requirements['acceptanceReports']:
    report=load(find(browser,spec['filename']));helper['verify_cases'](report,spec);counts[spec['filename']]=spec['count']
    for field in ['productionSources','sourceSha256','sources']:
        if field in report:
            for name,wanted in report[field].items():assert actual[name]==wanted,(field,name)
    if 'source' in report:assert actual[report['source']['file']]==report['source']['sha256']
assert sum(counts.values())==239
for kind in ['node','browser']:
    ledger=load(find(browser,'r144-'+kind+'-executions.json'))
    assert ledger['release']=='R144' and ledger['kind']==kind and ledger['passed'] is True and ledger['sourceUnchangedDuringRun'] is True
    assert ledger['githubRunId']==str(contract['buildRunId']) and ledger['githubHeadSha']==contract['buildHeadSha'] and ledger['buildId']==build_id
    assert ledger['sourceSnapshot']==snapshot and ledger['sourceSnapshotSha256']==object_sha(snapshot)
    assert ledger['contractSha256']==sha(root/'r142-required-tests.json') and ledger['extensionSourcePatchSha256']==contract['sourcePatchSha256']
    assert len(ledger['checks'])==len(requirements[kind+'Checks'])==7
    for spec,check in zip(requirements[kind+'Checks'],ledger['checks']):
        assert check['script']==spec['script'] and check['report']==spec['report'] and check['proofEnv']==spec['proofEnv']
        assert check['scriptSha256']==snapshot[check['script']] and check['passed'] is True and check['exitCode']==0
        assert sha(find(browser,check['report']))==check['reportSha256'] and sha(find(browser,check['log']))==check['logSha256']
native=incoming/'native-evidence';native_report=load(find(native,'r144-native-acceptance.json'))
assert native_report['sourceSnapshotSha256']==object_sha(snapshot) and native_report['sourcePatchSha256']==contract['sourcePatchSha256']
assert native_report['result']['rootPassed']==238 and native_report['result']['rootFailed']==0 and native_report['result']['rootIgnored']==2 and native_report['result']['newNativeCases']==6
assert sha(find(native,'native-tests.log'))==native_report['result']['nativeLogSha256']
installed=incoming/'installed-evidence';validation=load(find(installed,'exact-validation.json'))
assert validation['candidate']=='R144' and validation['passed'] is True and validation['upgradeFrom']==143
for name in ['buildRunId','validationRunId']:assert str(validation[name])==str(contract['buildRunId'])
for name in ['buildHeadSha','validationHeadSha']:assert validation[name]==contract['buildHeadSha']
for flag in ['cleanInstallVerified','exactInstalledBytesVerified','installedRestartVerified','businessDataPreserved']:assert validation[flag] is True
for name in ['clean-installed-payload.json','installed-payload.json','installed-payload-after-restart.json']:
    payload=load(find(installed,name));assert payload['passed'] is True and payload['installedSequence']==144 and payload['embeddedUpdateChannelVerified'] is True
    for row in payload['binaries'].values():assert row['installedSha256']==row['packagedSha256']==row['expectedInstalledSha256']
fullscreen=load(find(installed,'installed-fullscreen-report.json'))
assert fullscreen['release']=='R144' and fullscreen['passed'] is True and fullscreen['passedCases']==5 and fullscreen['configuredPrinters']==7
assert fullscreen['actualWindowsWindowManager'] is True and fullscreen['actualInstalledWebView'] is True
for name in ['upgrade-data-seed.json','baseline-data-preserved.json','upgrade-data-before-fullscreen.json','upgrade-data-after-profiling.json','upgrade-data-after-restart.json']:
    report=load(find(installed,name));assert report['passed'] is True,name
result={'schemaVersion':1,'candidate':'R144','passed':True,'buildRunId':contract['buildRunId'],'buildHeadSha':contract['buildHeadSha'],'sourcePatchSha256':contract['sourcePatchSha256'],'sourceFiles':len(actual),'unchangedBaselineFiles':unchanged,'functionalCases':239,'nativeRootPassed':238,'nativeRootIgnored':2,'newNativeCases':6,'installedFullscreenCases':5,'actualInstalledWebView':True,'businessDataPreserved':True,'physicalPrintersTested':False,'assets':contract['assets']}
(incoming/'r144-final-verification.json').write_text(json.dumps(result,indent=2)+'\n')
for name in contract['assets']:shutil.copyfile(candidate/name,incoming/name)
for name in ['provenance.json']:shutil.copyfile(candidate/name,incoming/name)
shutil.copyfile(find(installed,'exact-validation.json'),incoming/'exact-validation.json')
shutil.copyfile(find(installed,'R144-UI-proof.zip'),incoming/'R144-UI-proof.zip')
print(json.dumps(result),flush=True)
