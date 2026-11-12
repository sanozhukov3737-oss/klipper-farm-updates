"""Apply the reviewed R191 printer rename over the exact sequence-162 candidate.

Reported: the application names a printer itself, and with several identical models it appends
a number. The operator cannot change that, so two Ender-3 V3 KE units stay "…02" and "…05"
whatever they are actually used for.

The cause is the absence of a field, not a lock. SetupWizard lets a name be typed when the
printer is added and records nameSource='custom'; PrinterSettings never offered the field
again, so once a printer existed its name could only be the generated one.

A "Название" section now sits first in the printer settings, because the name is what the
operator sees in every list. Typing a name sets nameSource='custom', which is the flag
normalizeCatalogIdentity already respects: it only rewrites names whose source is automatic. A
button returns the field to the model name, so the automatic numbering can be restored.

Clearing the field is also meaningful — it means "name it after the model", and save() records
nameSource='automatic' in that case, so the number follows the model again rather than being
frozen as a custom label.

Nothing about detection, credentials or addressing changes: the name only affects the label.
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
    raise SystemExit('Expected the accepted sequence-162 candidate before R191 printer rename')


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
print('Applied reviewed R191 printer rename over the exact sequence-162 candidate.')
