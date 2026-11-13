"""Apply the reviewed R200 speech robustness over the exact sequence-163 candidate.

Another round of probing the real runtime found four defects, all audible.

A hyphen between a letter and a digit was read as a minus sign. A printer named «printer-1»
was announced as «на принтере минус один», and «станок-3» as «станок минус три». The separator
rule now runs before latin stripping, because «printer-1» loses its word first and only «-1»
reaches the number pass. Negative values are unaffected: «-5 градусов» still reads «минус пять».

Latin words were deleted outright. That was right when English Klipper text reached the voice,
but R196 announces faults in Russian, so the only latin left in speech is a printer name the
operator typed. «Printer-1» produced «на принтере один завершена» — the name simply vanished.
Latin is now read letter by letter, with tokens longer than 24 characters still dropped so a
stray English word cannot turn into a minute of spelling. The FlashForge model names that used
to be spelled out this way are replaced with their Russian form instead.

A number of sixteen digits or more raised and killed the whole utterance: thirteen digits were
fine, sixteen produced silence. Long numbers are codes and serials, not quantities, so they are
now read digit by digit.

Expanding a dense text could exceed the internal 8000-character ceiling and raise, again losing
the announcement entirely. The text is truncated at a word boundary instead — hearing the
beginning beats hearing nothing.

The printer number also gains two cases it missed: a trailing number after the model marker
«макс» («K1 Max 02» said «макс два»), and any number with a leading zero («007» said «семь»,
«Принтер 02» said «два»). Leading zeros are now always read digit by digit.

Verified: 19 pronunciation tests pass, every spoken phrase renders without latin, double spaces
or stray characters, the generator still matches the reference, and tsc and the build are clean.
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
    'installedSequence': 163,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-163 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-163 candidate before R198 microphone preparation')


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
print('Applied reviewed R200 speech robustness over the exact sequence-163 candidate.')
