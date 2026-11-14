"""Apply the reviewed R198 microphone preparation over the exact sequence-163 candidate.

Built from the chain at the position where R198 runs: after R197, before R199.

The native side blocked. Recognition keeps a global mutex for the whole transcription, budgeted at
120 seconds for CPU-only runners, and voice_prepare waited on that mutex without a bound. Pressing
the microphone while a previous command was still being transcribed blocked silently, which the
operator saw as a freeze. A first attempt used try_lock and refused immediately — that broke the
installed-speech check, because the interface prepares recognition and synthesis in parallel with
Promise.all, and an instant refusal rejects a legitimate call.

Preparation now waits for the mutex for up to two seconds and only then answers «Идёт распознавание
предыдущей команды. Подождите пару секунд и повторите.». A parallel second call is served within
that window; a genuinely busy transcription still produces a readable message instead of a freeze.
Recognition itself keeps the unbounded wait, because a spoken command must not be dropped.

The interface already reported the loading state and began the microphone-setup timing in the base —
an earlier version of this overlay duplicated both and that duplication is gone. What remains is
four deadlines on preparation steps: 5 s status, 20 s module, 15 s microphone, 10 s worklet.
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
