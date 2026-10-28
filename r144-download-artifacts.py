"""Fetch only artifacts from the exact successful Windows run and verify SHA256."""
import hashlib,json,os,pathlib,subprocess,zipfile,time

root=pathlib.Path.cwd();contract=json.loads((root/'r144-promotion-contract.json').read_text());repo=contract['repository'];out=root/'incoming';out.mkdir(exist_ok=True)
def api(path):return json.loads(subprocess.run(['gh','api','repos/'+repo+'/'+path],check=True,capture_output=True,text=True).stdout)
run=api('actions/runs/'+str(contract['buildRunId']))
assert run['status']=='completed'
assert run['head_sha']==contract['buildHeadSha'] and run['head_branch']=='r144-printer-fault-recovery' and run['path']=='.github/workflows/windows-r144.yml'
jobs=api('actions/runs/'+str(run['id'])+'/jobs?per_page=100')['jobs']
assert {job['name'] for job in jobs}=={'build','browser','installed'}
assert all(next(job for job in jobs if job['name']==name)['conclusion']=='success' for name in ['build','browser'])
validation=api('actions/runs/'+str(contract['validationRunId']))
assert validation['status']=='completed' and validation['conclusion']=='success'
assert validation['head_sha']==contract['validationHeadSha'] and validation['head_branch']=='r144-printer-fault-recovery' and validation['path']=='.github/workflows/windows-r144-installed.yml'
validation_jobs=api('actions/runs/'+str(validation['id'])+'/jobs?per_page=100')['jobs']
assert len(validation_jobs)==1 and validation_jobs[0]['name']=='installed' and validation_jobs[0]['conclusion']=='success'
validation_rows=api('actions/runs/'+str(validation['id'])+'/artifacts?per_page=100')['artifacts']
rows=api('actions/runs/'+str(run['id'])+'/artifacts?per_page=100')['artifacts'];evidence={}
for name,directory in [('r144-compiled-candidate','candidate'),('r144-native-build-evidence','native-evidence'),('r144-browser-evidence','browser-evidence'),('r144-installed-evidence','installed-evidence')]:
    origin=validation if directory=='installed-evidence' else run
    origin_rows=validation_rows if directory=='installed-evidence' else rows
    matches=[row for row in origin_rows if row['name']==name and not row['expired']];assert len(matches)==1,name
    row=matches[0];assert row['workflow_run']['id']==origin['id'] and row['workflow_run']['head_sha']==origin['head_sha']
    archive=out/(name+'.zip')
    cached=False
    if archive.exists() and archive.stat().st_size==row['size_in_bytes']:
        with archive.open('rb') as f:cached='sha256:'+hashlib.file_digest(f,'sha256').hexdigest()==row['digest']
    if not cached:
        for attempt in range(4):
            with archive.open('wb') as f:download=subprocess.run(['gh','api',f"repos/{repo}/actions/artifacts/{row['id']}/zip"],stdout=f)
            if download.returncode==0:break
            if attempt==3:download.check_returncode()
            time.sleep(3*(attempt+1))
    with archive.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
    assert archive.stat().st_size==row['size_in_bytes'] and row['digest']=='sha256:'+digest
    target=out/directory;target.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for entry in z.infolist():
            path=pathlib.PurePosixPath(entry.filename);assert not path.is_absolute() and '..' not in path.parts and '\\' not in entry.filename
        z.extractall(target)
    evidence[name]={'artifactId':row['id'],'runId':origin['id'],'headSha':origin['head_sha'],'sha256':digest,'sizeBytes':archive.stat().st_size}
    print('Verified official artifact',name,row['id'],digest,flush=True)
(out/'official-artifacts.json').write_text(json.dumps(evidence,indent=2)+'\n')
