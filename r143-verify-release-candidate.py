"""Independently bind the R143 source, Windows build and installed proofs."""
from pathlib import Path,PurePosixPath
import json,hashlib,zipfile,base64,runpy,re,sys
ROOT=Path(__file__).resolve().parent
INCOMING=Path(sys.argv[1])
BUILD_RUN=40493325596
BUILD_HEAD='f0301942b97aadb1ca4ee12c84ee7a8a1fbb9011'
INSTALL_RUN=40493679785
INSTALL_HEAD='7e9bc5176e44626fb59a67bd6fb68c9c2ab6b52a'
PATCH_SHA='7f7b70c0f34937589a2e1c2559c13652a9372c6acc665659e2079f1f6e045d8a'
BASE_SHA='fcbc447944bf8c96d2ecc7f8b27d623e655681cccd71381d8833e49693ca36b4'
BUILD_ID='V20.6-R14.3-PERFORMANCE-MAINTENANCE-2026-10-27'
PUBLIC='28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
sha=lambda data:hashlib.sha256(data).hexdigest()
def file_sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def load(p):return json.loads(Path(p).read_text(encoding='utf-8-sig'))
def entries(z,prefix=''):
 result={};fold=set()
 for row in z.infolist():
  assert row.filename.startswith(prefix),row.filename
  name=row.filename[len(prefix):];path=PurePosixPath(name)
  if not name or row.is_dir():continue
  assert not path.is_absolute() and '..' not in path.parts and '\\' not in name and ':' not in name
  assert name not in result and name.casefold() not in fold
  assert (row.external_attr>>16)&0o170000!=0o120000
  result[name]=row;fold.add(name.casefold())
 return result
def report(z,name):
 hits=[row for row in z.namelist() if PurePosixPath(row).name==name];assert len(hits)==1,(name,hits)
 return json.loads(z.read(hits[0]).decode('utf-8-sig'))
def raw(z,name):
 hits=[row for row in z.namelist() if PurePosixPath(row).name==name];assert len(hits)==1,name
 return z.read(hits[0])
def artifact(kind,name,run,head):
 meta=load(INCOMING/(kind+'-artifact.json'))
 assert meta['name']==name and meta['expired'] is False
 assert meta['workflow_run']['id']==run and meta['workflow_run']['head_sha']==head
 path=INCOMING/(kind+'.zip')
 assert path.stat().st_size==meta['size_in_bytes'] and 'sha256:'+file_sha(path)==meta['digest']
 return meta
helper_path=ROOT/'r142-build/check-r142-acceptance.py'
assert file_sha(helper_path)=='fa7e077beaba123ea31d8c984d9a498489ce626abf5a7983dcd5be6e9b7e5dc5'
helper=runpy.run_path(str(helper_path));requirements=load(ROOT/'r142-required-tests.json')
assert file_sha(ROOT/'r142-required-tests.json')=='2fad3b15c11c24167f88c4bfd1d96b4938b5741a9a8b71218cd74bd2093d6623'
patch=load(ROOT/'r143-source-changes-v2.json');assert file_sha(ROOT/'r143-source-changes-v2.json')==PATCH_SHA
assert len(patch['files'])==31 and len({row['path'] for row in patch['files']})==31
for kind,run,head,workflow,jobs_wanted in [('build',BUILD_RUN,BUILD_HEAD,'.github/workflows/windows-r143-build-v2.yml',{'build','browser'}),('installed',INSTALL_RUN,INSTALL_HEAD,'.github/workflows/windows-r143-installed.yml',{'installed'})]:
 value=load(INCOMING/(kind+'-run.json'));jobs=load(INCOMING/(kind+'-jobs.json'))['jobs']
 assert value['id']==run and value['head_sha']==head and value['path']==workflow
 assert value['status']=='completed' and value['conclusion']=='success' and value['head_branch']=='r143-code-maintenance'
 assert {job['name'] for job in jobs}==jobs_wanted
 for job in jobs:
  assert job['run_id']==run and job['head_sha']==head and job['status']=='completed' and job['conclusion']=='success'
  assert all(s['conclusion']=='success' for s in job['steps'] if not s['name'].startswith('Post '))
