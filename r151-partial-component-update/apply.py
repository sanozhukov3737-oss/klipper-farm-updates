"""Apply the reviewed R151 partial component-update source over the exact sequence-150 candidate.

Makes updates download only the runtime archive entries that actually changed
(HTTP range reads of the zip central directory plus raw-deflate extraction of the
few modified files) instead of the full ~600 MB runtime on every update, and
hardens the online-update applier so the app is always restarted after the
installer finishes, with a watchdog that recovers the app even when the NSIS
installer hangs. No publication.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 145}
if channel not in (expected_channel, dict(expected_channel, installedSequence=146), dict(expected_channel, installedSequence=147), dict(expected_channel, installedSequence=148), dict(expected_channel, installedSequence=149), dict(expected_channel, installedSequence=150), dict(expected_channel, installedSequence=151)):
    raise SystemExit('Expected exact unchanged trust channel at sequence 145, the sequence-146 release, the sequence-147 release, the sequence-148 release, the sequence-149 release, the sequence-150 release or this sequence-151 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-148 candidate before R151 partial component update')

def canonical(data):
    return data.replace(b'\r\n', b'\n')

def digest(data):
    return hashlib.sha256(canonical(data)).hexdigest()

rows = []
for row in manifest['files']:
    path = PurePosixPath(row['path'])
    if path.is_absolute() or '..' in path.parts or '\\' in row['path']:
        raise SystemExit('Unsafe source path')
    target = root.joinpath(*path.parts)
    source = overlay.joinpath('changes', *path.parts)
    if not source.is_file() or digest(source.read_bytes()) != row['sha256']:
        raise SystemExit('Candidate source checksum differs: ' + row['path'])
    before = row.get('beforeSha256')
    if before is not None:
        current = digest(target.read_bytes()) if target.is_file() else None
        if current not in (before, row['sha256']):
            raise SystemExit('Existing source differs; refusing overwrite: ' + row['path'])
    rows.append((target, source))
for target, source in rows:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(source.read_bytes())
print('Applied reviewed R151 partial component-update source over the exact sequence-148 candidate.')
