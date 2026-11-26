"""Apply the reviewed R269 spoken-number and filament-name repair over the exact sequence-175 candidate.

Speech recognition was never tested on real audio here, so this closes the loop with what the machine has:
Silero synthesises the phrase, whisper-cli recognises it with the shipped small model and Russian language,
and the transcript is fed to the assistant. Sixteen phrases, and the disagreement between what was said and
what was heard is the finding.

Three real defects, all on the recognition side rather than in the model.

The spoken-number table stopped at "тридцать минут". "Через сорок минут", "через девяносто минут", "через
пятьдесят минут" read as no duration at all, so the forecast fell back to whatever the model suggested. This
matters because whisper writes numbers as digits only sometimes — it produced "Через 40 минут" and "через 90
минут" from dictated words, and it produced the words from other phrasings. Both forms must read. The table now
covers twenty-five through ninety and up to six hours.

Filament names written the way recognition writes them were not recognised. "ПТГ" and "пэтг" are how whisper
transcribes PETG, and "ПЛА" for PLA; without normalisation the stock question became an ordinary sentence and
the reply was "I did not understand". The normaliser now maps those spellings, with word boundaries so that
"петля" and "пластина" are left alone.

The third is not a defect and is worth recording as such: recognition drops "Ксения" to "Сеня" and "втулку" to
"толку". The assistant still answers correctly — "Напечатай в толку на форже" reaches print with printer forge —
because the validator and the phrase parser do not need the exact wording. Recognition losing a word is
survivable; recognition losing the structure of the request would not be.

Verified: 16 of 16 phrases round-trip through synthesis and recognition with numbers compared by value rather
than spelling; three transcripts that differ word-for-word still produce the right intent through the full
path. check-voice-normalization.mjs gained the numbers and the filament spellings and fails without them with
"материал не распознан: сколько осталось красного ПТГ" and "число словами не прочитано". The regression suite
is 139 passed, 0 failed, 21 skipped.

No release: speech recognition inputs and their coverage.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R268 applied before R269')


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
print('Applied reviewed R269 spoken-number and filament-name repair.')
