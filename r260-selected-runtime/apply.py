"""Apply the reviewed R260 selected-runtime reporting over the exact sequence-175 candidate.

Reading the evidence archive from run 45645736893 answered the question it was fetched for — the offline
understanding path does work on a real installation, twelve Russian phrases through the actual Qwen3-4B
model — and showed one gap while doing it. The report records that the sidecar model was available and that
four binaries were built, but nothing says which of the two builds the launcher chose. Since that choice
depends on CPU features and on which files the installer placed, a report cannot tell a hardware-specific
slowdown from a missing file.

So voice_semantic_status now answers three facts instead of one: available, the name of the runtime the
launcher would pick, and whether the model file is present. The two are reported separately because they
fail for different reasons — a machine with the generic binary and no model is not the same as one with a
model and no binary.

preview10-installed-speech.mjs records the name as selectedRuntime and asserts it is one of the two shipped
builds, so a third runtime appearing in the install fails the check rather than being silently accepted. Its
pinned checksum in the workflow moves from d19e900d... to bb561615..., which is the reviewed content.

A third Rust test pins the reporting: the runtime name must match the file the launcher points at, and the
model's presence must stay a separate fact.

Verified: cargo check clean; the full Rust suite is 313 passed, 0 failed, 2 ignored; the regression suite is
135 passed, 0 failed, 22 skipped; the workflow checksum matches the file it guards, computed after the edit.

No release: verification reporting only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R259 applied before R260')


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
print('Applied reviewed R260 selected-runtime reporting over the exact sequence-175 candidate.')
