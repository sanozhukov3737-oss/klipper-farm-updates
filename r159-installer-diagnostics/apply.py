"""Apply the reviewed R159 installer-diagnostics source over the exact sequence-152 candidate.

The reported failure was "update was not installed. Installer exit code: 2". Code 2 is
NSIS aborting, but the installer kept its reason in $PLUGINSDIR, which NSIS deletes
with itself, so the operator and the logs only ever saw the bare number. The same
message had been arriving repeatedly, with no way to tell which of the three abort
paths fired.

This overlay makes the failure legible and removes the most common cause:

* `installer-hooks.nsh` gains KF_WRITE_FAILURE_REASON, which writes the reason into
  $INSTDIR as `.klipper-install-failure.txt` before each of the three aborts (component
  verification, Start menu shortcut, desktop shortcut). The next install deletes a
  stale file in PREINSTALL.
* `apply-online-update.ps1` reads that file and appends it to the exit code, so the
  dialog and last-error.txt now say what actually failed instead of "exit code: 2".
* The same script retries the installer once, after 15 seconds, and only for exit
  code 2. That code means the installer aborted before copying anything, so a retry is
  idempotent; it covers the plausible transient causes (antivirus still holding a
  freshly scanned exe, a file not yet released). The installer digest is re-asserted
  before the retry. Other exit codes are never retried.

Existing component fixtures still pass (12 tests). No publication, no channel change.
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
    raise SystemExit('Expected exact accepted sequence-152 candidate before R159 installer diagnostics')

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
print('Applied reviewed R159 installer-diagnostics source over the exact sequence-152 candidate.')
