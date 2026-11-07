"""Apply the reviewed R160 release-sequence source over the exact sequence-152 candidate.

Sequence 152 is published. The updater offers an update only when the manifest sequence
is strictly greater than the installed one, and kf-update rejects a different manifest
reusing an accepted sequence as equivocation, so the R158 and R159 work would reach
nobody under sequence 152.

This overlay raises the packaged channel to 153 and moves the release identity to
R15.3, which is the released application version 1.15.3 (version-stamp/version.json is
bumped in the same commit). It touches no updater endpoint, no signing key and no
published release.

R158 is the storage location card; R159 reports why an installer aborted and retries a
transient abort once.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 152}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-152 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-152 candidate before the R160 sequence bump')

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
if applied['installedSequence'] != 153:
    raise SystemExit('Sequence bump did not reach the packaged channel')
print('Applied reviewed R160 release-sequence source: channel sequence 153, identity ' + manifest['buildId'] + '.')
