"""Apply the reviewed R241 authentication module extraction over the exact sequence-175 candidate.

lib.rs was 3659 lines with 99 functions. Authentication was the largest single domain inside it: 34
functions and 601 lines, counting the wrappers, the password and PIN hashing, session creation and the
Windows Hello path.

All 31 that belong there moved into auth_commands: the commands (auth_login, auth_pin_login, auth_logout,
auth_status, auth_bootstrap, auth_change_password, the four Hello commands), the user management commands
(user_save, user_delete, users_list), the internals they call (auth_login_internal, user_by_id,
users_list_internal, auth_credentials_configured, validate_user_id, ensure_pin_removal_keeps_access,
new_session, revoke_user_sessions), and the hashing (hash_password, verify_password, hash_pin, verify_pin,
hello_entry, hello_grant, hello_grant_matches, hello_verify).

lib.rs is 3110 now, down from 4750 when this refactor started. Three modules carry what left: auth_commands
620, rpc 1029, permissions 103, local_library_paths 102.

The re-export pattern is the same one that worked for rpc: `pub(crate) use auth_commands::{...}` keeps
invoke_handler and every call site unchanged. Two wrinkles were not obvious.

The types had to open up. AuthStatus, AuthSession, SessionRecord, FailureRecord, AuthInner, HelloGrant and
HelloStatus were private to the crate root; a submodule cannot see them, so they became pub(crate) — one
keyword each, no behaviour.

The re-export has two tiers. user_by_id, users_list_internal and validate_user_id are needed by auth_policy
and by the crate root in production, so they are exported unconditionally. auth_login_internal,
hash_password and the rest are reached only from lib_tests, so they keep #[cfg(test)] — the same distinction
that cost two rounds in R234 when I deleted test-only re-exports because cargo check called them unused.

Four checks had to learn where the code went: check-security (PIN hashing and the PIN login command),
check-access-light (Hello re-verification and PIN removal), check-audit-hardening (constants stayed in the
root, the logic moved — so the assertion now names which file each marker lives in rather than assuming one).

Verified: cargo check and cargo test --lib --no-run clean, 330 Rust tests passing with KF_TEST_PYTHON set as
the pipeline sets it, clippy exit 0 with let_underscore_must_use, and 113 of 115 regression scripts pass — the
two failures need the prepared speech assets the pipeline supplies two steps earlier.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R240 applied before R241')


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
print('Applied reviewed R241 authentication module extraction over the exact sequence-175 candidate.')
