"""Apply the reviewed R257 version-audit repair over the exact sequence-175 candidate.

R256 moved the module baseline into the tree as three files, one of which was the historical lib.rs. That
file embeds `const APP_VERSION: &str = "1.14.5";`, and the release stamp rewrites every managed file to the
new version before the native build. Its audit then walks the tree looking for leftovers and found this one:

    ERROR: audit found 1 unexpected version references outside managed files
      r247-module-baseline/src-tauri/src/lib.rs:324: const APP_VERSION: &str = "1.14.5";

Which failed the CI run at "Stamp release version and single-instance identity", before the native build
had even started. Confirmed locally by reproducing the step against the applied tree.

The baseline never needed the file. lib.rs was kept for one purpose: registeredNativeCommands parses
invoke_handler out of it to produce the command surface. So the baseline now stores what that parse
produced — a sorted list of the 115 command names — and the historical lib.rs is deleted. The check
compares names against names, which is the assertion it was making anyway.

That keeps the baseline honest in both directions: it cannot be version-stamped, because it holds no
version, and it cannot drift silently, because the two source files it does hold are compared byte for
byte.

Verified: stamp-version.py --audit --audit-strict exits 0 on the applied tree, reporting only the four
pre-existing reviewed exceptions; check-module-refactor passes against the new baseline; appending a line
to local_library_commands.rs still fails with "drifted from the r247 baseline"; the deletion is declared
with its checksum so an overlay applied elsewhere stops instead of removing an unexpected file.

No release: verification repair only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R256 applied before R257')

BACKSLASH = chr(92)


def canonical(data):
    return data.replace(b'\r\n', b'\n')


def digest(data):
    return hashlib.sha256(canonical(data)).hexdigest()


def safe_path(declared):
    if BACKSLASH in declared:
        raise SystemExit('Unsafe source path: ' + declared)
    path = PurePosixPath(declared)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise SystemExit('Unsafe source path: ' + declared)
    return path


writes = []
for row in manifest['files']:
    path = safe_path(row['path'])
    target = root.joinpath(*path.parts)
    source = overlay.joinpath('changes', *path.parts)
    if not source.is_file() or digest(source.read_bytes()) != row['sha256']:
        raise SystemExit('Candidate source checksum differs: ' + row['path'])
    before = row.get('beforeSha256')
    if before is not None:
        current = digest(target.read_bytes()) if target.is_file() else None
        if current not in (before, row['sha256']):
            raise SystemExit('Existing source differs; refusing to overwrite: ' + row['path'])
    writes.append((target, source))

removals = []
for row in manifest.get('deletions', []):
    path = safe_path(row['path'])
    target = root.joinpath(*path.parts)
    if not target.is_file():
        continue
    if digest(target.read_bytes()) != row['sha256']:
        raise SystemExit('Refusing to delete; existing content differs: ' + row['path'])
    removals.append(target)

for target, source in writes:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical(source.read_bytes()))
for target in removals:
    target.unlink()
    parent = target.parent
    while parent != root and parent.is_dir() and not any(parent.iterdir()):
        parent.rmdir()
        parent = parent.parent

print('Applied reviewed R257 version-audit repair: '
      + str(len(writes)) + ' written, ' + str(len(removals)) + ' removed.')
