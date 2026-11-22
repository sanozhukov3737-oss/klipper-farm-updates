"""Apply the reviewed R246 local library file operations over the exact sequence-175 candidate.

Seven functions and 221 lines moved from lib.rs into local_library_commands, which already held the commands
that call them: listing, listing the legacy shared directory, reading a file and a prefix of one, comparing
file identity, creating a parent directory and validating a parent path.

lib.rs is 1457. Counting the refactor: 4750 to 1457, a 69% reduction, with rpc 1029, local_library_commands
1377, upload_commands 760, auth_commands 620, db_commands 423, app 199, discovery_merge 199, permissions 103
and local_library_paths 102 carrying what left.

The move needed almost no import work, because local_library_commands opens with `use super::*;` — everything
it reaches from the crate root was already in scope, so the functions found their dependencies where they
landed. Only two of the seven are still called from the root itself, create_local_library_parent and
validate_local_library_parent, and those are re-exported; the rest are private to the module and its tests.

I wiped lib.rs again. A script wrote a list where a string was expected, exactly as in R242, and the file
came out empty — visible only because the very next command reported zero lines. The recovery was copying
lib.rs from the previous working tree. That is now twice; the copy step before each round is what makes the
recovery cheap, and I should stop writing these scripts without checking the type they assign.

Verified: cargo check clean with zero warnings, 330 Rust tests pass, and 113 of 115 regression scripts pass —
the two failures need the prepared speech assets.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R245 applied before R246')


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
print('Applied reviewed R246 local library file operations over the exact sequence-175 candidate.')
