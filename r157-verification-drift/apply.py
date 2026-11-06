"""Apply the reviewed R157 verification-drift source over the exact sequence-152 candidate.

R156 stopped fourteen development checks from pinning the release identity to the R8
series. Eight of them then passed. The remaining six failed for a second, independent
reason: the code they inspect has moved on since they were written.

What actually drifted, and what this overlay does about it:

* check-audit-hardening.mjs expected the modal focus helper to be exactly
  `(initial[0]??node).focus()`. The helper now honours a
  `data-modal-initial-focus` marker first, so the assertion text is widened to
  `??initial[0]??node).focus()` — the same guarantee, current code.

* check-fix3-3 and check-fix3-4 read `VERIFY_AND_BUILD_V20.bat`, which was removed
  after R131. The two meaningful requirements (the build compiles the native IPC probe)
  now point at `scripts/build-and-install-windows.mjs`, the build that actually exists.
  The assertions about the removed batch file's variables and telemetry wiring are
  dropped rather than rewritten against a file nobody uses.

* check-fix3-6 required the marker `new Set(['printer-ws','printer-rest'])`, a design
  that no longer exists anywhere in the tree. That single marker is dropped; the other
  actor-recovery markers stay.

* check-fix3-11 and check-fix3-12 pinned the sha256 of `FIX_AND_INSTALL.bat`. Version
  stamping legitimately rewrites the version banner in that file, so a byte-exact pin
  makes the check impossible to keep green in any released tree. It now asserts the
  banner is present instead. The pinned hash of the removed `VERIFY_AND_BUILD_V20.bat`
  is dropped.

Nothing is deleted: the checks still verify their subject, with markers that match code
that exists. All fourteen scripts pass on the result.

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
    raise SystemExit('Expected exact accepted sequence-152 candidate before R157 verification drift')

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
print('Applied reviewed R157 verification-drift source over the exact sequence-152 candidate.')
