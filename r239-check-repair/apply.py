"""Apply the reviewed R239 structural check repair over the exact sequence-175 candidate.

Seven checks failed once the Rust extraction landed, and every one of them failed the same way: it asserted
that a string exists in lib.rs, and the string had moved to rpc.rs, permissions.rs, local_library_paths.rs or
auth_policy.rs. The code was correct; the checks were looking in the room next door.

- check-security: the WebSocket command, its printer binding and the RPC role gate now live in rpc.rs; the
  lockout threshold and its five-minute duration now live in auth_policy.rs; the REST fallback trigger moved
  with the transport.
- check-runtime-stability: query_get_first, prefer_rest and the 8-second clamp are in rpc.rs.
- check-moonraker-compat: the preferred-REST early return is in rpc.rs.
- check-audit-hardening: MOONRAKER_DIRECT_FAILOVER and the embedded-snapshot condition are in rpc.rs.
- check-printer-connection-bridge: its `assembly` now concatenates lib.rs and rpc.rs rather than reading one.
- check-local-library: normalisation and the traversal guard are in local_library_paths.rs.
- check-search-art: its discovery slice was bounded by the next `#[tauri::command]`, which worked only while
  rpc_required_role sat directly after discover_moonraker. It now finds the boundary after
  cancel_moonraker_discovery, so the cancellation command stays inside the checked range instead of falling
  outside it — the first version of my fix silently narrowed what the check covered.

Two of these deserve a note because the fix could have made things worse rather than better. check-moonraker-compat
and check-runtime-stability asserted a *sequence* — `if prefer_rest { return Ok(result) }` followed by a second
request — and that sequence only existed while both halves were in the same file. Split across modules, the
literal no longer exists and cannot exist. The assertion now checks the half that carries the guarantee: that
preferring REST returns instead of falling through. That is what the check was protecting; the second half was
incidental.

The alternative — concatenating every Rust file into one blob for each check — would have made all seven pass
without touching them, and would have quietly removed the ability to tell which file a guarantee lives in. That
is why the checks name their modules instead.

Verified: 113 of 115 regression scripts pass against a tree with no dist and no rv; the two failures are the
prepared speech assets the pipeline supplies two steps earlier.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R238 applied before R239')


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
print('Applied reviewed R239 structural check repair over the exact sequence-175 candidate.')
