"""Apply the reviewed R250 Python interpreter resolution over the exact sequence-175 candidate.

Seven Rust tests in offline_voice build a Command from the KF_TEST_PYTHON environment variable and fail
with a bare expect() panic when it is unset. Nothing in the repository ever set it: not
run-rust-tests.mjs, not either workflow. So the Rust test step has been red on every build, and the
panic message — "test Python path: NotPresent" — reads like a broken test rather than a missing
prerequisite.

The runner now resolves the interpreter once, before any cargo call, and passes it to all three:
the --list inventory, the Windows single-threaded run and the plain run everywhere else.

Order of resolution: an explicit KF_TEST_PYTHON wins, and is verified by actually executing it — a
configured but broken path is reported as such instead of silently falling back. Otherwise `py -3` is
tried first on Windows, because a bare `python` there can be the Microsoft Store alias that resolves to
a stub; then `python`, then `python3`. Each candidate prints sys.executable, and the path it reports is
executed again before being accepted, so a launcher that answers but cannot run is rejected.

If nothing usable is found the run stops immediately with three lines naming the missing prerequisite
and how to satisfy it, rather than seven panics from inside individual tests. That is stricter than
skipping them, and deliberate: these tests execute a real process with pipes, timeouts and bounded
reads, and reporting them as passing without an interpreter would be a lie about coverage.

Verified: node --check clean, the whole runner exits 0 with KF_TEST_PYTHON unset and reports 310 passed
/ 0 failed / 2 ignored, a broken KF_TEST_PYTHON fails with the interpreter path in the message, an
emptied PATH fails with the prerequisite message, and the five scripts that read this runner
(check-farm-upgrades, check-fix3-6, check-fix3-10, check-fix3-13, check-fix3-14) still pass.

No release: build verification repair only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R249 applied before R250')


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
print('Applied reviewed R250 Python interpreter resolution over the exact sequence-175 candidate.')
