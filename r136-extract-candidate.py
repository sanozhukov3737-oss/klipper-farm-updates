import hashlib,json,sys,zipfile
from pathlib import Path
p=Path(sys.argv[1]);c=json.loads(Path(sys.argv[2]).read_text());a=p/'validated-artifact.zip'
with a.open('rb') as f: digest='sha256:'+hashlib.file_digest(f,'sha256').hexdigest()
assert digest==c['sourceArtifactDigest'] and a.stat().st_size==c['sourceArtifactSizeBytes']
expected={'Klipper-Farm-R136-setup.exe','KF-R136-FULL.zip','provenance.json','exact-validation.json','R136-UI-proof.zip'}
with zipfile.ZipFile(a) as z:
 assert len(z.infolist())==5 and set(z.namelist())==expected
 for info in z.infolist():
  assert not info.is_dir() and (info.external_attr>>16)&0o170000!=0o120000
  with z.open(info) as source,(p/info.filename).open('wb') as target:
   import shutil
   shutil.copyfileobj(source,target)
(p/'artifact-archive-verification.json').write_text(json.dumps({'passed':True,'artifactDigest':digest,'sizeBytes':a.stat().st_size,'files':sorted(expected)},indent=2)+'\n')
a.unlink()
print('Exact validated artifact archive verified and extracted')
