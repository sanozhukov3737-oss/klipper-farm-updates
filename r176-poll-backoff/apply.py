"""Apply the reviewed R176 poll-backoff source over the exact sequence-158 candidate.

The live database showed 1200 "truncated response" failures in a single night, about 400
per hour, all from actor_rpc. The REST reconcile poll ran every 8 seconds with no backoff,
so a printer that sleeps or stalls was queried 450 times an hour and every miss was written
to the command journal.

Two changes:

* A failed reconcile now backs off: 8s, 16s, 32s, then 60s, and the first success returns
  the interval to 8s. Shutdown is still detected instantly through the websocket
  notification, so the slower REST poll only affects the redundant path.
* Service calls no longer enter the exactly-once command inbox: AcknowledgeEvents and
  read-only ActorRpc methods (printer.objects.*, server.info, server.files.* and friends).
  Retrying them is inherently safe, and they were 99% of the 304000 inbox rows. Commands
  that change printer state keep their durability and their replay protection.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 158}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-158 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-158 candidate before R176 poll backoff')

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
print('Applied reviewed R176 poll-backoff source over the exact sequence-158 candidate.')
