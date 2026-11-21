"""Apply the reviewed R242 database and audit extraction over the exact sequence-175 candidate.

Database, audit and notifications were the next domain in lib.rs: 12 functions, 387 lines. All of them moved
into db_commands — the key-value commands (db_get_json, db_set_json, db_delete_json, db_list_keys), the role
policy that decides which keys may be written (db_write_role), the audit journal (insert_audit, audit_add,
audit_list), the backup and restore pair, and the notification feed with its allowlist
(notification_list, notification_action_allowed).

lib.rs is 2722 now. Counting the whole refactor: 4750 to 2722, with rpc 1029, auth_commands 620, db_commands
423, permissions 103 and local_library_paths 102 carrying what left.

db_write_role stays adjacent to the commands that enforce it, because the policy and the writes it governs
are meaningless apart. The audit chain module keeps its own file; db_commands only calls into it.

Two things this round taught, both repeats of earlier mistakes worth naming.

I wiped lib.rs with a script that wrote a list instead of a string, and only noticed because the next command
failed on a zero-line file. The recovery was copying the working tree from the previous overlay — which only
worked because that tree still existed. I will treat every destructive write as needing a fresh copy first.

And db_write_role is reached from lib_tests, so it needs a #[cfg(test)] re-export. That is the third time in
this refactor the lib and lib-test profiles disagreed about what is used: cargo check says unused, the test
build then fails to find it. The distinction belongs in the re-export from the start.

check-farm-upgrades read the notification feed by slicing lib.rs between notification_list and users_list — a
boundary that only made sense while both lived in one file. It now reads db_commands and bounds the slice by
the next command attribute, the same repair check-search-art needed after R232.

Verified: cargo check clean with zero warnings, 330 Rust tests passing, clippy exit 0, 113 of 115 regression
scripts pass — the two failures need the prepared speech assets.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R241 applied before R242')


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
print('Applied reviewed R242 database and audit extraction over the exact sequence-175 candidate.')
