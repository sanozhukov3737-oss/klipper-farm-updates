"""Apply the reviewed R233 local library path extraction over the exact sequence-175 candidate.

Six pure path functions moved out of lib.rs into local_library_paths: windows_reserved_segment,
normalize_local_library_segments, normalize_local_library_path, normalize_local_library_directory,
local_library_file_path, local_library_directory_path. 102 lines. lib.rs is 3689 now.

Three functions did not move, and the reason is the useful part of this change. local_library_root,
local_library_printer_scope and local_library_printer_root look like path helpers by name, and I moved
them first on that assumption. The compiler disagreed: local_library_root takes an AppHandle and reads the
data directory from Tauri state, so it is not a path transformation at all — it is application wiring.
local_library_printer_root calls create_local_library_parent, which creates directories on disk.

They are back in the crate root with a comment saying why. A module called local_library_paths that reaches
into Tauri state and touches the filesystem would be worse than the file it came from.

Two mistakes of mine surfaced while doing this, both from editing structure with scripts rather than by
hand. A re-export gained a #[cfg(test)] that belonged to a different one, and a doc comment ended up above
a function instead of above its re-export. Both produced errors that pointed somewhere other than the
cause. The lesson is not "write smaller scripts" — it is that structural edits to the top of a 3700-line
file deserve to be made deliberately, one at a time, which is what the fixes were.

Verified: cargo check clean, 300 tests passing with KF_TEST_PYTHON set as the pipeline sets it.

Remaining in lib.rs: 3689 lines, 111-ish functions. Next candidates by measurement are permissions (78
lines, 6 functions, only two external callers) and authentication (591 lines, 27 functions — the largest
single block, and the one that needs the most care because it touches sessions and password hashing).

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R232 applied before R233')


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
print('Applied reviewed R233 local library path extraction over the exact sequence-175 candidate.')
