"""Stage and publish only the exact verified R144 Windows assets; no private key in CI."""
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess,sys,urllib.request

root=Path.cwd();incoming=root/'incoming';repo='sanozhukov3737-oss/klipper-farm-updates';tag='r144-ota';public='28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
public_files=['Klipper-Farm-R144-setup.exe','KF-R144-FULL.zip','R144-UI-proof.zip','provenance.json','exact-validation.json','update-v20.json','r144-final-verification.json','promotion-attestation.json','r144-promotion-contract.json','native-bundle-verification.txt','update-sequence-verification.json','r144-release-notes.md','official-artifacts.json']
def load(path):return json.loads(Path(path).read_text(encoding='utf-8-sig'))
def sha(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def run(args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def api(path):return json.loads(subprocess.run(['gh','api','repos/'+repo+'/'+path],check=True,capture_output=True,text=True).stdout)
contract=load(root/'r144-promotion-contract.json')
assert sha(root/'r144-promotion-contract.json')==os.environ['KF_R144_CONTRACT_SHA256']
def previous():
    stable=api('releases/latest');assert stable['id']==contract['previousReleaseId'] and stable['tag_name']==contract['previousTag'] and not stable['draft'] and not stable['prerelease'],'Stable release changed during verification'
    feed=[row for row in stable['assets'] if row['name']=='update-v20.json'];assert len(feed)==1 and feed[0]['digest']=='sha256:'+contract['previousManifestSha256']
mode=sys.argv[1]
if mode=='prepare':
    previous();incoming.mkdir(exist_ok=True)
    run([sys.executable,'r144-download-artifacts.py'])
    run(['gh','release','download','r143-ota','--repo',repo,'--pattern','KF-R143-FULL.zip','--dir',str(incoming)])
    run([sys.executable,'r144-verify-candidate.py'])
    assert sha(root/'r144-signed-update.json')==contract['signedManifestSha256']
    for source,dest in [('r144-signed-update.json','update-v20.json'),('r144-promotion-contract.json','r144-promotion-contract.json'),('r144-release-notes.md','r144-release-notes.md')]:shutil.copyfile(root/source,incoming/dest)
    print('Exact source, Windows execution, installed upgrade and public manifest verified',flush=True)
elif mode=='bundle':
    run(['node','r144-verify-signed-update.mjs',str(incoming),str(root/'native-source/Klipper-Farm-R144')])
    verified=root/'verified';verified.mkdir(exist_ok=True)
    for name in public_files:shutil.copyfile(incoming/name,verified/name)
    (verified/'SHA256SUMS.txt').write_text('\n'.join(sha(verified/name)+' *'+name for name in sorted(public_files))+'\n')
    print('Verified and signed public release bundle prepared',flush=True)
elif mode=='publish':
    verified=root/'verified';assert load(verified/'r144-promotion-contract.json')==contract
    proof=load(verified/'promotion-attestation.json');assert proof['passed'] is True and proof['promotionHeadSha']==os.environ['GITHUB_SHA'] and proof['promotionRunId']==os.environ['GITHUB_RUN_ID']
    for name in ['ed25519SignatureVerified','productionRustUpdaterVerified','compiledArtifactBoundToInstalledValidation','embeddedInstalledSequenceVerified','sourceAndRegressionProofsVerified']:assert proof[name] is True
    for name,pin in contract['assets'].items():assert sha(verified/name)==pin['sha256'] and (verified/name).stat().st_size==pin['sizeBytes']
    assert sha(verified/'update-v20.json')==contract['signedManifestSha256']
    for line in (verified/'SHA256SUMS.txt').read_text().splitlines():
        wanted,name=line.split(' *',1);assert name in public_files and sha(verified/name)==wanted
    previous()
    names=public_files+['SHA256SUMS.txt'];upload={name:{'sha256':sha(verified/name),'sizeBytes':(verified/name).stat().st_size} for name in names}
    run(['gh','release','create',tag,*[str(verified/name) for name in names],'--repo',repo,'--target',contract['buildHeadSha'],'--prerelease','--latest=false','--title','Klipper Farm R144 — ошибки принтеров и восстановление связи','--notes-file',str(verified/'r144-release-notes.md')])
    release=api('releases/tags/'+tag);assert release['prerelease'] and not release['draft'] and release['target_commitish']==contract['buildHeadSha']
    for name,pin in upload.items():
        found=[row for row in release['assets'] if row['name']==name];assert len(found)==1 and found[0]['digest']=='sha256:'+pin['sha256'] and found[0]['size']==pin['sizeBytes'],name
    target=api('git/ref/tags/'+tag)['object']
    if target['type']=='tag':target=api('git/tags/'+target['sha'])['object']
    assert target['type']=='commit' and target['sha']==contract['buildHeadSha']
    previous()
    run(['gh','release','edit',tag,'--repo',repo,'--prerelease=false','--latest','--title','Klipper Farm R144 — ошибки принтеров и восстановление связи','--notes-file',str(verified/'r144-release-notes.md')])
    latest=api('releases/latest');assert latest['id']==release['id'] and not latest['draft'] and not latest['prerelease']
    def download(url,path):
        assert url.startswith('https://github.com/'+repo+'/releases/')
        request=urllib.request.Request(url,headers={'Cache-Control':'no-cache','User-Agent':'Klipper-Farm-public-updater-verification'})
        with urllib.request.urlopen(request,timeout=90) as response,Path(path).open('wb') as output:shutil.copyfileobj(response,output)
    download('https://github.com/'+repo+'/releases/latest/download/update-v20.json',verified/'public-update-v20.json')
    assert sha(verified/'public-update-v20.json')==contract['signedManifestSha256']
    manifest=load(verified/'public-update-v20.json');download(manifest['artifact']['url'],verified/'public-installer.exe')
    run([str(verified/'verify_bundle.exe'),str(verified/'public-update-v20.json'),str(verified/'public-installer.exe'),public,'stable',str(int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000))])
    result={'passed':True,'sequence':144,'releaseId':latest['id'],'manifestSha256':sha(verified/'public-update-v20.json'),'installerSha256':sha(verified/'public-installer.exe'),'publicApplicationEndpointVerified':True,'productionRustUpdaterVerified':True,'buildRunId':contract['buildRunId'],'promotionRunId':os.environ['GITHUB_RUN_ID']}
    (verified/'public-channel-verification.json').write_text(json.dumps(result,indent=2)+'\n')
    run(['gh','release','upload',tag,str(verified/'public-channel-verification.json'),'--repo',repo]);print(json.dumps(result),flush=True)
else:raise SystemExit('Unknown release stage')