source=INCOMING/'KF-R143-FULL.zip';baseline=INCOMING/'KF-R142-FULL.zip';installer=INCOMING/'Klipper-Farm-R143-setup.exe'
assert file_sha(baseline)==BASE_SHA and baseline.stat().st_size==582467357
provenance=load(INCOMING/'provenance.json');validation=load(INCOMING/'exact-validation.json')
assert provenance['sequence']==143 and str(provenance['buildRunId'])==str(BUILD_RUN) and provenance['buildHeadSha']==BUILD_HEAD
assert provenance['sourcePatchSha256']==PATCH_SHA and provenance['stablePublished'] is False
for name,path in [('KF-R143-FULL.zip',source),('Klipper-Farm-R143-candidate.exe',installer)]:
 spec=provenance['assets'][name];assert file_sha(path)==spec['sha256'] and path.stat().st_size==spec['sizeBytes']
assert validation['candidate']=='R143' and validation['passed'] is True and validation['stablePublished'] is False
for key,value in [('buildRunId',BUILD_RUN),('validationRunId',INSTALL_RUN)]:assert str(validation[key])==str(value)
assert validation['buildHeadSha']==BUILD_HEAD and validation['validationHeadSha']==INSTALL_HEAD and validation['upgradeFrom']==142
for flag in ['cleanInstallVerified','exactInstalledBytesVerified','installedRestartVerified','businessDataPreserved']:assert validation[flag] is True
assert validation['installedTvFullscreenCases']==5 and validation['installedProcessPerformanceBudgets']==9
artifact('native-evidence','r143-native-build-evidence',BUILD_RUN,BUILD_HEAD)
artifact('browser-evidence','r143-browser-performance-evidence',BUILD_RUN,BUILD_HEAD)
artifact('installed-evidence','r143-installed-windows-evidence',INSTALL_RUN,INSTALL_HEAD)
artifact('reviewed-installer','r143-reviewed-installer',INSTALL_RUN,INSTALL_HEAD)
with zipfile.ZipFile(INCOMING/'reviewed-installer.zip') as reviewed:
 assert sha(reviewed.read('provenance.json'))==file_sha(INCOMING/'provenance.json')
 assert sha(reviewed.read('exact-validation.json'))==file_sha(INCOMING/'exact-validation.json')
 with reviewed.open('Klipper-Farm-R143-candidate.exe') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==file_sha(installer)
