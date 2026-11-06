"""Apply the reviewed R156 verification-identity source over the exact sequence-152 candidate.

Fourteen development check scripts still pinned the release build identity to the R8
series: nine compared RELEASE-BUILD-ID.txt against `V20.6-R8-FIX3.<revision>` and
check-audit-hardening.mjs demanded the exact string
`V20.6-R8-FIX3.17-STABLE-VERIFICATION-GATES-2026-09-13`. Every one of them therefore
failed on any later build, including the published R151 and R152 trees, which made
"run all the checks" produce noise instead of signal.

The scripts exist to verify code markers, not to pin a historical revision. The
identity assertion now only proves the tree is a V20.6 release.

Not every script is repaired by this: five of them fail for unrelated historical
reasons (a batch file removed after R131, a code pattern that was later rewritten, a
pinned hash of a file that legitimately changes). Those failures predate this change
and are tracked separately.

No publication. No change to the updater channel or the release identity.
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
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-152 candidate before R156 verification identity')

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
print('Applied reviewed R156 verification-identity source over the exact sequence-152 candidate.')
