"""Apply the reviewed R194 speech fixes over the exact sequence-162 candidate.

Two defects, both found by reading the spoken output rather than the code.

The printer number was not heard. «Ender-3 V3 KE 02» came out as «… кей дв+а»: the number went
through the quantity path, where num2words turns "02" into «два», and the short word ran into
its neighbour. A printer number is a designation, not a quantity, so it is now read digit by
digit — «ноль два». The rule sits immediately before the general number pass and matches only a
two-digit number directly after a model marker, which a test guards: «осталось 23 минуты» stays
«дв+адцать тр+и».

Quoted speech was silent about stress. The quote protection exists for file names and paths, but
it also covered ordinary Russian the operator hears: «Нажмите «Добавить»», «Скажите «Проверь
запуск»». Those words now get their stress inside quotes. The protection is kept for anything
path-like — a dot, slash, latin letter or digit — so «печать.gcode» is untouched, and words
outside the table stay untouched too, which keeps arbitrary printer names and omographs such as
замок safe.

A model suffix letter is separated from its digit, so «Adventurer 5M» is «пять эм» instead of
«пятьM» with the letter glued to the number.

Investigated and deliberately not changed: units such as мм/с, ГБ, № and °C that would fail today
do not occur in any spoken phrase, and dates never reach speech. Fixing them would add untested
paths for no audible gain.

The quoted-speech fixture asserted the old behaviour and is rewritten to assert the new one,
including that file tokens, unknown names and omographs remain unstressed.
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
    raise SystemExit('Expected the accepted sequence-162 candidate before R194 speech fixes')


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
print('Applied reviewed R194 speech fixes over the exact sequence-162 candidate.')
