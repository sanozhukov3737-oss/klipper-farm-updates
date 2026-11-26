"""Apply the reviewed R270 five-printer and phrase-form repair over the exact sequence-175 candidate.

The phrase set grew from 19 to 54 along the four lines agreed: more printers in the context, queue and task
questions, spoken numbers, and the forms a farm actually dictates. Run against the real model through the full
path, it found four defects and two limits worth recording.

The defects:

"SE" had no alias at all. The ender3-v3-se profile was never listed in the alias table, so "Поставь на SE" did
not match any printer, the model guessed the neighbouring KE, and the validator then correctly refused the
mismatch with an ambiguous clarification. The user saw "please clarify" for a printer they had named exactly.
Both SE and KE now carry Latin and Cyrillic spellings.

"Сними K1C с паузы" was not resume. The existing rule required the verb and "с паузы" to be adjacent, so a
printer name between them broke it. The pattern now allows up to three words in between.

"Проверь печать" came back as tasks and "что печатается на Максе" as find with the whole sentence as a query.
The deterministic reader answers both, but the model overrode the first and the validator had no rule for the
second with a named printer. Tasks and check now win over the model when the text already answers them, and a
status question with a printer clause is answered as status with that printer.

"Какие принтеры в ошибке" was not read at all — the status vocabulary had no word for a fault — so both the
reader and the model said they did not understand. The vocabulary now covers the fault vocabulary, and a
printer-state question survives a model that refuses it.

The two limits, recorded rather than papered over:

The model confuses "Ender 3 V3 SE" with the KE and names ke. The validator refuses because the text names SE,
which is the right outcome: a guess that contradicts the request must not start a print on the wrong machine.
The phrase still ends in a clarification rather than the intended action, and that is the model's limit, not a
missing rule.

"Что в очереди?" and "Помощь" are questions, not commands. Navigation requires an explicit open or show verb,
so both are answered with a clarification. That is deliberate: "Помощь" must not silently open the dashboard,
and a question about the queue is not a request to navigate to it.

Verified: 53 of 54 phrases correct on the real model; the single failure is the SE/KE confusion above, which the
validator catches. check-voice-normalization.mjs gained the alias table and the phrase forms, all testable
without the model, and fails with "алиас принтера: SE" when the alias is removed. Regression suite: 139 passed,
0 failed, 21 skipped.

No release: printer aliases, phrase forms and their coverage.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R269 applied before R270')


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
print('Applied reviewed R270 five-printer and phrase-form repair.')
