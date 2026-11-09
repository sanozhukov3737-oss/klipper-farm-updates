"""Apply the reviewed R168 release-sequence source over the exact sequence-154 candidate.

Sequence 154 is published. This overlay raises the packaged channel to 155 and moves the
release identity to R15.5, which is the released application version 1.15.5. It carries
the download resume, the update progress window, the Klipper shutdown reason, the circuit
breaker fix, the STALE_SESSION retry and the compacted backups.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 154}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-154 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-154 candidate before the R168 sequence bump')

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
    target.write_bytes(canonical(source.read_bytes()))
applied = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
if applied['installedSequence'] != 155:
    raise SystemExit('Sequence bump did not reach the packaged channel')
print('Applied reviewed R168 release-sequence source: channel sequence 155, identity ' + manifest['buildId'] + '.')
