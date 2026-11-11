"""Apply the reviewed R181 speech-stress source over the exact sequence-159 candidate.

Reported from the farm: the assistant says "завЕршится" where Russian stresses the И —
"завершИтся". The guess was wrong in the stress dictionary, not in the voice.

ASSISTANT_STRESS is the list of words the synthesizer is told how to stress. It carried
twenty-four wrong entries, all in one place: forms of завершить, включить, выключить,
продолжить and the word минут. The groups were built by marking one syllable of the stem,
so every form that moves the stress elsewhere was wrong:

  завершится, завершил   -> завершИтся, завершИл   (stress on И, not Е)
  завершена, завершены   -> завершенА, завершенЫ   (short participles end stressed)
  включена, включил      -> включенА, включИл
  выключена, выключил    -> вЫключена, вЫключил    (prefix stressed, unlike включить)
  продолжена, продолжаю  -> продолженА, продолжАю
  минут                  -> минУт

The test fixture had frozen three of those mistakes as expected output, so it would have
rejected the fix; those three expectations are corrected. Two fixtures that asserted
unnstressed minutes, hours and degrees now assert the stressed forms, which is what the
same change produces.

The dictionary also gained the forms the assistant actually says around a print: готов,
готова, готовы, закончена, подключён and its short forms, отменена, минута, секунда,
часа, часов, градусов, температура, прогноз, задание. Words where the stress depends on
sense and cannot be resolved from the spelling are deliberately left to the model.

A new test asserts the invariant of the whole dictionary: exactly one stress mark, placed
before a vowel, and the form without the mark equal to its key. It already caught one bug
in this very change, where a generator produced заверш+иится.
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
    raise SystemExit('Expected the accepted sequence-159 candidate before R181 speech stress')


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
print('Applied reviewed R181 speech-stress source over the exact sequence-159 candidate.')
