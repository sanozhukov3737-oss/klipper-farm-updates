"""Apply the reviewed R272 recognition-hint removal over the exact sequence-175 candidate.

The hints were switched on with a reasonable expectation: names the interpreter already knows should help it
hear those names. Measuring it against real audio on this machine showed the opposite, reproducibly.

Twelve farm phrases were synthesised with Silero, recognised with the shipped whisper small model and Russian
language, and scored on whether the printer and file named in the phrase survived. Without hints, 11 of 13
name occurrences survived. With the full hint list the application actually sends — printer names plus library
file names, up to sixteen entries — 8 of 13 did. A shorter list of printer names only scored 10 of 13 and, worse,
drove the model into transliteration: "Ксения, закинь держатель на Макс" came back as "SENI ZAKIN DERJATEL
NAMAX". Two consecutive runs of both variants reproduced 11 and 8 exactly, so this is a property of the setup
rather than a lucky sample.

setContextHints now keeps the mechanism and the signature but stores an empty list, with the measurement written
beside it. The name forms recognition produces are handled where they belong instead — the alias table gained
"форш", "форжи", "кет", "Индире" and the SE spellings in R271, which is why removing hints does not lose the
names.

One test asserted that hints reach the transcription call. It now asserts the opposite, with the reason next to
it: the mechanism stays callable and the recording is unaffected, but nothing is forwarded.

Two mistakes of mine are worth recording because they cost most of the time. The first accuracy run wrote each
sample to a file named after the phrase length, so two phrases of equal length overwrote each other and the
results were nonsense. The second passed the audio through /tmp, which the native whisper binary cannot open on
Windows; it exited with code 2 and my harness scored the resulting empty transcript as a recognition failure.

Verified: 11 of 13 with hints removed, reproduced twice; 140 regression scripts pass; check-neural-speech is 23
cases.

No release: recognition accuracy and the test that guards it.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R271 applied before R272')


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
print('Applied reviewed R272 recognition-hint removal.')
