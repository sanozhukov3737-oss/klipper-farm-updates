"""Apply the reviewed R276 shared-library repair over the exact sequence-175 candidate.

The operator reported it directly: two identical Ender 3 V3 KE printers, and the "flash drive" stopped being
shared between them. The cause is in applyModelDetection.

localLibraryScopeId keys a known model as model:<preset> and an unknown one as printer.id. That is the right
shape — identical printers share files, a printer whose compatibility cannot be inferred keeps its own. But
applyModelDetection set the preset to custom whenever the probe returned decision 'unknown', overwriting a
preset that had already been confirmed. One unanswered probe during the automatic refresh was therefore enough
to move the printer from model:ender3-v3-ke to its own id, and the files disappeared from the other printer's
list.

Reproduced before the change: two printers with preset ender3-v3-ke, one receiving confirmed, the other
unknown — scope went from model:ender3-v3-ke to 11.

The fix keeps the preset and profile across an unanswered probe. The reasoning is that 'unknown' means the
probe returned too little to decide, which is not evidence that the printer changed. For an actual replacement
there are 'conflict' for contradictory signs and 'confirmed' for a positive match, and both still behave as
before: conflict keeps the current preset, and a confirmed match re-keys the library to the new model. The
probe result itself is still recorded in lastDetection, so the printer remains visibly unverified.

One existing check asserted the old behaviour — applyModelDetection with unknown must set profile.preset to
custom. That assertion encoded the defect, so it now expects the established preset and states why. The new
check-printer-library-scope.mjs covers the whole boundary: shared library for identical printers, no split on
unknown or conflict, re-key on a confirmed different model, and a custom printer keeping its own namespace.

Verified: 142 regression scripts pass; the new check fails against the previous modelSelection.ts with
"неотвеченный опрос не должен забывать модель".

No release: shared library identity and its coverage.
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
    raise SystemExit('Expected the accepted sequence-175 candidate before R276')


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
print('Applied reviewed R276 shared-library repair.')
