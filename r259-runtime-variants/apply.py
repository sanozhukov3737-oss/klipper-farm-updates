"""Apply the reviewed R259 runtime-variant tests over the exact sequence-175 candidate.

The understanding runtime ships two builds: a generic llama-server and one compiled with AVX2, FMA, F16C
and BMI2. executable() prefers the optimized one only when the CPU advertises all four features and the
file is present, falling back to the generic binary otherwise. That rule was the one piece of the offline
understanding path with no test at all, and it decides silently: a wrong choice here turns a slow answer
into no answer, with the reason buried in a launcher that never ran.

Two tests now pin it.

The first installs only the generic binary and asserts that the optimized one is not selected however
capable the CPU is, because pointing at a missing file is the failure mode that produces no message. It
then installs both and asserts the choice follows CPU support and nothing else.

The second pins availability to the same rule. SemanticStatus.available is computed from
executable(&root).is_file(), so a status that reports ready while the launcher would pick a binary that is
not there sends the user to an error after the model is loaded and the wait is spent. The test fails if
those two rules ever diverge.

Verified: both tests pass against the current code and both fail when the `optimized.is_file()` guard is
removed, which is the regression they exist to catch; the full Rust suite is 312 passed, 0 failed, 2
ignored, up from 310.

This is test coverage for behaviour that already worked, not a fix for a known defect. The avx2 path was
not proven broken; it was unproven either way, and now it is pinned.

No release: test coverage only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R258 applied before R259')


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
print('Applied reviewed R259 runtime-variant tests over the exact sequence-175 candidate.')
