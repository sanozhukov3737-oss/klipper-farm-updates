"""R143 release orchestration. The signing key is never sent to Actions."""
from pathlib import Path
import subprocess,os,json,hashlib,zipfile,shutil,sys
ROOT=Path.cwd();INCOMING=ROOT/'incoming';REPO='sanozhukov3737-oss/klipper-farm-updates';TAG='r143-ota'
PUBLIC='28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
PUBLIC_FILES=['Klipper-Farm-R143-setup.exe','KF-R143-FULL.zip','R143-UI-proof.zip','provenance.json','exact-validation.json','update-v20.json','r143-final-verification.json','promotion-attestation.json','r143-promotion-contract.json','native-bundle-verification.txt','update-sequence-verification.json','r143-release-notes.md']
def load(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))
def sha(path):
 with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def run(args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def api(endpoint):return json.loads(subprocess.run(['gh','api','repos/'+REPO+'/'+endpoint],capture_output=True,text=True,check=True).stdout)
def previous(contract):
 value=api('releases/latest');assert value['id']==contract['previousReleaseId'] and value['tag_name']==contract['previousTag'] and not value['draft'] and not value['prerelease'],'Stable release changed'
 manifests=[v for v in value['assets'] if v['name']=='update-v20.json'];assert len(manifests)==1 and manifests[0]['digest']=='sha256:'+contract['previousManifestSha256'],'Previous stable manifest changed'
contract=load(ROOT/'r143-promotion-contract.json')
assert sha(ROOT/'r143-promotion-contract.json')==os.environ['KF_R143_CONTRACT_SHA256'],'Promotion contract differs'
mode=sys.argv[1]
if mode=='prepare':
 previous(contract);INCOMING.mkdir(exist_ok=True)
 os.environ['KF_RELEASE_INCOMING']=str(INCOMING)
 for stage in ['build','installed']:run([sys.executable,'r143-download-release-evidence.py',stage])
 run(['gh','release','download',contract['previousTag'],'--repo',REPO,'--pattern','KF-R142-FULL.zip','--dir',str(INCOMING)])
 assert sha(ROOT/'r142-build.zip')=='5cd0ca3227de93b894cd2ce0bd0a8d3bcb9f1660b8415144c620ba2c5d815369'
 with zipfile.ZipFile(ROOT/'r142-build.zip') as z:
  for name in z.namelist():assert '/' not in name and '\\' not in name and name not in ('.','..')
  z.extractall(ROOT/'r142-build')
 run([sys.executable,'r143-verify-release-candidate.py',str(INCOMING)])
 inspection=load(INCOMING/'r143-final-verification.json');assert inspection['assets']==contract['assets']
 assert sha(ROOT/'r143-signed-update.json')==contract['signedManifestSha256']
 for src,dest in [('r143-signed-update.json','update-v20.json'),('r143-promotion-contract.json','r143-promotion-contract.json'),('r143-release-notes.md','r143-release-notes.md')]:shutil.copyfile(ROOT/src,INCOMING/dest)
 with zipfile.ZipFile(INCOMING/'KF-R143-FULL.zip') as z:z.extractall(ROOT/'native-source')
 print('Exact source, installed evidence, signed manifest and existing stable release verified',flush=True)
elif mode=='bundle':
 run(['node','r143-verify-signed-update.mjs',str(INCOMING),str(ROOT/'native-source/Klipper-Farm-R143')])
 verified=ROOT/'verified';verified.mkdir(exist_ok=True)
 for name in PUBLIC_FILES:shutil.copyfile(INCOMING/name,verified/name)
 lines=[sha(verified/name)+' *'+name for name in sorted(PUBLIC_FILES)]
 (verified/'SHA256SUMS.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8')
 print('Verified public release bundle prepared',flush=True)
elif mode=='publish':
 verified=ROOT/'verified';pins=load(verified/'r143-promotion-contract.json');assert pins==contract
 proof=load(verified/'promotion-attestation.json');assert proof['passed'] and proof['promotionHeadSha']==os.environ['GITHUB_SHA'] and proof['promotionRunId']==os.environ['GITHUB_RUN_ID']
 for flag in ['ed25519SignatureVerified','productionRustUpdaterVerified','compiledArtifactBoundToInstalledValidation','embeddedInstalledSequenceVerified','sourceAndPerformanceProofsVerified']:assert proof[flag] is True
 for name,pin in contract['assets'].items():assert sha(verified/name)==pin['sha256'] and (verified/name).stat().st_size==pin['sizeBytes']
 assert sha(verified/'update-v20.json')==contract['signedManifestSha256']
 for line in (verified/'SHA256SUMS.txt').read_text().splitlines():
  wanted,name=line.split(' *',1);assert name in PUBLIC_FILES and sha(verified/name)==wanted,name
 previous(contract)
 names=PUBLIC_FILES+['SHA256SUMS.txt'];upload={name:{'sha256':sha(verified/name),'sizeBytes':(verified/name).stat().st_size} for name in names}
 run(['gh','release','create',TAG,*[str(verified/name) for name in names],'--repo',REPO,'--target',contract['buildHeadSha'],'--prerelease','--latest=false','--title','Klipper Farm R143 — производительность и устойчивость','--notes-file',str(verified/'r143-release-notes.md')])
 release=api('releases/tags/'+TAG);assert release['prerelease'] and not release['draft'] and release['target_commitish']==contract['buildHeadSha']
 for name,pin in upload.items():
  found=[row for row in release['assets'] if row['name']==name];assert len(found)==1 and found[0]['digest']=='sha256:'+pin['sha256'] and found[0]['size']==pin['sizeBytes'],name
 tag=api('git/ref/tags/'+TAG)['object']
 if tag['type']=='tag':tag=api('git/tags/'+tag['sha'])['object']
 assert tag['type']=='commit' and tag['sha']==contract['buildHeadSha']
 previous(contract)
 run(['gh','release','edit',TAG,'--repo',REPO,'--prerelease=false','--latest','--title','Klipper Farm R143 — производительность и устойчивость','--notes-file',str(verified/'r143-release-notes.md')])
 latest=api('releases/latest');assert latest['id']==release['id'] and not latest['draft'] and not latest['prerelease']
 import urllib.request,datetime
 def download(url,path):
  assert url.startswith('https://github.com/'+REPO+'/releases/')
  with urllib.request.urlopen(url,timeout=180) as source,Path(path).open('wb') as dest:shutil.copyfileobj(source,dest)
 download('https://github.com/'+REPO+'/releases/latest/download/update-v20.json',verified/'public-update-v20.json')
 assert sha(verified/'public-update-v20.json')==contract['signedManifestSha256']
 manifest=load(verified/'public-update-v20.json');download(manifest['artifact']['url'],verified/'public-installer.exe')
 run([str(verified/'verify_bundle.exe'),str(verified/'public-update-v20.json'),str(verified/'public-installer.exe'),PUBLIC,'stable',str(int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000))])
 result={'passed':True,'sequence':143,'releaseId':latest['id'],'manifestSha256':sha(verified/'public-update-v20.json'),'installerSha256':sha(verified/'public-installer.exe'),'publicApplicationEndpointVerified':True,'productionRustUpdaterVerified':True,'buildRunId':contract['buildRunId'],'validationRunId':contract['validationRunId'],'promotionRunId':os.environ['GITHUB_RUN_ID']}
 (verified/'public-channel-verification.json').write_text(json.dumps(result,indent=2)+'\n')
 run(['gh','release','upload',TAG,str(verified/'public-channel-verification.json'),'--repo',REPO]);print(json.dumps(result),flush=True)
else:raise SystemExit('Unknown promotion stage')
