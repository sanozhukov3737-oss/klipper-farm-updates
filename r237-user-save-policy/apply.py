"""Apply the reviewed R237 user_save policy over the exact sequence-175 candidate.

Variant B again: validate_user and sessions_must_be_revoked take plain values, so the rules that decide
whether a user record may be written are testable without Tauri. Moved out of the command: id
normalisation, name limits, the rule that the built-in admin cannot be disabled or demoted, the refusal to
set and clear a PIN at once, and the requirement that a new user has some way to log in.

Eight tests, and they caught my own mistakes first: I wrote IDs in Cyrillic and expected one-character IDs to
pass, while the real rule is 3 to 64 characters of a-z0-9._-. The tests were wrong, not the code.

One test did find a real defect. sessions_must_be_revoked returned true for a brand new user, because
credentials_changed was true and there was no previous row to compare against — which would have revoked
sessions under an empty id on every user creation. Fixed before it shipped.

The serious part of this change is what I broke and how it was found. While rewiring the command I removed
the failure counting entirely: the refusal path returned straight through, so a wrong password incremented
nothing and brute-force protection was gone. I noticed it from a dead-code warning for record_failure, not
from a test. It is restored, with the audit record for a failed login beside it.

That gap is stated rather than hidden: no test covers the command's wiring. Mutation-testing it — disabling
record_failure again — left every test green, because what is tested is the policy and not the call that
applies it. The next overlay closes that.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R236 applied before R237')


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
print('Applied reviewed R237 user_save policy over the exact sequence-175 candidate.')
