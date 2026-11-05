"""Apply the reviewed R154 disk-root storage source over the exact sequence-151 candidate.

Windows installs wrote everything to the system drive: the database, logs and the
G-code library into %APPDATA%, the diagnostics and update caches plus the WebView2
profile into %LOCALAPPDATA%, and the Telegram payload files into %TEMP%. On a machine
with a small system partition that is what fills C:.

The reviewed change adds one resolver (src-tauri/src/storage_paths.rs) and makes every
reader of a data directory go through it:

* KF_HOME, then KLIPPER_FARM_DATA_DIR, then D:\\KlipperFarmData, then %APPDATA%;
* a missing D: volume is not an error, the application stays on %APPDATA%;
* an existing database in the legacy root is never abandoned silently;
* logs, diagnostics, verified-updates, print-snapshots, the Telegram payload files and
  the WebView2 profile all live inside the chosen root.

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
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 151}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-151 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-151 candidate before R154 disk-root storage')

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
print('Applied reviewed R154 disk-root storage source over the exact sequence-151 candidate.')