print('Verified exact successful Windows runs, artifact digests and installed asset hashes',flush=True)
with zipfile.ZipFile(source) as now,zipfile.ZipFile(baseline) as before:
 current=entries(now,'Klipper-Farm-R143/');original=entries(before,'Klipper-Farm-R142/')
 def hashes(z,mapping):
  out={}
  for name,item in mapping.items():
   with z.open(item) as f:out[name]=hashlib.file_digest(f,'sha256').hexdigest()
  return out
 old_hashes=hashes(before,original);current_hashes=hashes(now,current);expected=dict(old_hashes)
 for row in patch['files']:
  assert row['beforeSha256']==old_hashes.get(row['path']),row['path']
  assert sha(base64.b64decode(row['contentBase64'],validate=True))==row['sha256']
  expected[row['path']]=row['sha256'];assert current_hashes[row['path']]==row['sha256'],row['path']
 generated=lambda name:name.startswith('dist/') or name in {'DIST-V20-LOCK.json','MANIFEST-SHA256.txt','OFFLINE-PAYLOAD-SHA256.txt'}
 assert {name for name in current_hashes if not generated(name)}=={name for name in expected if not generated(name)}
 for name,wanted in expected.items():
  if not generated(name):assert current_hashes[name]==wanted,name
 manifest={}
 for line in now.read(current['MANIFEST-SHA256.txt']).decode().splitlines():
  if not line.strip() or line.startswith('#'):continue
  wanted,name=line.split(' *',1);assert name not in manifest and current_hashes[name]==wanted,name;manifest[name]=wanted
 assert set(manifest)==set(current)-{'MANIFEST-SHA256.txt'}
 assert now.read(current['RELEASE-BUILD-ID.txt']).decode().strip()==BUILD_ID
 channel=json.loads(now.read(current['UPDATE-CHANNEL.json']));assert channel=={'endpoint':'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json','publicKeyHex':PUBLIC,'channel':'stable','installedSequence':143}
 snapshot={name:current_hashes[name] for name in sorted(current_hashes) if helper['selected'](name)}
 unchanged=sum(not generated(name) and name not in {r['path'] for r in patch['files']} for name in original)
 print('Verified complete source manifest and preservation of',unchanged,'baseline files',flush=True)
 with zipfile.ZipFile(INCOMING/'browser-evidence.zip') as browser:
  counts={}
  for spec in requirements['acceptanceReports']:
   value=report(browser,spec['filename']);helper['verify_cases'](value,spec);counts[spec['filename']]=spec['count']
   for field in ['productionSources','sourceSha256','sources']:
    if field in value:
     for name,wanted in value[field].items():assert current_hashes[name]==wanted,(field,name)
   if 'source' in value:assert current_hashes[value['source']['file']]==value['source']['sha256']
  assert sum(counts.values())==220
  for kind in ['node','browser']:
   ledger=report(browser,requirements['executionLedgers'][kind]);assert ledger['release']=='R143-maintenance' and ledger['kind']==kind
   assert ledger['passed'] is True and ledger['sourceUnchangedDuringRun'] is True and ledger['buildId']==BUILD_ID
   assert ledger['githubRunId']==str(BUILD_RUN) and ledger['githubHeadSha']==BUILD_HEAD
   assert ledger['sourceSnapshot']==snapshot and ledger['sourceSnapshotSha256']==helper['object_sha'](snapshot)
   assert ledger['contractSha256']==file_sha(ROOT/'r142-required-tests.json')
   assert len(ledger['checks'])==len(requirements[kind+'Checks'])==6
   for wanted,actual in zip(requirements[kind+'Checks'],ledger['checks']):
    assert actual['script']==wanted['script'] and actual['report']==wanted['report'] and actual['proofEnv']==wanted['proofEnv']
    assert actual['scriptSha256']==snapshot[actual['script']] and actual['exitCode']==0 and actual['passed'] is True
    assert sha(raw(browser,actual['report']))==actual['reportSha256'] and sha(raw(browser,actual['log']))==actual['logSha256']
  geometry=report(browser,'spool-geometry-comparison.json');assert geometry['passed'] is True and geometry['cases']==6
  assert geometry['exactGpuUploadsMatch'] is True and geometry['renderedImagesWithinRepeatability'] is True and geometry['errors']==geometry['externalRequests']==[]
  assert geometry['sourceSha256']['current']==current_hashes['src/lib/spool-viewer.mjs'] and geometry['sourceSha256']['staging']==current_hashes['src/lib/spoolGeometryBuffer.mjs']
  for old,new in zip(geometry['results']['baseline'],geometry['results']['current']):assert old['uploads']==new['uploads'] and old['vertices']==new['vertices']
  theme=report(browser,'theme-equivalence.json');assert theme['passed'] is True and len(theme['cases'])==30 and theme['errors']==[]
  performance=report(browser,'performance-comparison.json');assert performance['passed'] is True and len(performance['caps'])==9 and performance['runtimeErrors']==performance['externalRequests']==[]
  assert performance['environment']['platform']=='win32'
  limits={'readyMs':(1.5,600),'peakTrackedAllocationsBytes':(1.15,16*1024**2),'scriptSeconds':(1.25,.5)}
  assert {(c['view'],c['metric']) for c in performance['caps']}=={(view,metric) for view in ['main','spool','tv'] for metric in limits}
  for cap in performance['caps']:
   old=performance['results']['baseline'][cap['view']][cap['metric']];new=performance['results']['current'][cap['view']][cap['metric']]
   factor,offset=limits[cap['metric']];assert cap['before']==old and cap['after']==new and cap['limit']==old*factor+offset and cap['passed'] is True and new<=cap['limit']
  camera=performance['results']['current']['tv'];assert camera['cameraSources']==7 and camera['activeStreamsAfterClose']==0 and camera['peakActiveStreams']<=2
 with zipfile.ZipFile(INCOMING/'native-evidence.zip') as native:
  log=raw(native,'native-tests.log');native_log=INCOMING/'native-tests-verified.log';native_log.write_bytes(log);native_result=helper['verify_native'](requirements,native_log)
  delta=report(native,'source-delta.json');assert delta['passed'] is True and delta['patchSha256']==PATCH_SHA and delta['baselineArchiveSha256']==BASE_SHA
  assert set(delta['changedFiles'])=={row['path'] for row in patch['files']} and delta['unchangedBaselinePreserved'] is True
