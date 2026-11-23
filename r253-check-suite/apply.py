"""Apply the reviewed R253 regression suite runner over the exact sequence-175 candidate.

Two things happen here, for the same reason: the local regression run was measuring the wrong thing.

First, a runner. The 162 scripts are not one environment. The CI workflow splits them across jobs —
system-panel-layout installs ui-tests dependencies and a Playwright browser, linux-gates runs
check-release-portability over a tree that has none. Running everything in one shell therefore reports
failures no job sees: installing playwright under ui-tests/ makes check-release-portability reject the
tree, and the two browser checks disagree about PLAYWRIGHT_MODULE_PATH, so setting it for one breaks the
other. Both were measured, not assumed.

run-regression-suite.mjs therefore groups them: source (always run), ui-tests (run when the dependency is
installed), clean-tree (skipped when ui-tests/node_modules is present, because it fails by design),
daemons (never run to a timeout — they are long-lived services), and external (cannot pass on a bare
checkout). Every skip prints its reason. Silence would be worse than the false failures it replaces.

Measured both profiles: 138 passed / 0 failed / 19 skipped without playwright, and 139 passed / 0 failed /
18 skipped with it. Before this, the same tree reported 41 failures, of which the five real ones were all
repaired in r248-r252.

Second, five dead patch scripts. patch-v8 through patch-v12 rewrite dist/assets/index-V7ContrastTools.js
through index-V12HardwareReliability.js — fixed bundle names from when the output was named by hand. The
current build emits content-hashed names (index-BGO57Oje.js), so these can never run again and have not
been able to for many releases. Nothing references them: not the workflow, not the other scripts, and the
only package.json mention was the patch:v12 alias removed here.

Deletions are declared in the manifest with their checksums and verified before removal, so an overlay
applied to a tree where these files differ stops instead of deleting something it was not reviewed
against. That is why the format carries a deletions list instead of apply.py hard-coding paths.

Verified: node --check clean; the runner lists 158 scripts across five groups; both profiles report zero
failures; the payload is two written files and the five deletions, nothing else.

No release: local verification tooling and dead script removal.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R252 applied before R253')


def canonical(data):
    return data.replace(b'\r\n', b'\n')


def digest(data):
    return hashlib.sha256(canonical(data)).hexdigest()


def safe_path(declared):
    if '\\' in declared:
        raise SystemExit('Unsafe source path: ' + declared)
    path = PurePosixPath(declared)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        raise SystemExit('Unsafe source path: ' + declared)
    return path


writes = []
for row in manifest['files']:
    path = safe_path(row['path'])
    target = root.joinpath(*path.parts)
    source = overlay.joinpath('changes', *path.parts)
    if not source.is_file() or digest(source.read_bytes()) != row['sha256']:
        raise SystemExit('Candidate source checksum differs: ' + row['path'])
    before = row.get('beforeSha256')
    if before is not None:
        current = digest(target.read_bytes()) if target.is_file() else None
        if current not in (before, row['sha256']):
            raise SystemExit('Existing source differs; refusing to overwrite: ' + row['path'])
    writes.append((target, source))

# Confirm every deletion target is present and still the reviewed bytes before touching anything, so a
# partial application cannot leave the tree with sources written and scripts half-removed. A target that
# is already gone counts as done rather than as an error, which keeps a repeated run harmless; a target
# whose contents differ stops the run, because that is not the file this overlay was reviewed against.
removals = []
for row in manifest.get('deletions', []):
    path = safe_path(row['path'])
    target = root.joinpath(*path.parts)
    if not target.is_file():
        continue
    if digest(target.read_bytes()) != row['sha256']:
        raise SystemExit('Refusing to delete; existing content differs: ' + row['path'])
    removals.append(target)

for target, source in writes:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical(source.read_bytes()))
for target in removals:
    target.unlink()
    parent = target.parent
    while parent != root and parent.is_dir() and not any(parent.iterdir()):
        parent.rmdir()
        parent = parent.parent

print(f'Applied reviewed R253 regression suite runner over the exact sequence-175 candidate: '
      f'{len(writes)} written, {len(removals)} removed.')
