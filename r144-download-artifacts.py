"""Fetch only artifacts from the exact successful Windows run and verify SHA256."""
import hashlib,json,os,pathlib,subprocess,zipfile

root=pathlib.Path.cwd();contract=json.loads((root/'r144-promotion-contract.json').read_text());repo=contract['repository'];out=root/'incoming';out.mkdir(exist_ok=True)
def api(path):return json.loads(subprocess.run(['gh','api','repos/'+repo+'/'+path],check=True,capture_output=True,text=True).stdout)
run=api('actions/runs/'+str(contract['buildRunId']))
assert run['status']=='completed' and run['conclusion']=='success'
assert run['head_sha']==contract['buildHeadSha'] and run['head_branch']=='r144-printer-fault-recovery' and run['path']=='.github/workflows/windows-r144.yml'
jobs=api('actions/runs/'+str(run['id'])+'/jobs?per_page=100')['jobs']
assert {job['name'] for job in jobs}=={'build','browser','installed'} and all(job['conclusion']=='success' for job in jobs)
rows=api('actions/runs/'+str(run['id'])+'/artifacts?per_page=100')['artifacts'];evidence={}
for name,directory in [('r144-compiled-candidate','candidate'),('r144-native-build-evidence','native-evidence'),('r144-browser-evidence','browser-evidence'),('r144-installed-evidence','installed-evidence')]:
    matches=[row for row in rows if row['name']==name and not row['expired']];assert len(matches)==1,name
    row=matches[0];assert row['workflow_run']['id']==run['id'] and row['workflow_run']['head_sha']==contract['buildHeadSha']
    archive=out/(name+'.zip')
    with archive.open('wb') as f:subprocess.run(['gh','api',f"repos/{repo}/actions/artifacts/{row['id']}/zip"],stdout=f,check=True)
    with archive.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
    assert archive.stat().st_size==row['size_in_bytes'] and row['digest']=='sha256:'+digest
    target=out/directory;target.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for entry in z.infolist():
            path=pathlib.PurePosixPath(entry.filename);assert not path.is_absolute() and '..' not in path.parts and '\\' not in entry.filename
        z.extractall(target)
    evidence[name]={'artifactId':row['id'],'runId':run['id'],'headSha':contract['buildHeadSha'],'sha256':digest,'sizeBytes':archive.stat().st_size}
    print('Verified official artifact',name,row['id'],digest,flush=True)
(out/'official-artifacts.json').write_text(json.dumps(evidence,indent=2)+'\n')
