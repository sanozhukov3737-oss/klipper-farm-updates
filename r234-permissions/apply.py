"""Apply the reviewed R234 permissions extraction over the exact sequence-175 candidate with R233 applied.

Six functions and 103 lines out of lib.rs into permissions: set_private_directory_permissions,
set_private_file_permissions, restrict_windows_acl, parse_windows_sid, and both platform variants of
windowless_windows_command.

The cluster is self-contained — nothing inside it reaches session state, the database or the network — but
it is not dependency-free: fifteen call sites in twelve modules use it as `crate::set_private_*`. The
`pub(crate) use permissions::{...}` re-export keeps every one of them unchanged, which is why this move is
safe rather than merely tidy.

Platform attributes moved with the functions, and getting that wrong cost two rounds. `#[cfg(windows)]` on
restrict_windows_acl and on the Windows variant of windowless_windows_command, `#[cfg(not(windows))]` on the
other, `#[cfg(any(windows, test))]` on parse_windows_sid. Their imports came along too —
CommandExt and CREATE_NO_WINDOW — but those stay in lib.rs as well, because offline_voice and
offline_semantic use them for their own child processes.

Two things I broke by cleaning too eagerly, recorded because both are the same mistake: I removed
re-exports that looked unused in a non-test build, and lib_tests.rs and the rpc tests promptly failed to
compile. `cargo check` passes without them; `cargo test --lib --no-run` does not. A re-export that only
tests use still needs a gate, not deletion — the lib and lib-test profiles see different code.

lib.rs is 3606 lines now, from 4750 at the start of this sequence, with permissions 103, local_library_paths
102 and rpc 1029 as separate modules.

Verified: cargo check and cargo test --lib --no-run both clean with zero warnings, 300 tests passing with
KF_TEST_PYTHON set as the pipeline sets it, clippy exit 0 with let_underscore_must_use.

Authentication is next and is not the same kind of change: 591 lines across 27 functions touching sessions,
password hashing, PIN and Windows Hello. It needs tests that assert its behaviour before it moves, not after.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R233 applied before R234')


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
print('Applied reviewed R234 permissions extraction over the exact sequence-175 candidate with R233 applied.')
