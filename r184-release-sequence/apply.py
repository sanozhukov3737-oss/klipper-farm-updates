"""Apply the reviewed R184 release-sequence source over the exact sequence-159 candidate.

Sequence 159 is published, so the stress work from R181, R182 and R183 would reach nobody.
This overlay raises the packaged channel to 160 and moves the release identity to R15.10,
which is the released application version 1.15.10. Dates in this identity follow the series
the project already uses, one day per sequence.

It carries three overlays already accepted into the source chain:

* R181 fixed the completion verbs: завершИтся, завершенА, вЫключена. The hand table had
  stressed the stem instead of the ending.
* R182 covered the rest of the spoken vocabulary, зАпуск above all.
* R183 replaced the hand table with a generated one, taken from the ruaccent dictionary,
  which also removed ten wrong entries the hand pass had carried.

Sequence and identity are checked twice: this overlay refuses to run on anything but the
accepted sequence-159 candidate, and after applying it verifies that the packaged channel
really reads 160.
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
    'installedSequence': 159,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-159 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-159 candidate before R184 release sequence')


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
print('Applied reviewed R184 release sequence over the exact sequence-159 candidate.')
