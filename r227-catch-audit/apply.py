"""Apply the reviewed R227 catch-block audit over the exact sequence-173 candidate.

Twenty three empty catch blocks across the frontend. Each one hides a decision: either the failure was
considered and dismissed, or it was never noticed. A reader cannot tell which, and on a farm the
difference shows up as data that quietly is not there.

One of them was the second kind. The pronunciation dictionary reads its entries from localStorage and
returns `{available, entries}`. If the stored JSON failed to parse — a half-written record, a power loss,
a manual edit — the catch left the entries empty and still returned `available: true`. The settings
panel then showed an empty dictionary as if the operator had never saved a word, and offered to save new
ones over whatever was there. A corrupted store is now reported as unavailable, which is what the caller
already renders as "Настройки произношения сейчас недоступны".

The other twenty two are genuinely best-effort: localStorage hints, interface callbacks, abort of an
already-finished controller, percent-decoding that falls through to the raw string. None of them loses
data if it fails. They are not changed in behaviour, only in legibility: each now states why it is
silent, on the spot, so the next reader does not have to reconstruct the reasoning.

The rule that will keep this true is `no-empty` with `allowEmptyCatch: false`. An empty catch now fails
the strict lint, and a comment inside the block satisfies it. That is deliberate: the comment is the
point, not the syntax. It costs one line to dismiss a failure on purpose, and that line is where the
reason lives.

Verified: typecheck clean, strict lint clean with the new rule, the frontend builds, and 113 of the 115
regression scripts pass against a tree with no dist and no rv — the two failures are the prepared speech
assets the pipeline supplies two steps earlier.
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
    'installedSequence': 173,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-173 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-173 candidate before R227 catch audit')


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
print('Applied reviewed R227 catch-block audit over the exact sequence-173 candidate.')
