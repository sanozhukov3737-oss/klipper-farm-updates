"""Apply the reviewed R249 check repair over the exact sequence-175 candidate.

Four regression scripts had been asserting against lib.rs for markers that the r241-r248 module split
moved into upload_commands, auth_commands and local_library_paths. They concatenated one or two files
and searched the result, so every marker they looked for simply was not there any more. All four had
been red since r241 and nobody noticed, because the failure looked like an unrelated compile error or
a divergence message.

What was actually wrong, check by check:

check-full-audit and check-ui-files concatenated lib.rs with moonraker_protocol and searched for the
chunked upload transport and the .gcode/.gco policy. Both markers now live in upload_commands, so both
scripts now read it. No assertion text changed — only the list of files they read.

check-legacy-library-upload-runtime sliced functions out of lib.rs by name. safe_upload_name,
upload_verified_file_to_moonraker_blocking and legacy_upload_response_path had moved to upload_commands,
and random_bytes stayed behind next to validate_pin once validate_password left. Two slice end markers
had to change because the order inside upload_commands is not the order lib.rs had: the uploader now
ends at the next #[tauri::command], which keeps open_chunked_upload and read_http_response_from_stream
inside the slice while leaving the tauri-typed commands out of the harness. The section helper also
strips a trailing `pub(crate)` now, because a slice that ends before the next item otherwise leaves that
item's visibility keyword dangling in front of an unrelated item.

check-native-upload-runtime was the worst of the four. It used indexOf and slice without checking, so a
missing marker produced slice(begin,-1) — nearly the whole file — and the harness failed with
"error: this file contains an unclosed delimiter". That error names a delimiter instead of the marker
that went missing, which is exactly how this stayed red unnoticed. It now uses the same section helper
as the legacy script, asserted, and a deliberately broken marker proves the new message says
"native extraction markers missing: fn safe_upload_name_REMOVED( ... fn upload_to_moonraker_blocking(".

Verified: cargo check clean with zero warnings, 310 of 312 Rust tests pass with KF_TEST_PYTHON set,
clippy unchanged from baseline, four repaired scripts green, whole-suite failures down from 38 to 33
with the remaining ones environmental (missing npm assets, unbuilt frontend, absent baseline snapshots,
required arguments) and one GitHub fetch that this machine cannot reach.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R248 applied before R249')


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
print('Applied reviewed R249 check repair over the exact sequence-175 candidate.')
