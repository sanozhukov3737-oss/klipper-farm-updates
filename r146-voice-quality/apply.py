"""Apply the voice revision to the reviewed R145 application source; no publication."""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json

parser = argparse.ArgumentParser()
parser.add_argument('application', type=Path)
args = parser.parse_args()
root = args.application.resolve()
patch = Path(__file__).resolve().parent
manifest = json.loads((patch / 'source-manifest.json').read_text())


def sha(path):
    if not path.is_file():
        return None
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text())
if channel['installedSequence'] != 144:
    raise SystemExit('Expected the R144-based preview update channel')
for row in manifest['files']:
    path = PurePosixPath(row['path'])
    if path.is_absolute() or '..' in path.parts:
        raise SystemExit('Unsafe revision path')
    current = sha(root / row['path'])
    if current not in (row['beforeSha256'], row['sha256']):
        raise SystemExit('Source changed; refusing to overwrite ' + row['path'])
    if sha(patch / 'changes' / row['path']) != row['sha256']:
        raise SystemExit('Revision checksum differs: ' + row['path'])
for row in manifest['files']:
    target = root / row['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes((patch / 'changes' / row['path']).read_bytes())

identity = 'V20.6-R14.5-OFFLINE-VOICE-PREVIEW2-2026-10-28'
(root / 'RELEASE-BUILD-ID.txt').write_text(identity + '\n')
for name in ['scripts/check-r9-clean-installer.mjs', 'scripts/check-release-portability.mjs']:
    target = root / name
    source = target.read_text()
    for old in ['V20.6-R14.5-OFFLINE-VOICE-PREVIEW-2026-10-28', 'V20.6-R14.4-PRINTER-FAULT-RECOVERY-2026-10-28']:
        source = source.replace(old, identity)
    target.write_text(source)
print('Applied local voice revision. Next prepare speech assets, test, and build Windows. Stable sequence remains 144.')
