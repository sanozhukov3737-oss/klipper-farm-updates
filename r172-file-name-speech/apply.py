"""Apply the reviewed R172 file-name-speech source over the exact sequence-156 candidate.

R171 fixed the stress on printer model names, but file names spoken inside quotes stayed a
mess:

  «СтанокДляСнаряженияЧастьодин (пять)_PETG_пятьдесят семьmтридцатьs.gcode»

The protected-quote rule kept such names verbatim on purpose, so that quoted text is never
reworded. A file name is not a quotation though: glued words, underscores, brackets and
duration suffixes are unreadable.

The overlay keeps the extension exactly as the speech test requires and normalises only
what cannot be read: CamelCase and script boundaries get spaces, separators and brackets
become spaces, duration suffixes become units the shared numbering rules can inflect.

  «Станок Для Снаряжения Часть 1 пэтгэ пятьдесят семь минут тридцать секунд.gcode»
  «1 Тройник O32.4 с зазором под 32 ППР трубу пэтгэ четыре часа пятьдесят четыре минуты.gcode»

Seconds are added to the unit table for the first form; the shared noun agreement already
handled hours and minutes, so "4h54m" now reads "четыре часа пятьдесят четыре минуты"
instead of "четыре час пятьдесят четыре минут".

All 9 pronunciation tests pass with the bundled Python.
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
    raise SystemExit('Expected exact accepted sequence-156 candidate before R172 file names')

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
print('Applied reviewed R172 file-name-speech source over the exact sequence-156 candidate.')
