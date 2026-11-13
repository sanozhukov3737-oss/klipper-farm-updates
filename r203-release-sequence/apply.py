"""Apply the reviewed R203 release sequence over the exact sequence-163 candidate.

Sequence 163 is published, so the speech work from R198 through R202 would reach nobody. This
raises the packaged channel to 164 and the identity to R15.14, the released application version
1.15.14.

Two overlays carry fixes found by probing the real runtime rather than the code:

* R198 gives microphone preparation a deadline in the interface and stops the native side from
  blocking on a mutex held by the previous transcription.
* R199 completes stress coverage — short words the generator skipped and the numeral «ноль»,
  which num2words produces but the list lacked.
* R200 stops a hyphen in a name from reading as «минус», reads latin names by letter instead of
  deleting them, and keeps long numbers and over-long text from raising and silencing the whole
  announcement.
* R201 queues announcements instead of dropping the second one, and reports what was actually
  heard rather than what was queued.
* R202 bounds synthesis in time and cuts text at a word boundary.

The workflow's three sequence-bound expectations move with this and R203 joins the chain.
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
print('Applied reviewed R203 release sequence over the exact sequence-163 candidate.')
