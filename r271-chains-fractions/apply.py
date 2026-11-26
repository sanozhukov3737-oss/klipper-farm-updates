"""Apply the reviewed R271 chain coverage and fraction repair over the exact sequence-175 candidate.

Three things, all from the agreement: dialog chains, spoken fractions, and the full path through synthesis
and recognition.

Chains first, and the good news is that they mostly held. Seven transitions were exercised against the real
assistant: print then change printer then pick a file then confirm; print then change file; cancel mid-chain;
three printer changes in a row; a conversation expiring between steps; a change to a printer that does not
exist; and cancel at the file-choice stage. Six passed unchanged. The seventh was my own mistake: "Нет,
корпус" with no verb is deliberately answered with "what should I do — find, prepare or check?", because a
bare noun is not a command. With the verb ("Напечатай корпус") the file changes correctly. The scenario was
corrected, not the code, and check-voice-chains.mjs now pins all seven.

Fractions were a real defect. "Через час с половиной" read as 60 minutes — not unrecognised, but wrong, which
is worse: the forecast showed half the actual time and looked plausible. The same for "час с четвертью".
The cause was ordering, not absence: the phrase starts with "час", the word table matched it and returned
before any fraction was considered. Fractions are now read before the table, and "два с половиной часа" (150),
"три четверти часа" (45), "две трети часа" (40), "полтора десятка минут" (15), "минуту" and "пару минут" all
read.

The full path found the third. Fifty-four phrases through Silero synthesis, whisper recognition and then the
assistant: sixteen lost at least one word, which is what a small model does. What mattered was that the names
survived: whisper writes "Макс" as the Latin MAX, "Форж" as "форш", "форже" as "форжи", "KE" as "кет", and
"Ender" as "Индире". MAX already worked through transliteration; the others did not match any printer, so the
model guessed a neighbour and the validator refused. The alias table now carries those heard forms. A name the
operator said and recognition mangled is found again, and the intent behind it is read correctly.

Verified: 7 of 7 chains; all fraction forms; the heard-name forms resolve to the right printer and the
surrounding intent still parses. check-voice-normalization.mjs gained the fractions and the heard names, and
fails without them. Regression suite: 140 passed, 0 failed, 21 skipped.

No release: dialog chains, spoken fractions and the recognition-name mapping.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R270 applied before R271')


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
print('Applied reviewed R271 chain coverage and fraction repair.')
