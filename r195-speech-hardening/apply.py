"""Apply the reviewed R195 speech hardening over the exact sequence-162 candidate.

A sweep of every spoken phrase and every number form found five defects. All are fixed here.

Numbers in groups. The interface prints grams through toLocaleString('ru-RU'), which separates
digit groups with a non-breaking space. The synthesizer saw two numbers and read «1 250» as
«один двести пятьдесят» instead of «одна тысяча двести пятьдесят». Any spool above a kilogram
was announced as nonsense. Groups of three are now joined before the number pass.

«G-code» was mutilated to «G-»: the latin letter survived while the word was stripped, so five
phrases said «для выбранного G- нет принтера». Both spellings are now replaced with «гэ-код»
before the code and latin passes.

File names were treated as phrases. «model_v2_final» became «model v 2 final» and
«57m30s_test» became «57 мин 30 с», so the operator heard a name that does not exist. A name
containing latin letters is now left alone; cyrillic names keep their separator handling.

File names were also still exposed to the later passes: numbers inside quotes were expanded and
the duration pattern fired again. Quoted file tokens are hidden behind cyrillic marks and
restored at the very end, after every substitution.

Quoted speech has been stressed since R194; that behaviour and the protection for unknown names
and omographs are unchanged, and the tests assert both.

Investigated and deliberately unchanged: declension of units is correct for every form tested,
including the 11-14 exception; negatives read as «минус пять градусов»; single latin letters in
narration never occur in practice. Long-pause quality is a property of the model, not the text,
and can only be judged by ear.

The suite grows from 16 to 19 tests: grouped numbers in three separator variants, G-code in two
spellings, and latin file names preserved while cyrillic ones are still normalised.
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
    raise SystemExit('Expected the accepted sequence-162 candidate before R195 speech hardening')


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
print('Applied reviewed R195 speech hardening over the exact sequence-162 candidate.')
