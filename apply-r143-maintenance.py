"""Apply the reviewed maintenance delta to the exact published R142 archive."""
import argparse
import base64
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
parser.add_argument('destination', type=Path)
parser.add_argument('--changes', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--proof', type=Path, required=True)
args = parser.parse_args()
def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
contract = json.loads(args.changes.read_text(encoding='utf-8-sig'))
assert contract['baseline']['sha256'] == 'fcbc447944bf8c96d2ecc7f8b27d623e655681cccd71381d8833e49693ca36b4'
assert args.archive.stat().st_size == contract['baseline']['sizeBytes'] == 582467357
with args.archive.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == contract['baseline']['sha256']
assert not args.destination.exists() and not args.baseline.exists(), 'Use fresh owned directories'
prefix = 'Klipper-Farm-R142/'
args.baseline.mkdir(parents=True)
with zipfile.ZipFile(args.archive) as archive:
    names = set()
    for info in archive.infolist():
        assert info.filename.startswith(prefix), info.filename
        relative = info.filename[len(prefix):]
        if not relative:
            assert info.is_dir()
            continue
        name = Path(relative)
        assert not name.is_absolute() and '..' not in name.parts and '\\' not in relative
        assert relative not in names and (info.external_attr >> 16) & 0o170000 != 0o120000
        names.add(relative)
        target = args.baseline / name
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, target.open('wb') as destination:
                shutil.copyfileobj(source, destination)
shutil.copytree(args.baseline, args.destination)
changed = []
for row in contract['files']:
    name = Path(row['path'])
    assert not name.is_absolute() and '..' not in name.parts and '\\' not in row['path']
    assert name.parts[0] in ['src', 'src-tauri', 'scripts', 'ui-tests'] or row['path'] in ['package.json', 'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json']
    target = args.destination / name
    if row['beforeSha256'] is None:
        assert not target.exists(), row['path']
    else:
        assert target.is_file() and digest(target) == row['beforeSha256'], row['path']
    data = base64.b64decode(row['contentBase64'], validate=True)
    assert hashlib.sha256(data).hexdigest() == row['sha256']
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    changed.append(row['path'])
expected = {row['path'] for row in contract['files']}
observed = set()
for target in args.destination.rglob('*'):
    if target.is_file():
        relative = target.relative_to(args.destination).as_posix()
        original = args.baseline / relative
        if not original.is_file() or target.stat().st_size != original.stat().st_size or digest(target) != digest(original):
            observed.add(relative)
for original in args.baseline.rglob('*'):
    if original.is_file():
        assert (args.destination / original.relative_to(args.baseline)).is_file(), 'A baseline file disappeared'
assert observed == expected, 'An unreviewed file changed during application'
report = {'passed': True, 'baselineArchiveSha256': contract['baseline']['sha256'], 'patchSha256': hashlib.sha256(args.changes.read_bytes()).hexdigest(),
          'changedFiles': changed, 'unchangedBaselinePreserved': True, 'candidateOnly': True, 'stablePublished': False}
args.proof.parent.mkdir(parents=True, exist_ok=True)
args.proof.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'passed': True, 'changedFiles': len(changed), 'candidateOnly': True}))
