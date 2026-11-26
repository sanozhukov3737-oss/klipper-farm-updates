"""Apply the reviewed R261 published-channel network handling over the exact sequence-175 candidate.

R258 moved check-release-published out of the source group because it failed whenever GitHub was
unreachable. That hid a working check instead of fixing it, and it made the suite's verdict depend on how
the check happened to be classified rather than on what it found.

The check now separates two outcomes it had been conflating. A published channel that answers 404 is a
defect and still fails, with exit code 1. A machine that cannot reach GitHub at all has verified nothing,
so it says so on stderr and exits 3. Three attempts with a growing pause sit in front of both, because one
dropped connection on a working network should decide nothing.

The runner treats exit code 3 as a skip that names its reason, not as a pass and not as a failure, and
check-release-published returns to the source group. Before this, the suite reported 135 passed and the
check was never executed; now it reports 136 passed with the check actually running.

One environment detail cost two attempts and is worth recording: on Windows, Node 24 aborts with a libuv
assertion and exit code 127 when process.exit() runs while a fetch handle is still open. That turned a
clean 404 into an unexplained 127 and hid the message. The script sets process.exitCode and lets the loop
drain instead, and the first draft of this overlay was discarded after it put a block inside the retry loop
by textual replacement — the committed version is edited by line index against the untouched original.

Verified by exit code in three states: 0 with the real channel reachable, 1 with a repository that answers
404, and 3 with fetch stubbed to raise ENOTFOUND, which prints NOT_VERIFIED and the failing URL. The
regression suite is 136 passed, 0 failed, 21 skipped.

No release: verification tooling only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R260 applied before R261')


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
print('Applied reviewed R261 published-channel network handling over the exact sequence-175 candidate.')
