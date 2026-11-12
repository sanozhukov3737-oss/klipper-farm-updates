"""Apply the reviewed R188 number stress over the exact sequence-161 candidate.

Reported from the farm: a word in the near-end notification was stressed wrongly. The
suspected word turned out to be correct — `темпу` has carried т+емпу since the table became
generated — but auditing the same phrase found the real gap next to it: the numbers.

Every numeral is produced at speech time by num2words, so no literal in the interface contains
one and the generator never saw them. `двенадцать`, `двести`, `пять`, `сорок`, `пятьдесят`,
`шестьдесят`, `десятых` and `целая` therefore reached the model unmarked, and it stressed them
by guess.

RUNTIME_WORDS in the generator now lists the numerals, the fractions and the count words, in
the same spirit as the units added for R183: anything synthesized at runtime rather than
written in a string has to be named explicitly or the model fills the gap. The table grows from
1885 to 1926 entries.

Two fixtures move with the table, as in R181 and R183: the numbers now carry marks, so the
numeric inflection test and the runtime probe expect дв+ести, пятьдес+ят, ц+елая, п+ять,
дес+ятых, тр+и and чет+ыре.

Words whose stress depends on meaning stay out. `сопла` is the example: the generator leaves
it unmarked because сОпла and соплА are different words, and a table cannot choose between
them.
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
    'installedSequence': 161,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-161 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected the accepted sequence-161 candidate before R188 number stress')


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
print('Applied reviewed R188 number stress over the exact sequence-161 candidate.')
