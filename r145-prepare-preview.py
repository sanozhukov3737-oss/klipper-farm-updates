from pathlib import Path,PurePosixPath
import hashlib,json,sys,zipfile
base=Path('incoming/KF-R144-FULL.zip');patch=Path('r145-offline-voice-preview.zip');app=Path('work/app');app.mkdir(parents=True,exist_ok=True)
def sha(p):
 with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
assert base.stat().st_size==582509062 and sha(base)=='c7c52debd6e09ab4f266b4f0a2426aa10ec738e41e7e138dc7a292a4480f81cc'
review=json.loads(Path('r145-voice-review.json').read_text());assert sha(patch)==review['archiveSha256']
with zipfile.ZipFile(base) as z:
 for entry in z.infolist():
  path=PurePosixPath(entry.filename);assert path.parts[0]=='Klipper-Farm-R144' and '..' not in path.parts and '\\' not in entry.filename
  target=app.joinpath(*path.parts[1:])
  if entry.is_dir():target.mkdir(parents=True,exist_ok=True)
  elif len(path.parts)>1:target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(z.read(entry))
with zipfile.ZipFile(patch) as z:
 manifest=json.loads(z.read('source-manifest.json'))
 for row in manifest['files']:
  path=PurePosixPath(row['path']);assert not path.is_absolute() and '..' not in path.parts
  dest=app.joinpath(*path.parts)
  assert (sha(dest) if dest.exists() else None)==row['beforeSha256'],row['path']
  data=z.read('changes/'+row['path']);assert hashlib.sha256(data).hexdigest()==row['sha256']
 for row in manifest['files']:
  dest=app/row['path'];dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(z.read('changes/'+row['path']))
identity='V20.6-R14.5-OFFLINE-VOICE-PREVIEW-2026-10-28'
(app/'RELEASE-BUILD-ID.txt').write_text(identity+'\n')
for name in ['scripts/check-r9-clean-installer.mjs','scripts/check-release-portability.mjs']:
 p=app/name;p.write_text(p.read_text().replace('V20.6-R14.4-PRINTER-FAULT-RECOVERY-2026-10-28',identity))
p=app/'scripts/build-and-install-windows.mjs';p.write_text(p.read_text().replace('R144 Printer Fault Recovery','R145 Offline Voice Preview'))
assert json.loads((app/'UPDATE-CHANNEL.json').read_text())['installedSequence']==144
print('Applied reviewed voice source to exact R144, stamped preview identity; stable updater sequence remains 144')
