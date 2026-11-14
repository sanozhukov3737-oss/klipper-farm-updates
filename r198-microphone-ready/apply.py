"""Apply the reviewed R198 microphone deadlines over the exact sequence-163 candidate.

The reported symptom was a freeze: pressing the microphone did nothing visible while the module
prepared. The native side is not the culprit and is left untouched here.

Preparation legitimately takes tens of seconds the first time a model loads, and callers prepare
in parallel: the assistant panel runs Promise.all over recognition and synthesis when it opens and
again whenever the recognition model changes, while the recording start prepares recognition once
more. Serialising or refusing those calls breaks a valid use case — an earlier attempt at this
overlay used try_lock with a two second window and the installed-speech check failed on exactly
that, because the panel's own warm-up was still loading the model.

What was missing was a bound on the waiting side, not on the work. Each preparation step now has a
deadline and reports it in words: 5 s for the status call, 90 s for module preparation — a first
model load, not a hang — 15 s for the microphone and 10 s for the worklet. Without them a stalled
step held the interface silently forever.
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
    raise SystemExit('Expected the accepted sequence-163 candidate before R202 synthesis bounds')


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
print('Applied reviewed R198 microphone deadlines over the exact sequence-163 candidate.')
