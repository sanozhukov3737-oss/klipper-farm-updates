"""Apply the reviewed R177 print-safety UI over the exact sequence-158 candidate.

Three gaps found while auditing what the interface already does:

* Starting a print never compared the G-code filament weight with what is left on the
  spool bound to that printer. The numbers were both known: `filament_weight_total`
  comes from the file metadata and `remainingWeight` from the warehouse. A running-out
  spool therefore only showed up mid-print. The start path now asks first.
* The report table showed how long a file took, but never what it usually takes on this
  farm. A forecast built from earlier successful prints of the same file makes an
  off-schedule print visible immediately. Failed and cancelled runs are excluded,
  because they say nothing about duration, and fewer than two runs produces no
  forecast at all rather than a random number.
* The audit journal could only be read on screen. Incidents are now exported to CSV
  from the already loaded rows, so no extra database query is added.

The forecast lives in its own module so the arithmetic can be tested without React,
without a browser and without printers.
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
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-158 candidate before R177 print-safety UI')


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
print('Applied reviewed R177 print-safety UI over the exact sequence-158 candidate.')
