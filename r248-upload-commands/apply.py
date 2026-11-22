"""Apply the reviewed R248 upload commands over the exact sequence-175 candidate.

The last block of functions that only lib.rs used now lives where they belong.

creality_light, moonraker_upload, moonraker_upload_abort and stored_api_key_for_headless moved to
upload_commands, the module that already owns the upload state, the REST upload wrapper and the
headless credential read they call. lib.rs is 1294 -> 1085, and the remaining 16 functions are
invoke_handler plus small helpers.

Two names had to be qualified rather than imported. The moved commands are reached from
generate_handler as upload_commands::name, the same shape the library commands already use, because
the __cmd__ macro that #[tauri::command] emits is private to the defining module — a glob import is
not enough, and the compiler said so plainly. And creality_light the function shadows creality_light
the module inside upload_commands, so the call site names crate::creality_light::execute.

Three checks asserted those markers were in lib.rs: check-creality-light for the light RBAC line,
check-fix3-3-daemon-recovery for the headless credential read, and check-security for
authorize_printer_target. Each now reads the file that actually owns the marker, which is what the
assertion always meant; none of the invariants themselves changed.

Verified: cargo check clean with zero warnings, 323 of 330 Rust tests pass, clippy identical to the
baseline (5 pre-existing lints), 160 of 162 regression scripts pass with the same three asset and
network flakes as the baseline.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R247 applied before R248')


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
print('Applied reviewed R248 upload commands over the exact sequence-175 candidate.')
