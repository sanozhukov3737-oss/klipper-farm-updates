"""Apply the reviewed R274 spoken-quantity repair over the exact sequence-175 candidate.

The quantity vocabulary stopped at "десять", so "напечатай пятнадцать деталей" became a print of a file named
"пятнадцать деталей" — a silent misreading, not a refusal. The table now runs to twenty, carries the composite
forms ("двадцать пять"), and accepts the collective words people actually use: "пару", "десяток", "дюжину".
The batch verbs also grew: "сделай пять корпусов", "запусти три втулки" and "поставь два держателя" are the
same request as "напечатай пять".

The limit of twenty is kept deliberately and is where the measurement ended, not where I stopped: the
understanding contract's schema says plan.quantity is 1..20, so "напечатай 25 деталей" is outside what this
path can express. It stays an ordinary print request rather than becoming a plan of the wrong size, and the
check asserts that instead of pretending the limit is a bug.

Two of my own failures cost the most time here and are recorded rather than tidied away. Building the quantity
pattern by generating a regex from a word list broke the file in two places at once — the list was inserted into
two matches and left an unterminated object literal, which the type check reported as 25 errors. I reverted to
the last reviewed version of the file and redid the edit as three exact replacements, which is what the overlay
carries. Then the composite table was briefly declared twice, once inside the flat table and once beside it,
because my second edit did not remove what the first had added.

Verified: nine quantity forms produce the right plan and the right number; requests above twenty stay out of
plan; a request with no quantity is still an ordinary print. check-voice-normalization.mjs fails with "партия
не распознана" when the extended vocabulary is removed. Regression suite: 141 passed, 0 failed, 21 skipped.

No release: spoken quantities and their coverage.
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
    'installedSequence': 175,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-175 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-175 candidate with R273 applied before R274')


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
print('Applied reviewed R274 spoken-quantity repair.')
