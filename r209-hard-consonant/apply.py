"""Apply the reviewed R209 hard-consonant speech fix over the exact sequence-165 candidate.

Reported: «темпу» still sounds wrong in the near-end announcement.

Measurement on the real runtime explains it. Rendering «т+емпу» and the unmarked «темпу» produced
byte-identical audio, which I once read as "our mark is ignored". It meant something else: the model
agrees on the stress but softens the consonant. Russian «темп» is [тэмп] with a hard t; the model
said [т'емпу]. The share of energy above 2 kHz — high for a palatalised consonant — was 0.595,
against 0.418 for a known hard «тэн» and 0.709 for a known soft «тень».

Two fixes.

The table now spells the hard forms through «э»: темп, темпу, темпа, темпе, темпом, темпы and the
тест family. Measured through the working code, «темпу» becomes 0.278 and «тест» 0.315 — both hard.

That alone did nothing, because pronunciation_text rebuilt the word from the original letters: it
took the stress position and reinserted «+» into the input word, so «т+эмпу» collapsed back to
«т+емпу». The function now uses the table's spelling whenever it differs from the word — which also
covers «ё» — while keeping the original capitalisation.

Words that are soft by norm are untouched: «температура» stays 0.607, «текущему» stays «тек+ущему»,
«модель» was already hard at 0.215.

The dictionary invariant is relaxed for this one substitution: the form without the mark is compared
after mapping «э» to «е», so it still catches typos such as «заверш+иится».
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
    'installedSequence': 165,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-165 candidate')
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
print('Applied reviewed R209 hard-consonant speech fix over the exact sequence-165 candidate.')
