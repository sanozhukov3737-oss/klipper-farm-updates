"""Apply the reviewed R244 discovery merge extraction over the exact sequence-175 candidate.

Discovery had seven functions in lib.rs and 151 lines, but the ones that matter are pure: given a list of
found printers, decide which entries are the same physical device and in what order to present them. No Tauri,
no network, no database — which is exactly why they belong in their own file rather than beside the commands
that call them.

Moved into discovery_merge: dedupe_discovered_printers, the five identity helpers around it
(discovery_identity, discovery_identity_match, discovery_identity_conflicts, discovery_identity_labels),
the two rank functions, mark_discovery_conflict, same_discovered_printer, and the MAX_DISCOVERY_RESULTS bound.

lib.rs is 2387. Counting the refactor: 4750 to 2387, with rpc 1029, auth_commands 620, db_commands 423,
app 199, discovery_merge 199, permissions 103 and local_library_paths 102 carrying what left.

The re-export follows the now-familiar split. dedupe_discovered_printers is called from the discovery
commands that stayed in lib.rs, so it is exported unconditionally. The identity and rank helpers are reached
only from tests, so they keep #[cfg(test)] — the same distinction that has caught me three times in this
refactor, now applied before cargo check had a chance to complain.

check-search-art sliced lib.rs for MAX_DISCOVERY_RESULTS, dedupe_discovered_printers and the truncate call,
all three of which are in discovery_merge now. It reads that file for those markers; the concurrency and
deadline constants it also checks stayed in lib.rs and are still read from there.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R243 applied before R244')


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
print('Applied reviewed R244 discovery merge extraction over the exact sequence-175 candidate.')
