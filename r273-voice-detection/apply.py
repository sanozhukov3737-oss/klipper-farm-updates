"""Apply the reviewed R273 voice-detection repair over the exact sequence-175 candidate.

The existing VAD had never been measured beyond two extremes, 0 and 0.12. Trying realistic workshop levels
found both a false-accept and a truncation.

Measuring the old rule: steady background at 0.010, 0.020 and 0.040 all reached recognition with nobody
speaking. The noise estimate only adapted *before* the first speech classification —

    else if(!this.lastSpeech) this.noise = this.noise*0.95 + Math.min(rms,0.01)*0.05

— so one spurious block froze the floor at 0.002 permanently, and the floor input was capped at 0.01, so the
threshold could never exceed 0.03. On a farm with printers running, that means the assistant transcribes the
room.

Measuring the fix found a second problem in my own first attempt. An exponential noise floor adapts too slowly:
over two seconds of noise it was still learning while blocks were already being counted. A sliding minimum
tracks the floor in two hundred milliseconds instead. But a minimum that keeps updating during speech rises
into the speech itself, and every variant of that design cut a three-second command down to 0.5–1.4 seconds.
The window is therefore frozen while speech is running, with a 1.2-second hangover.

One more condition was needed and is the honest part. A minimum is only trustworthy if quiet was actually
observed; a recording that begins with loud steady sound gives nothing to learn from. In that case the absolute
floor applies, which keeps a command spoken immediately after pressing the button from being discarded. The
residual limit is stated in the check: steady loud noise from the very first block with no quiet sample is not
separable from speech by level, and a real VAD model is the proper answer.

check-voice-vad.mjs replaces the two-value test with twelve scenarios: silence, background 0.010 to 0.060, quiet
speech 0.020, speech over background at 2x and 2.5x, a three-second command that must not be truncated, and the
two known limits recorded as expectations rather than hidden. It fails against the old rule and passes against
this one.

Verified: 12 of 12 scenarios; 141 regression scripts pass; check-neural-speech keeps its 23 cases.

No release: voice activity detection and its measurement.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R272 applied before R273')


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
print('Applied reviewed R273 voice-detection repair.')
