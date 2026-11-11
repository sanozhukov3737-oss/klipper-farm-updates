"""Apply the reviewed R185 runtime stress fixtures over the exact sequence-160 candidate.

The sequence-160 build failed at step eight with the runtime probe:

    AssertionError: Своб+одных пр+интеров сейч+ас нет. На...

That probe, scripts/check-silero-runtime.py, starts the real bundled interpreter and asserts
the spoken form of a fixed phrase. Its expectations came from the hand-written stress table,
so when R183 replaced that table with a generated one the probe started disagreeing on exactly
the words the fix was about: сейч+ас, немн+ого, дв+адцать, мин+уты, гр+адусов, Ц+ельсия,
одн+а, килогр+амма, час+ов, тр+идцать.

The probe cannot run outside a prepared runtime — it needs the bundled Python, torch and the
model — so neither the local test run nor the overlay verification could catch it. That is the
gap this overlay closes, and it is the reason the expectations are written to match the
generated table rather than merely the previous output: they now name the same forms the
generator produces, so a future regeneration that changes them will fail here and be seen.

Verified by running spoken_text over the probe's exact input on the accepted sequence-157
candidate chain and confirming every expected fragment appears.
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
    'installedSequence': 160,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-160 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-159 candidate before R184 release sequence')


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
print('Applied reviewed R185 runtime stress fixtures over the exact sequence-160 candidate.')
