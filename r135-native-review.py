from pathlib import Path,PurePosixPath
import hashlib,json,base64,zipfile
root=Path.cwd();p=root/'r135-native-review.json';assert hashlib.sha256(p.read_bytes()).hexdigest()=='aa6dc0aa0238aa3ae9ea518fea0eef5f96aee38d35ff217dffd50a1818a7a04a'
patch=json.loads(p.read_text());archive=root/'incoming/KF-R134-FULL.zip'
with archive.open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==patch['baseArchiveSha256']
assert archive.stat().st_size==582861134
with zipfile.ZipFile(archive) as z:
 for i in z.infolist():
  q=PurePosixPath(i.filename)
  assert i.filename.startswith('Klipper-Farm-R134/') and not q.is_absolute() and '..' not in q.parts and '\\' not in i.filename
  assert (i.external_attr>>16)&0o170000!=0o120000
 z.extractall(root/'work')
 app=root/'work/Klipper-Farm-R134'
 for row in patch['files']:
  p=app/row['path'];assert hashlib.sha256(p.read_bytes()).hexdigest()==row['beforeSha256']
  after=base64.b64decode(row['contentBase64'],validate=True);assert hashlib.sha256(after).hexdigest()==row['sha256'];p.write_bytes(after)
 changed={r['path'] for r in patch['files']}
 for i in z.infolist():
  if i.is_dir():continue
  n=i.filename.removeprefix('Klipper-Farm-R134/')
  if n not in changed:assert (app/n).read_bytes()==z.read(i),n
(root/'proof').mkdir(exist_ok=True)
(root/'proof/native-source-proof.json').write_text(json.dumps({'passed':True,'patchSha256':'aa6dc0aa0238aa3ae9ea518fea0eef5f96aee38d35ff217dffd50a1818a7a04a','baselineSha256':patch['baseArchiveSha256'],'onlyReviewedNativeFilesChanged':True,'files':[{k:v for k,v in row.items() if k!='contentBase64'} for row in patch['files']]},indent=2)+'\n')
print('Exact R134 restored; only two reviewed native files changed')
