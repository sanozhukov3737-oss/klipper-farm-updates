"""Download official Actions artifacts, verify their digests, extract named assets."""
from pathlib import Path
import subprocess,os,json,hashlib,zipfile,shutil,sys
ROOT=Path(__file__).resolve().parent;out=Path(os.environ.get('KF_RELEASE_INCOMING','/tmp/kf-r143-release-incoming'));out.mkdir(parents=True,exist_ok=True)
REPO='sanozhukov3737-oss/klipper-farm-updates';BUILD=40493325596;HEAD='f0301942b97aadb1ca4ee12c84ee7a8a1fbb9011';INSTALL=40493679785;IHEAD='7e9bc5176e44626fb59a67bd6fb68c9c2ab6b52a'
env=dict(os.environ);env.pop('GH_DEBUG',None);gh=os.environ.get('KF_GITHUB_CLI','gh')
if os.environ.get('KF_GITHUB_CONFIG'):env['GH_CONFIG_DIR']=os.environ['KF_GITHUB_CONFIG']
def api(endpoint):return json.loads(subprocess.run([gh,'api','repos/'+REPO+'/'+endpoint],env=env,capture_output=True,text=True,check=True).stdout)
def save(name,value):(out/name).write_text(json.dumps(value,indent=2)+'\n')
def digest(path):
 with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def artifact(row,kind,run,head):
 assert not row['expired'] and row['workflow_run']['id']==run and row['workflow_run']['head_sha']==head
 save(kind+'-artifact.json',row);path=out/(kind+'.zip')
 if not path.exists() or path.stat().st_size!=row['size_in_bytes'] or 'sha256:'+digest(path)!=row['digest']:
  temporary=path.with_suffix('.partial')
  with temporary.open('wb') as target:subprocess.run([gh,'api',f"repos/{REPO}/actions/artifacts/{row['id']}/zip"],stdout=target,env=env,check=True)
  assert temporary.stat().st_size==row['size_in_bytes'] and 'sha256:'+digest(temporary)==row['digest'],'Official artifact digest differs'
  temporary.replace(path)
 print('VERIFIED',kind,row['id'],row['size_in_bytes'],flush=True);return path
def select(rows,name):
 hits=[row for row in rows if row['name']==name and not row['expired']];assert len(hits)==1,name;return hits[0]
def write_entry(z,name,target):
 assert z.namelist().count(name)==1,name
 with z.open(name) as source,Path(target).open('wb') as destination:shutil.copyfileobj(source,destination)
mode=sys.argv[1];stage='installed' if mode=='installed' else 'build';run=INSTALL if stage=='installed' else BUILD;head=IHEAD if stage=='installed' else HEAD
record=api('actions/runs/'+str(run));assert record['head_sha']==head and record['status']=='completed' and record['conclusion']=='success'
save(stage+'-run.json',record);save(stage+'-jobs.json',api(f'actions/runs/{run}/jobs?per_page=100'));rows=api(f'actions/runs/{run}/artifacts?per_page=100')['artifacts']
if stage=='build':
 for kind,name in [('native-evidence','r143-native-build-evidence'),('browser-evidence','r143-browser-performance-evidence')]:artifact(select(rows,name),kind,run,head)
 compiled=artifact(select(rows,'r143-compiled-candidate'),'compiled-candidate',run,head)
 with zipfile.ZipFile(compiled) as z:
  p=json.loads(z.read('provenance.json').decode('utf-8-sig'));assert str(p['buildRunId'])==str(BUILD) and p['buildHeadSha']==HEAD and p['sourcePatchSha256']=='7f7b70c0f34937589a2e1c2559c13652a9372c6acc665659e2079f1f6e045d8a'
  for name,spec in p['assets'].items():
   item=z.getinfo(name)
   with z.open(item) as f:sha=hashlib.file_digest(f,'sha256').hexdigest()
   assert item.file_size==spec['sizeBytes'] and sha==spec['sha256'],name
  write_entry(z,'KF-R143-FULL.zip',out/'KF-R143-FULL.zip');write_entry(z,'provenance.json',out/'provenance.json')
  probes=[name for name in z.namelist() if name.endswith('/klipper-farm-ipc-probe.exe')];assert len(probes)==1
  write_entry(z,probes[0],out/'klipper-farm-ipc-probe.exe')
 save('compiled-artifact-inspection.json',{'passed':True,'artifactId':select(rows,'r143-compiled-candidate')['id'],'digest':select(rows,'r143-compiled-candidate')['digest'],'assets':p['assets']})
 compiled.unlink();print('Retained verified source archive and provenance; removed reproducible outer download',flush=True)
else:
 artifact(select(rows,'r143-installed-windows-evidence'),'installed-evidence',run,head)
 reviewed=artifact(select(rows,'r143-reviewed-installer'),'reviewed-installer',run,head)
 with zipfile.ZipFile(reviewed) as z:
  assert set(z.namelist())=={'Klipper-Farm-R143-candidate.exe','provenance.json','exact-validation.json','R143-UI-proof.zip'}
  origin=json.loads(z.read('provenance.json').decode('utf-8-sig'));assert str(origin['buildRunId'])==str(BUILD) and origin['buildHeadSha']==HEAD and origin['sourcePatchSha256']=='7f7b70c0f34937589a2e1c2559c13652a9372c6acc665659e2079f1f6e045d8a'
  if (out/'provenance.json').exists():assert origin==json.loads((out/'provenance.json').read_text(encoding='utf-8-sig'))
  else:write_entry(z,'provenance.json',out/'provenance.json')
  write_entry(z,'Klipper-Farm-R143-candidate.exe',out/'Klipper-Farm-R143-setup.exe')
  for name in ['exact-validation.json','R143-UI-proof.zip']:write_entry(z,name,out/name)
 print('Retained exact reviewed installer, upgrade evidence and provenance',flush=True)
print('READY',stage,flush=True)
