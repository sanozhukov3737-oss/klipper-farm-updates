"""Apply the reviewed R164 update-resume source over the exact sequence-154 candidate.

The reported failure was "Истекло время ожидания скачивания обновления (curl 28)",
and measurements on the real link confirm the cause: throughput swings from 8.7 MB/s
to zero, and the connection can sit silent for a minute. The updater downloaded the
285 MB installer with these flags only:

    --connect-timeout 10 --max-time 900

Three consequences. A drop at 200 MB of 285 restarted from zero. A stalled connection
held until the 15 minute deadline. And even where curl could resume, the code deleted
the partial file on every failed exit, so nothing was left to resume from.

The download now passes --retry 5 --retry-delay 2 --retry-all-errors, --continue-at -,
--speed-limit 1024 --speed-time 30 and a 30 second connect timeout, and keeps the
partial file for the codes that mean "transfer interrupted" (18, 28, 52, 56) instead
of deleting it. Other codes still remove the file, because resuming them is either
pointless or unsafe.

Verified against the published 1.15.4 installer: downloading to 115 MB and killing the
transfer, then resuming with these flags, produces the exact 285379629 bytes and the
exact SHA256 of the release asset.
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
    raise SystemExit('Expected the accepted sequence-154 candidate before the R160 sequence bump')

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
print('Applied reviewed R165 reliability source over the exact sequence-154 candidate.')
