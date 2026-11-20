"""Apply the reviewed R232 RPC module extraction over the exact sequence-175 candidate.

lib.rs was 4750 lines with 132 functions. Measured before touching anything — the same lesson as
moonraker.ts, where I promised a split several times and never checked the numbers.

131 of those functions sit in recognisable domains: authentication 27 functions and 591 lines, Moonraker
RPC 17 and 885, database 10 and 321, local library 10 and 152, discovery 7 and 151, permissions 4 and 70,
notifications 2 and 66, and run_desktop alone at 250. The RPC block is the largest single domain and the
one with the cleanest boundary, so it moved first.

What moved: the whole RPC path — rpc_async, rpc_blocking, execute_rest_rpc_fallback and its async twin,
moonraker_rpc, moonraker_ws_rpc, the five per-method REST fallbacks (queue delete, files list, files move,
objects query, print start), rest_fallback_for_rpc, parse_moonraker_result, RestRpcFallback, and the four
helpers rpc_required_role, rpc_params_body, rpc_without_params and moonraker_query_result_useful.

That is 21 items and 1029 lines. lib.rs is 3761 now.

Kept in place deliberately: transport primitives (parse_target, http_request, websocket_rpc_blocking,
validate_header_value) stay in moonraker_protocol, which already existed; engine_owner_conflict,
bounded_spawn_blocking and the transactional types stay in the crate root, because they belong to the
engine, not to the protocol.

Two consequences worth naming. The `pub(crate) use rpc::{...}` re-export means the 36 internal call sites
and the one external `crate::rpc_async` did not change at all — the move is invisible to callers. And two
functions, rpc_blocking and execute_rest_rpc_fallback, are `#[cfg(test)]`, so they are re-exported under
the same gate; without that the library would not compile outside tests.

One thing broke in a way worth recording: extracting `struct RestRpcFallback` by its `struct` line left its
`#[derive(Debug, PartialEq, Eq)]` orphaned above a blank line in lib.rs, where it produced a confusing
"derive may only be applied to structs" error far from the cause. The attribute moved with the struct and
its fields are now pub(crate), because lib_tests.rs asserts on them.

Verified: cargo check clean, cargo test --lib --no-run clean, 300 tests passing with KF_TEST_PYTHON set as
the pipeline sets it, and clippy exit 0 with let_underscore_must_use.

No release: a refactor with no user-visible change, so it joins the chain after R231 and rides with the
next build that carries a real change.
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
    raise SystemExit('Expected the accepted sequence-175 candidate before R232 RPC extraction')


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
print('Applied reviewed R232 RPC module extraction over the exact sequence-175 candidate.')
