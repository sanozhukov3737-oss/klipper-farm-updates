"""Apply the reviewed R240 REST RPC regression repair over the exact sequence-175 candidate.

check-native-rest-rpc-runtime is not a structural check. It lifts Rust source out by text boundaries, builds
a small crate from the pieces and runs a real mock Moonraker server against them, asserting which requests
are sent, how many, and that auth and server errors are never replayed. That is why it exists at all: rpc_async
takes an AppHandle, so it cannot be reached from a plain unit test, and this is the only way to exercise the
fallback path end to end.

After R232 moved 1029 lines into rpc.rs, its boundaries pointed at a file that no longer contained the
functions. The repair is not a rewrite: the same test, the same cases, pointed at the module the code moved
to.

Boundaries now name rpc.rs for the helpers, the routes structure, rpc_async, and both REST fallback
functions. Two details cost most of the time and are worth recording.

The `#[derive(Debug, PartialEq, Eq)]` line sits above `pub(crate) struct RestRpcFallback`, so a boundary
that started at `struct` left the attribute stranded in the previous slice and produced "derive may only be
applied to structs" — an error pointing at a place with nothing wrong.

The extracted code keeps `pub(crate)` and `#[tauri::command]` and file-level `//!` comments, none of which are
legal inside the function body the harness builds around. Those are stripped on the way in rather than edited
in the source.

Everything else in the harness is unchanged: same mock server, same case list (move, query, info, start across
404, 405, method-missing, 401, 403, 500, disconnect, timeout, jsonrpc-ok, rest404), same expected request
counts.

Verified: the check passes and prints its own PASS line naming what it tested; 113 of 115 regression scripts
pass with the other two needing the prepared speech assets; the Rust crate still builds and all 330 Rust tests
pass.

The lesson is not that extraction is fragile — it is that this check reads source as text, so it has to be
updated whenever the source moves. The alternative, a real Rust test, needs AppHandle parameterisation that
was measured at 182 sites across 23 files and rejected in R236.

No release: checks only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R239 applied before R240')


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
print('Applied reviewed R240 REST RPC regression repair over the exact sequence-175 candidate.')
