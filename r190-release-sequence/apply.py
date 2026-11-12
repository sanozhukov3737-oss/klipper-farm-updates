"""Apply the reviewed R190 release sequence over the exact sequence-161 candidate.

Sequence 161 is published, so the camera negotiation fix from R189 and the numeral stress from
R188 would reach nobody. This raises the packaged channel to 162 and the identity to R15.12,
the released application version 1.15.12.

It carries two changes:

* R188 stressed the numerals num2words produces at speech time — дв+ести, пятьдес+ят, ц+елая
  and the rest — which no interface string contains and the model had been guessing.
* R189 rebuilt the WebRTC negotiation to match the camera's own test page: STUN, a sendrecv
  transceiver, default codec order, and the offer posted only after the null ICE candidate.
  Sending it earlier produced an answer without media, which is what the operator saw as
  "Камера не передаёт видеокадры".

The workflow's three sequence-bound expectations move with this, and R190 joins the chain.
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
    'installedSequence': 161,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-161 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-161 candidate before R190 release sequence')


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
print('Applied reviewed R190 release sequence over the exact sequence-161 candidate.')
