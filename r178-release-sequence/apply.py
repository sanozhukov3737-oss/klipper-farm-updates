"""Apply the reviewed R178 release-sequence source over the exact sequence-158 candidate.

Sequence 158 is published, so the R176 poll backoff and the R177 print-safety work would
reach nobody. This overlay raises the packaged channel to 159 and moves the release identity
to R15.9, which is the released application version 1.15.9.

It carries two overlays already accepted into the source chain:

* R176 poll backoff: a failed REST reconcile now backs off 8s, 16s, 32s, then 60s, and the
  first success returns the interval to 8s. Service calls (AcknowledgeEvents and read-only
  ActorRpc methods) stay out of the exactly-once command inbox, because replaying them is
  inherently safe and they were 99% of its rows.
* R177 print safety: the start path compares the G-code filament weight with the remaining
  spool weight and asks before starting a print that cannot finish. The report table shows
  what a file usually takes on this farm, averaged over earlier successful prints only.
  The audit journal exports to CSV from rows already loaded.

Sequence and identity are checked twice: this overlay refuses to run on anything but the
accepted sequence-158 candidate, and after applying it verifies that the packaged channel
really reads 159.
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
    'installedSequence': 158,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-158 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-158 candidate before the R178 sequence bump')


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
applied = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
if applied['installedSequence'] != 159:
    raise SystemExit('Sequence bump did not reach the packaged channel')
print('Applied reviewed R178 release-sequence source: channel sequence 159, identity ' + manifest['buildId'] + '.')
