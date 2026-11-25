"""Apply the reviewed R256 module baseline move over the exact sequence-175 candidate.

check-module-refactor asserted that the extracted module is byte-identical to the block it came from in
r142. That was right when the block was being extracted. It stopped being right when releases after it
changed two function bodies, and again when r246 and r247 added eleven more functions to the module — so
the check could not pass against any current tree, and the honest conclusion was that its premise had
expired rather than that the code regressed.

The baseline now moves to the tree as it stood immediately after r247, the last overlay of the split.
That state was verified when it was built: of the 18 functions in the r142 block, 16 were byte-identical
and the other two differed only by a reported-rollback fix that arrived in a later release. r246 and r247
account for the additions. Nothing else in the module has changed since — measured, not assumed: this
module, printerActorBridge.ts and moonraker.ts are byte-identical between the r247 tree and the current
one, and the registered command surface is the same 115 commands.

So the check becomes strict again with no allowed-differences list to maintain: any edit to the module,
the bridge, or the command surface fails until someone moves the baseline deliberately and says why.

The baseline travels with the code as r247-module-baseline/ — 110 KB, three files. It needs no release
asset, no network and no external checkout, which is what made the previous form dependent on a download
that was never wired up. lib.rs is included only so registeredNativeCommands can parse invoke_handler.

Two functions in the module are internal helpers and are not commands. The first draft got that wrong by
treating every local_library_* name as a command and failed on local_library_files_equal; the check now
names the two helpers and asserts they are deliberately not registered, which is the stronger statement.

The check was also moved out of the runner's external group into the source group, since it runs now.
That is where the 135th passing check comes from.

Verified: the check passes against the r247 baseline and fails on both kinds of damage — a comment added
to a function body reports "drifted from the r247 baseline", and removing one registration reports
"Native command is no longer registered: local_library_list". check-release-portability, check-security
and check-farm-upgrades still pass with the baseline directory present. Full suite: 135 passed, 0 failed,
22 skipped.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R255 applied before R256')


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
print(f'Applied reviewed R256 module baseline move over the exact sequence-175 candidate: {len(rows)} files.')
