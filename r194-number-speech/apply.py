"""Apply the reviewed R194 printer number pronunciation over the exact sequence-162 candidate.

Reported: in the runout announcement the printer number is not heard. «Ender-3 V3 KE 02»
came out as «… кей дв+а» — the short «два» ran into the previous word and disappeared.

The number was being converted as a quantity: num2words turned "02" into «два». A printer
number is a designation, not a quantity, so it is read digit by digit — «ноль два».

The rule sits immediately before the general number pass and matches only a two-digit number
directly after a model marker («кей», «ви»). Quantities keep their normal reading, which the
tests assert explicitly: «осталось 23 минуты» stays «дв+адцать тр+и», not «два три».

The same overlay separates a model suffix letter from its digit, so «Adventurer 5M» is «пять
эм» instead of «пятьM» with the letter glued to the number.

Three tests were added: the number in every common form, a guard that quantities are untouched,
and the model suffix.
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
    raise SystemExit('Expected the accepted sequence-162 candidate before R194 printer number')


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
print('Applied reviewed R194 printer number pronunciation over the exact sequence-162 candidate.')
