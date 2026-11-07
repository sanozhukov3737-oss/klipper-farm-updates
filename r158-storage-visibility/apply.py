"""Apply the reviewed R158 storage-visibility source over the exact sequence-152 candidate.

R154 moved the application data to a single resolver, so on a machine with a D: volume
the database, logs, G-code library, diagnostics, update cache, WebView2 profile and
temporary files no longer land on the system drive. Nothing told the operator any of
that: the path was invisible, could not be changed from the interface, and a machine
without a D: volume silently stayed on %APPDATA%.

This overlay adds one read-only command and one settings card:

* `src-tauri/src/storage_commands.rs` reports the resolved root, how it was chosen
  (environment variable, preferred D: volume, or the legacy AppData directory), the free
  space on that volume, and whether the data sits on the system drive while D: is
  available. It requires the Admin role because a disk path is operator information.
* `storage_paths::preferred_roots` becomes crate-visible so the command can answer
  "would a move be possible".
* The System settings panel shows the path in the "Приложение" tab, warns below 2 GB of
  free space, and explains what to do when D: is available but unused.

The command does not move anything. Moving data is a destructive operation on a live
database and is deliberately not attached to a button: the card tells the operator to
set KF_HOME and restart.

Three unit tests cover the source classification and the subdirectory report.

No publication. No change to the updater channel or the release identity.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 152}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-152 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-152 candidate before R158 storage visibility')

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
            raise SystemExit('Existing source differs; refusing overwrite: ' + row['path'])
    rows.append((target, source))
for target, source in rows:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical(source.read_bytes()))
print('Applied reviewed R158 storage-visibility source over the exact sequence-152 candidate.')
