"""Apply the reviewed R198 microphone preparation over the exact sequence-163 candidate.

Reported: pressing the microphone looks like a freeze. The button does nothing and the
application appears hung until, some time later, recording finally starts.

Two causes, one in each layer.

The interface never said it was preparing. neuralSpeech.start() emitted only 'listening' once
the microphone was already open, and 'idle' on failure, so the several steps before that — the
module status call, module preparation, getUserMedia, the worklet module — showed no feedback at
all.

The native side blocked. PRINTER recognition keeps a global mutex for the whole transcription,
which the code itself budgets at 120 seconds for CPU-only runners. voice_prepare waited on that
same mutex, so pressing the microphone while a previous command was still being transcribed
blocked for as long as it took, with no message.

The preparation path now takes the mutex with try_lock and answers «Идёт распознавание предыдущей
команды. Подождите пару секунд и повторите.» instead of waiting. Actual recognition still queues
normally, because a command must not be dropped once the operator has spoken.

The frontend now reports 'loading' before the first await, starts the microphone-setup timing that
was previously ended without ever beginning, and gives each preparation step a deadline — 5 s for
the status call, 20 s for module preparation, 15 s for the microphone, 10 s for the worklet. A
step that exceeds its deadline produces a readable error instead of an indefinite wait.

Verified: the mutex pattern was compiled and run standalone (both the try_lock and lock branches),
tsc is clean, and the frontend builds. The Rust crate cannot be built outside the release workflow
because the build script requires prepared speech resources; the full check runs there.
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
