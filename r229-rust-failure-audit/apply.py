"""Apply the reviewed R229 Rust silent-failure audit over the exact sequence-174 candidate.

Two hundred fifty eight `let _ =` in the Rust tree, none of them ever reviewed. This categorises them
first, because "258 ignored results" is not a finding — the question is which ones lose data.

The shape of the answer:

    128  cleanup: removing files and directories
     42  uncategorised on first pass, examined individually
     21  wake signals and notifications
     19  diagnostics journal
     16  replies into a channel whose receiver may have gone
     15  waiting for a child process
      5  flushing a log writer
      5  UI events
      4  joining a thread
      2  rollback renames
      1  file truncation

Two of them were real defects.

The rollback renames, both in local_library_commands. Writing a file parks the previous version under a
random `.klipper-farm-backup-<hex>.tmp` name, then moves the new file into place, and on failure moves
the backup back. If that second move also failed, the operator's file stayed under a random name and the
error said only why the write failed — not where their file was. They would go looking for a file that
had moved somewhere they could not guess. The error now names the backup path.

The other was the audit record for a failed login. Successful logins propagate the audit error; failed
ones discarded it. So a brute-force attempt against a login screen could leave no trace at all in the
audit log. It now reports the write failure through the observability channel — and deliberately keeps
returning the original authentication error, because letting an audit failure replace "wrong password"
would confuse the operator and tell them something about the storage they do not need.

Two more looked alarming and are not. `let _ = migrations::migrate_with_backup(...)?` discards nothing:
the `?` propagates the error, so `let _` only drops the `()`. It is noise rather than a bug, and left
alone rather than churned.

The guard is `clippy::let_underscore_must_use`, enabled in the build at warning level. It fires 244 times
on the existing tree — the cleanup and channel categories above — so it does not fail the build, but a
new silent discard of a `#[must_use]` result is now visible the moment it is written. Enabling it as an
error would mean annotating 244 sites in one commit, which is the same mistake as the 27 floating promises
in the frontend: volume does not make a change safe.

Verified: cargo check clean, clippy exit code 0 with the new lint, and 280 Rust tests passing with
KF_TEST_PYTHON set the way the pipeline sets it.
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
    'installedSequence': 174,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-174 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-174 candidate before R229 Rust audit')


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
print('Applied reviewed R229 Rust silent-failure audit over the exact sequence-174 candidate.')