with zipfile.ZipFile(INCOMING/'installed-evidence.zip') as installed:
 payload=report(installed,'installed-payload.json');assert payload==report(installed,'installed-payload-after-restart.json')==report(installed,'clean-installed-payload.json')
 assert payload['passed'] is True and payload['installedSequence']==143 and payload['embeddedUpdateChannelVerified'] is True
 assert set(payload['binaries'])=={'klipper-farm-client.exe','klipper-farmd.exe'}
 for value in payload['binaries'].values():assert value['installedSha256']==value['packagedSha256']==value['expectedInstalledSha256']
 client_sha=payload['binaries']['klipper-farm-client.exe']['installedSha256']
 fullscreen=report(installed,'installed-fullscreen-report.json');assert fullscreen['passed'] is True and fullscreen['passedCases']==5 and fullscreen['release']=='R143'
 assert fullscreen['configuredPrinters']==7 and fullscreen['client']['sha256']==client_sha and fullscreen['runtimeErrors']==[]
 for flag in ['actualInstalledWebView','actualWindowsWindowManager','actualFullscreenStateVerified','nativeWindowCallsReal','domFullscreenNeverUsed']:assert fullscreen[flag] is True
 assert len(fullscreen['cases'])==5 and all(case['passed'] is True for case in fullscreen['cases'])
 for case in fullscreen['cases']:
  before,expanded,after=(case[name] for name in ['before','expanded','after'])
  assert expanded['native']['fullscreen'] is True and expanded['native']['domFullscreen'] is False and before['native']['tvMounted'] is after['native']['tvMounted'] is False
  assert after['native']['fullscreen']==before['native']['fullscreen']
  if not case['id'].startswith('borrowed-'):assert after['native']['maximized']==before['native']['maximized']
  for key in ['left','top','right','bottom']:
   assert abs(expanded['win32']['bounds'][key]-expanded['win32']['monitor'][key])<=3
   assert abs(after['win32']['bounds'][key]-before['win32']['bounds'][key])<=2
 seed=report(installed,'upgrade-data-seed.json');assert seed['passed'] is True
 for name in ['baseline-data-preserved.json','upgrade-data-before-fullscreen.json','upgrade-data-after-profiling.json','upgrade-data-after-restart.json']:
  value=report(installed,name);assert value['passed'] is True and value['rows']==seed['rows'] and value['printerCount']==7 and value['spoolCount']==2 and value['sqliteIntegrity']=='ok'
 runtime=report(installed,'headless-runtime.json');assert runtime['passed'] is True and runtime['registeredPrinters']==7
 for flag in ['staleCommandRejected','offlineMemberIsolation','freshTelemetryAllHealthy','duplicatePhysicalAddressRejected']:assert runtime[flag] is True
 comparison=report(installed,'installed-performance-comparison.json');assert comparison['passed'] is True and len(comparison['checks'])==9 and all(c['passed'] is True and c['current']<=c['limit'] for c in comparison['checks'])
 profiles={}
 for name in installed.namelist():
  if PurePosixPath(name).name=='installed-performance.json':
   value=json.loads(installed.read(name));profiles[value['label']]=value
 assert set(profiles)=={'R142','R143'} and profiles['R143']['client']['sha256']==client_sha
 for value in profiles.values():assert value['passed'] is True and value['actualInstalledWebView'] is True and value['wholeApplicationProcessTreeSampled'] is True and value['configuredPrinters']==7 and len(value['phases'])==3 and value['runtimeErrors']==[]
 for check in comparison['checks']:
  old=next(v for v in profiles['R142']['phases'] if v['name']==check['phase']);new=next(v for v in profiles['R143']['phases'] if v['name']==check['phase']);assert check['baseline']==old[check['metric']] and check['current']==new[check['metric']]
result={'schemaVersion':1,'candidate':'R143','passed':True,'repository':'sanozhukov3737-oss/klipper-farm-updates','buildRunId':BUILD_RUN,'buildHeadSha':BUILD_HEAD,'validationRunId':INSTALL_RUN,'validationHeadSha':INSTALL_HEAD,'sourcePatchSha256':PATCH_SHA,'baselineArchiveSha256':BASE_SHA,'sourceFiles':len(current_hashes),'unchangedBaselineFiles':unchanged,'functionalCases':sum(counts.values()),'native':native_result,'themeCases':30,'spoolCases':6,'rendererPerformanceBudgets':9,'installedPerformanceBudgets':9,'installedFullscreenCases':5,'actualInstalledWebView':True,'businessDataPreserved':True,'physicalPrintersTested':False,'assets':{'KF-R143-FULL.zip':{'sha256':file_sha(source),'sizeBytes':source.stat().st_size},'Klipper-Farm-R143-setup.exe':{'sha256':file_sha(installer),'sizeBytes':installer.stat().st_size}}}
(INCOMING/'r143-final-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
