"""Apply the reviewed R236 authentication policy extraction over the exact sequence-175 candidate.

Variant A — parameterising AppHandle so the real commands run on a mock runtime — measured out at 182
occurrences across 23 files and 29 commands. Not a test, a rearchitecture with security code in the middle.

Variant B was chosen: lift the decision out of the Tauri wrapper. auth_policy now holds why a login is
allowed or refused, and it takes a &Connection plus plain values. No AppHandle, no State.

What moved: lookup_user (reading the account row), input_allowed (length limits before touching the database),
decide (the single place that answers "let them in"), and FailureBook — the counters, their expiry, the
per-user lock after five failures, the global lock against trying many names, and the bound that stops the
counter table growing when someone enumerates user names.

What stayed: opening the database, writing the audit record, creating the session. The command is a wrapper
now instead of a 171-line function containing policy.

Eleven tests, all of them on logic that previously could only be reached through Tauri:
- correct credentials with an enabled user are accepted, and the audit action differs for PIN
- a wrong hash is refused with a message that does not reveal whether the account exists
- a missing user and a disabled user produce byte-identical messages, so login cannot be used to enumerate accounts
- a row belonging to someone else is refused even when the hash matches
- length limits accept exactly 64 / 512 and refuse one more

For the counters: the fifth failure locks for five minutes and resets the count; the lock expires on its own
and is cleared by a success; the global counter catches enumeration across different names; the table stays
within MAX_FAILURE_RECORDS; expired records are removed along with the global count.

Mutation-tested, because eleven passing tests prove nothing on their own. Three mutations, all caught:
- lock threshold 5 raised to 50 — both block tests failed
- successful login no longer clearing the counter — the expiry test failed
- expired records not removed — the expiry test failed

The `test` feature on tauri stays in Cargo.toml. It cost nothing, and the attempt at variant A is worth
having on record: it compiles and shows exactly where the AppHandle boundary is.

319 tests, clippy exit 0. lib.rs 3704, auth_policy 302.

No release: behaviour is unchanged, the policy is the same code in a testable place.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R235 applied before R236')


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
print('Applied reviewed R236 authentication policy extraction over the exact sequence-175 candidate.')
