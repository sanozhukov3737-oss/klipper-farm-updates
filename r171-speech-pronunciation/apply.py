"""Apply the reviewed R171 speech-pronunciation source over the exact sequence-156 candidate.

Reported: the assistant says "Криэлити" instead of "Креалити", and puts stress in the wrong
place.

Cause: the Russian replacements for Latin names (Creality -> Креалити) happen inside
spoken_text, but ASSISTANT_STRESS is applied earlier and never knew those words. The model
therefore guessed the stress itself. The same gap covered every printer model name.

Three more defects were found while measuring the same phrases:

* Ender-3 became "Эндер минус три", because the hyphen reached the numeric pattern as a
  sign. Full model names are now replaced before numbers are handled.
* TE2564 was read as "TE две тысячи пятьсот шестьдесят четыре": the code stayed Latin and
  the digits became a count. Latin codes are now spelled letter by letter.
* Klipper and Moonraker stayed Latin and were dropped entirely, leaving sentences like
  " остановлен без сообщения". They are now pronounced "Клиппер" and "Мунрейкер".

Measured before and after on the real assistant phrases:

  before: Печ+ать на пр+интере Креалити кей один макс зав+ершена.
  after:  Печ+ать на пр+интере Кре+алити к+ей од+ин м+акс зав+ершена.

  before: Эндерминус три Vтри KE зак+ончился пл+астик
  after:  Э+ндер три в+и три к+ей зак+ончился пл+астик

  before: TEдве тысячи пятьсот шестьдесят четыре Heater extruder not heating...
  after:  тэ е два пять шесть четыре

English words are dropped only outside quoted names, so a file name keeps its extension
exactly as the existing speech test requires.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 156}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-156 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-156 candidate before R171 pronunciation')

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
            raise SystemExit('Existing source differs; refusing overwrite: ' + row['path'])
    rows.append((target, source))
for target, source in rows:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical(source.read_bytes()))
print('Applied reviewed R171 speech-pronunciation source over the exact sequence-156 candidate.')
