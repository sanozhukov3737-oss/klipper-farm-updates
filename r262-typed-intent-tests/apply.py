"""Apply the reviewed R262 typed-intent refusal tests over the exact sequence-175 candidate.

The installed-speech check exercises twelve Russian phrases against the real model, and eleven of them ask
whether understanding works. One asks about refusal — "Подними стол на 10 миллиметров" must come back as
clarify/unsupported — which leaves the more important question mostly untested: whether the transport
refuses what it cannot express as a typed intent, and whether the model's refusal carries a reason the UI
can phrase.

Two tests now cover it, at the layer that actually decides.

parse_output_refuses_everything_that_is_not_one_typed_intent walks the whole boundary. Every kind the
frontend knows must survive, so a refusal has to come from the allow-list rather than a typo in it. Invented
kinds are refused, including a case-different one. Non-objects, bare scalars, two objects in sequence, and
any text before the JSON are refused. The only permitted trailer is the runtime's own end marker, and a
marker followed by more text is refused.

clarify_carries_one_of_the_three_reasons records where the reason allow-list actually lives. parse_output
accepts any reason string; the frontend validator enforces unknown/ambiguous/unsupported before anything is
dispatched. The test asserts both halves so the boundary is stated rather than assumed.

One thing this overlay does not change, after trying to and reverting. The trailer is trimmed of whitespace,
which looked like laxness until the existing test and completion_payload were read together: the request sets
no stop sequence, llama-server appends its marker after a space and a newline, and a committed test already
pins that shape. Removing the trim broke a passing test and would have refused real answers. The coverage
went in; the transport stayed as it was.

Verified: the full Rust suite is 315 passed, 0 failed, 2 ignored, up from 313.

No release: test coverage only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R261 applied before R262')


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
print('Applied reviewed R262 typed-intent refusal tests over the exact sequence-175 candidate.')
