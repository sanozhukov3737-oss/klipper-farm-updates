"""Apply the reviewed R174 recognition-accuracy source over the exact sequence-157 candidate.

Four defects measured while tuning the assistant, in order of impact:

1. The Whisper prompt carried about 100 characters of the 224-token budget, so domain words
   the user actually says - держатель, втулка, катушка, сопло, подсветка, ПЭТГэ - had no
   hint at all. The prompt now lists that vocabulary.
2. Recorded audio went to Whisper without level normalisation. A quiet voice, or a
   microphone a metre away, lost half the phrase. speechWave() now normalises to -20 dBFS
   with a bounded gain, so room noise is not amplified to speech level.
3. Recognition had no confidence at all: callbacks.text(text, 0) always passed zero. The
   worker now returns the geometric mean of token probabilities, Rust parses it into a
   TranscriptionResult, and the assistant asks to repeat below 0.72 instead of running a
   command the model barely heard. Measured on the reference recording: 0.9107.
4. Nothing recorded what was heard, so the stress dictionary could only be fixed by guess.
   Each recognition now writes voice.recognized to the farm audit log with the confidence
   and the phrase.

The worker protocol stays backward compatible: a response without the confidence prefix is
still accepted and treated as certain.
"""

from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 157}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-157 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-157 candidate before the R173 sequence bump')

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
applied = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
if applied['installedSequence'] != 157:
    raise SystemExit('Sequence bump did not reach the packaged channel')
print('Applied reviewed R174 recognition-accuracy source over the exact sequence-157 candidate.')
