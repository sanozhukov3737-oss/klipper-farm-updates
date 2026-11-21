"""Apply the reviewed R238 attempt sequence over the exact sequence-175 candidate.

The previous overlay said plainly that no test covered the command's wiring: disabling record_failure left
every test green. This closes that gap.

begin_attempt and finish_attempt now own the sequence — expire the counters, check the lock, and then, once
the password has been checked, record the failure on refusal or clear the counter on success. The command
reads the decision and calls them; it no longer holds the ordering inside its own body.

Four tests on the sequence where there were none before:
- five refusals lock the account
- a success clears the counter
- checking the lock while blocked does not extend the block, since otherwise an attempt during a lockout
  would renew it indefinitely
- an expired lock clears and lets the next attempt through

Mutation-tested on exactly the mutation that used to pass. Removing record_failure from the refusal path now
fails four tests; removing clear_failure from the success path fails one.

What is still uncovered, stated rather than implied: the command still needs AppHandle to open the database
and write the audit record, so whether the command calls finish_attempt is not asserted. The sequence it
calls is covered, which is where the logic lives; the wire between them is three lines a reviewer reads.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R237 applied before R238')


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
print('Applied reviewed R238 attempt sequence over the exact sequence-175 candidate.')
