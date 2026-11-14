"""Apply the reviewed R207 spool editing over the exact sequence-164 candidate.

Two reports, one root: the warehouse told the operator what it held but made changing it awkward.

Editing a spool's remaining weight already existed — the «Остаток и цвет» button on the selected
spool opens a form with a grams field. It was reachable only after selecting a spool in a dropdown,
and its label says nothing about weight, so the capability was effectively hidden. A compact grams
field now sits beside that button, saving through the same edit-spool command: empty or non-numeric
input restores the previous value rather than writing zero.

Small remnants had no answer at all. Spools of two, three and four grams accumulated forever: too
small to mount, too real to delete without losing the count. A merge-spool-remnants command sums
spools of the same material, colour and surface into one. Same material is not enough — mixing a
black and a white PETG remnant would describe a spool that does not exist, so colour and surface
must match too, and spools above the five gram threshold are refused so the action cannot swallow a
full spool. Printer bindings of the removed spools are cleared, because a printer must not stay
attached to a record that no longer exists.

The merge logic is covered by a script test that builds real inventory states: three small spools
become one of nine grams, mixed materials are rejected, a full spool is rejected, and a single
spool is rejected.
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
    'installedSequence': 164,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-163 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-163 candidate before R198 microphone preparation')


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
print('Applied reviewed R207 spool editing over the exact sequence-164 candidate.')
