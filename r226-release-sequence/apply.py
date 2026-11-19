"""Apply the reviewed R226 release sequence over the exact sequence-172 candidate with R225 applied.

Sequence 172 is published, so the behavioural protocol work from R225 would reach nobody. This raises
the packaged channel to 173 and the identity to R15.23, the released application version 1.15.23.

It carries one overlay: a behavioural test that drives the real Moonraker client against the response
shapes a farm actually sees. It found that a Spoolman answer with the array directly under result was
read as an empty list, so the warehouse said there were no spools while they existed. Two pure parsers
moved out of the client so they can be tested without it. The two moderate advisories are closed by
pinning uuid, which vosk-browser uses only as v4. And four checks that were never executed now run —
three after the frontend build because they read dist, one in the step that already installs playwright.

The workflow's three sequence-bound expectations move with this and R226 joins the chain.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {
    'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json',
    'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb',
    'channel': 'stable',
    'installedSequence': 172,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-172 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-172 candidate with R225 applied before R226')


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
            raise SystemExit('Existing source differs; refusing to overwrite: ' + row['path'])
    rows.append((target, source))
for target, source in rows:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical(source.read_bytes()))
print('Applied reviewed R226 release sequence over the exact sequence-172 candidate with R225 applied.')
