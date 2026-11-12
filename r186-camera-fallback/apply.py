"""Apply the reviewed R186 camera endpoint fallback over the exact sequence-160 candidate.

Reported from the farm: the K1C and the K1 Max both lost their camera, and it had happened
before and then recovered by itself. Probing the two printers showed why the recovery is a
lottery: the port that serves the stream is not the same on both, and it changes.

    .100 K1C     80 open, 8081 open, 8000 open, 8080 CLOSED
    .107 K1 Max  80 open, 8081 open, 8000 CLOSED,  8080 CLOSED

The component asked one address only. For the K1C it tried 8080/stream, got nothing, waited
seven seconds and fell back to WebRTC on 8000. For the K1 Max it went straight to WebRTC on
8000, which on that printer is closed, and stopped there. Either way a single unanswered
address decided the outcome.

The component now keeps an ordered list of candidate endpoints — ports 8080, 8081, 80 and
4408, each with /stream, /?action=stream and /webcam/?action=stream — and walks it. An
unanswered address costs four seconds, an immediate error costs nothing, and a working one
fires onLoad and stops the walk. When the list is exhausted the WebRTC path is tried, and if
WebRTC fails the list is walked once, so a printer with the service on 8000 closed still gets
its picture.

Each address gets its own <img> element, keyed by URL, because a browser keeps the failed
state of a reused element and would never retry. The retry button restarts the walk from the
first address instead of resuming where it stopped.

Nothing about discovery, identity or control flow changes: only how the video URL is chosen.
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
    'installedSequence': 160,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-160 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected the accepted sequence-160 candidate before R186 camera fallback')


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
print('Applied reviewed R186 camera endpoint fallback over the exact sequence-160 candidate.')
