"""Apply the reviewed R235 authentication tests over the exact sequence-175 candidate.

Before moving 591 lines of authentication, prove it can be tested at all. This adds eight tests over the
part that runs on a plain connection and plain data — no Tauri, no real database file.

The fixture uses `initialize_base_schema` rather than a hand-written CREATE TABLE. That matters: a
hand-made schema drifts from the real one silently, and the tests keep passing while asserting nothing
about the code that ships. There is also an explicit assertion that BOOTSTRAP_CREDENTIALS_SQL changes
exactly one row, so a test cannot pass on an empty table.

What is covered: password round trip and rejection of near-misses; the hash carrying its own parameters
and a per-hash salt; weak passwords refused before hashing; a tampered hash rejected; PIN salting per user;
credentials-configured reflecting the row rather than a cache; and the rule that the last way into the
account cannot be removed.

Then mutation-tested, because a passing test proves nothing until it fails when the code is wrong. Two
mutations were applied and both were caught:

1. Removing the lower bound on the iteration count from verify_password. The first version of my test did
   not catch it — it asserted that a hash with one iteration is rejected, but it passed for the wrong
   reason, because the hash simply did not match. Rewritten to compute a *correct* one-iteration hash with
   the same salt, so the only thing that can reject it is the range check. The mutation then failed the
   test.
2. Making ensure_pin_removal_keeps_access always return Ok. Caught immediately.

That first mutation is the lesson worth keeping: a test that passes for an unintended reason is worse than
no test, because it looks like coverage.

309 tests total now (300 before, 8 added, one existing renamed count).

What is not covered, and cannot be without enabling tauri::test: auth_login_internal itself, the 171-line
function with the rate limiting and session creation, and user_save at 100 lines. Both need AppHandle and
State<AuthState>. Enabling the tauri "test" feature is a Cargo.toml change, so it needs a decision rather
than a guess.

No release: tests only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R234 applied before R235')


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
print('Applied reviewed R235 authentication tests over the exact sequence-175 candidate.')
