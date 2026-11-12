"""Apply the reviewed R193 upload queue fix over the exact sequence-162 candidate.

Reported: sending a file to the FlashForge 5M does not always work the first time. The
application thinks for a long while, nothing appears on the printer, and after restarting the
application the same send goes through immediately.

The restart is the clue. Each MoonrakerClient owns a PrinterRequestScheduler — one queue, one
task at a time — so a fresh client starts with an empty queue. The send was not failing; it was
waiting behind something that never finished.

Two defects in the scheduler:

* Only emergency and control requests preempted a lower-priority task. An upload outranks a
  background poll but did not displace one, so a stuck telemetry poll held the queue while the
  operator's file sat behind it.
* No background task had a deadline. A poll whose transport never answered stayed active
  forever, and drain() never moved on.

The scheduler now lets an upload displace a background poll, the same way a control command
already did, and gives every background task a 20 second deadline before it is aborted and the
queue moves on. Operator actions no longer queue behind diagnostics.

Verified: tsc clean, frontend builds, check-ui-files and the full audit pass.
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
    'installedSequence': 162,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-162 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected the accepted sequence-162 candidate before R193 upload queue')


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
print('Applied reviewed R193 upload queue over the exact sequence-162 candidate.')
