"""Apply the reviewed R245 upload extraction over the exact sequence-175 candidate.

Twelve functions and 516 lines moved into upload_commands: the three upload paths (ordinary, chunked and
verified-from-a-checked-file), the HTTP request and response reader, and the checks that decide who may write
what — safe_upload_name, endpoint_allowed, printer_target_bound, authorize_printer_target,
same_printer_channel, validate_upload_id.

lib.rs is 1677. Counting the refactor: 4750 to 1677, a 65% reduction, with rpc 1029, upload_commands 760,
auth_commands 620, db_commands 423, app 199, discovery_merge 199, permissions 103 and local_library_paths 102
carrying what left.

Types and constants crossed the boundary with it. UploadState, UploadSession, UploadBeginResult,
UploadFinishResult, NativeHttpResponse and the MAX_UPLOAD, MAX_UPLOAD_CHUNK, MAX_FILE_RESPONSE,
MAX_TRANSFER_SESSIONS and UPLOAD_SESSION_TTL bounds became pub(crate) — one keyword each, no behaviour.

The command macros needed the glob import again. generate_handler! expands to __cmd__moonraker_http and
friends, generated next to each command inside upload_commands; a re-export in the root does not carry them,
so lib.rs imports the module's items wholesale. That is the same mechanism recorded in R243 for the handler
itself, now applied to a moved command module.

Four checks read upload internals from lib.rs: check-security wanted endpoint_allowed, check-local-library
wanted the verified-upload markers and the seek, check-filament-history-policy sliced endpoint_allowed out to
compile it with rustc, and check-http-keepalive concatenates the reader with the framing module. All four now
read upload_commands.

One mistake there is worth recording because it was mine and silent: I wrote a replacement containing `\\b` in
a Python non-raw string, so the file received a literal backspace character instead of a regex word boundary.
The check kept failing with a Rust syntax error for twenty minutes while the replacement looked correct in the
editor. It is now a plain pattern without the boundary.

Verified: cargo check clean with zero warnings, 330 Rust tests pass, clippy exit 0, 113 of 115 regression
scripts pass — the two failures need the prepared speech assets.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R244 applied before R245')


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
print('Applied reviewed R245 upload extraction over the exact sequence-175 candidate.')
