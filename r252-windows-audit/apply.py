"""Apply the reviewed R252 Windows audit read scope over the exact sequence-175 candidate.

audit-windows-native was reading only lib.rs and asserting against two groups of markers that no longer
live there. The ACL path moved to permissions.rs in r234 and the desktop launch assembly moved to app.rs
in r243, so both loops failed on the first marker they looked for — "Windows ACL path is missing
whoami.exe" — and the script has been red since r234 while still being the gate that
verification-lab and verification-lab-v20 run on every build.

Eleven of thirteen markers were in the moved modules: whoami.exe, /user, format!("*{sid}"), *S-1-5-18 in
permissions.rs; window.show(), window.is_visible(), EngineClient::initialize_background,
DesktopSmoke::from_process_args, DESKTOP_WINDOW_READY_TIMEOUT and app.manage(lease) in app.rs. Only
parse_windows_sid, windowless_windows_command and CREATE_NO_WINDOW were still reachable from lib.rs.

The read set is now lib.rs plus permissions.rs plus app.rs. That is safe for the three assertions in this
block that are not plain membership tests, and each was checked against the concatenation before the
edit rather than after:

The ordering assertion InstanceLease::acquire() < tauri::Builder::default() still holds, because both
now resolve inside app.rs at lines 44 and 72. The negative assertion that USERNAME and USERDOMAIN are
never read from the environment stays true, because neither string exists in any of the three files. The
regex asserting that .manage(lease) never appears after .setup( stays false, because app.rs has .setup(
at line 113 and app.manage(lease) at line 140, and neither lib.rs nor permissions.rs contains .setup( at
all — so concatenation cannot manufacture the pattern across a file boundary.

Verified: the script exits 0 and reports both of its self-tests; cargo check stays clean at zero errors
and zero warnings; whole-suite failures drop from 27 to 25 with nothing new failing. verification-lab
no longer stops here and now proceeds past the native audit.

No release: verification repair only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R251 applied before R252')


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
print('Applied reviewed R252 Windows audit read scope over the exact sequence-175 candidate.')
