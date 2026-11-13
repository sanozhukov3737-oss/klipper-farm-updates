"""Apply the reviewed R197 release sequence over the exact sequence-162 candidate.

Sequence 162 is published, so the work from R194 through R196 would reach nobody: the printer
number that was not heard, the mutilated numbers and file names, and the fault reasons that read
as fragments. This raises the packaged channel to 163 and the identity to R15.13, the released
application version 1.15.13.

It carries three overlays:

* R194 reads the printer number digit by digit — «кей ноль два» instead of «кей два» — and
  stresses quoted speech while keeping file tokens, unknown names and omographs untouched.
* R195 joins grouped numbers, so «1 250 граммов» is one number rather than two; spells «G-code»
  instead of leaving «G-»; and stops treating file names as phrases.
* R196 announces the reason a print failed in Russian, from the Klipper keywords, instead of
  reading stripped fragments of English.

The workflow's three sequence-bound expectations move with this and R197 joins the chain.
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
    'installedSequence': 162,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-162 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-162 candidate before R197 release sequence')


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
print('Applied reviewed R197 release sequence over the exact sequence-162 candidate.')
