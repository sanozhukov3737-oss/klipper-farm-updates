"""Apply the reviewed R182 assistant vocabulary over the exact sequence-159 candidate.

R181 fixed the stress of the completion verbs. This overlay covers the rest of the
vocabulary the assistant actually speaks.

Every Russian phrase the assistant can say was extracted from the voice sources and
compared against the stress dictionary: 291 distinct words of four letters or more, of
which 238 were absent. Absent words are not an error in themselves, the model handles
most of them, but the frequent ones where it guesses are audible.

The word that matters most is зАпуск: it appears sixteen times in the phrases, and the
common mispronunciation запУск stands out. All its cases are pinned. The same treatment
covers the phrases the operator hears while choosing a printer and a file — нОмер,
назовИте, картОчка, спИсок, пОиск, плАн, вЫбери — the imperative forms, whose stress
falls on the ending, and the state words подтверждЁн, изменИлось, состоЯние.

Two of those additions were mistyped on the first pass, состояние without a mark and
хранилище with an extra letter. The dictionary invariant added in R181 rejected both,
which is the reason it exists.

Words whose stress depends on meaning stay out: замок, сопло, мука. Pinning one reading
there would make the other wrong.
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
if identity != manifest['buildId']:
    raise SystemExit('Expected the accepted sequence-159 candidate before R182 assistant vocabulary')


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
print('Applied reviewed R182 assistant vocabulary source over the exact sequence-159 candidate.')
