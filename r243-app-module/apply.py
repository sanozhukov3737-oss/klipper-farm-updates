"""Apply the reviewed R243 application assembly extraction over the exact sequence-175 candidate.

`run` and `run_desktop` were 293 lines of Tauri wiring at the bottom of lib.rs: the managed states, the
plugins, the window event handler, the setup closure with the instance lease and the background threads, and
the run loop. They moved into app.rs, which is now the only file that knows how the application is assembled.

lib.rs is 2557. Counting the refactor: 4750 to 2557, with rpc 1029, auth_commands 620, db_commands 423,
app 199, permissions 103 and local_library_paths 102 carrying what left.

The command list did not move, and that is the interesting part. `generate_handler!` expands into
`__cmd__<name>!` calls, and those macros are generated next to each command — in auth_commands, db_commands,
rpc and eight other modules, plus eight commands still defined in the crate root. A module that only sees
re-exports cannot use them: the first attempt to put the handler in app.rs produced thirty-odd "cannot find
macro __cmd__audit_add" errors, and switching to glob imports from every command module would have brought
name collisions instead of clarity.

So the list stays in lib.rs as `pub(crate) fn invoke_handler()`, the one place where every command and its
macro are visible together, and app.rs calls it. The commands are registered where they are visible rather
than where the builder happens to live.

Four checks needed to learn the new layout. `registeredNativeCommands` in frontend-build-contract matched
`.invoke_handler(tauri::generate_handler![...])`, which no longer exists as a literal — it now matches the
function form. check-background-mode read the window-event wiring from lib.rs and reads app.rs now.
check-transactional-core looks for InstanceLease::acquire, which sits in app.rs after the move, so it accepts
either file; check-v18-engine delegates to it and needed nothing.

I made a fresh copy of the tree before this round, after wiping lib.rs with a malformed script in R242. That
copy was not needed, but the habit is the point.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R242 applied before R243')


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
print('Applied reviewed R243 application assembly extraction over the exact sequence-175 candidate.')
