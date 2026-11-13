"""Apply the reviewed R198 microphone preparation over the exact sequence-163 candidate.

Reported: pressing the microphone looks like a freeze. Rebuilding this overlay corrected two
mistakes of mine in the original.

The first was factual. I wrote that the interface never reported preparation; reading the base
shows start() already set the loading state and began the microphone-setup timing, so my patch
duplicated both statements. They are gone from this version and only the real defect remains.

The second was mechanical. The original manifest was generated with before and after hashes equal,
taken from the changes directory instead of the chain, so the overlay could never apply — CI would
have rejected it at the first file. This version computes both from the chain.

The defect that is real: the native side blocked. Recognition keeps a global mutex for the whole
transcription, budgeted in the code at 120 seconds for CPU-only runners, and voice_prepare waited
on that same mutex. Pressing the microphone while a previous command was still being transcribed
blocked silently for as long as it took. Preparation now takes the mutex with try_lock and answers
«Идёт распознавание предыдущей команды. Подождите пару секунд и повторите.». Actual recognition
still queues normally, because a spoken command must not be dropped.

Each preparation step also gets a deadline — 5 s for the status call, 20 s for module preparation,
15 s for the microphone, 10 s for the worklet — so a stalled step produces a readable error instead
of an indefinite wait.
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
print('Applied reviewed R198 microphone preparation over the exact sequence-163 candidate.')
