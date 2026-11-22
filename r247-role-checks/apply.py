"""Apply the reviewed R247 role checks and library root over the exact sequence-175 candidate.

Eight more functions left lib.rs, and they split by domain rather than by size.

require_role, validate_password, validate_key and pbkdf2_sha256 went into auth_commands, where the session
code that uses them already lives. pbkdf2_sha256 had to be re-exported only under cfg(test), since nothing in
production calls it from the root — the same distinction applied correctly this time without being told.

local_library_root, prune_empty_local_library_parents, snapshot_directory and snapshot_extension went into
local_library_commands.

lib.rs is 1294, down from 4750 — a 73% reduction. The modules now: local_library_commands 1377, rpc 1029,
upload_commands 760, auth_commands 774, db_commands 423, app 199, discovery_merge 199, permissions 103,
local_library_paths 102.

Three things crossed that were not functions. SESSION_IDLE_MS and SESSION_ABSOLUTE_MS became pub(crate) so
auth_commands can read them, and the HmacSha256 alias that pin hashing needs moved with the hashing rather
than staying behind as a dead type. Two names had to leave the auth import list, because a function defined
in the module cannot also be imported into it — the compiler called that a duplicate definition, which is the
correct reading.

A check broke for a reason worth keeping: check-farm-upgrades asserted that snapshot_extension, the 12 MB size
limit and the 500-entry retention all live in lib.rs. They were never in one place — the extension is in the
library, the size and retention are in system_commands — but the assertion held while all three happened to be
reachable from the same file. It now names the file for each marker, which is what it always meant.

Verified: cargo check clean with zero warnings, 330 Rust tests pass, clippy exit 0, 113 of 115 regression
scripts pass.

No release: refactor only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R246 applied before R247')


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
print('Applied reviewed R247 role checks and library root over the exact sequence-175 candidate.')
