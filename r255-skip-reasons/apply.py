"""Apply the reviewed R255 skip-reason correction over the exact sequence-175 candidate.

R253 and R254 said these checks cannot run because their baseline snapshots are not obtainable. That was
wrong, and measuring it changed the explanation rather than the verdict.

All three baselines are published as release assets: KF-R116-FULL.zip on release r116, KF-R117-FULL.zip
on r117, KF-R118-FULL.zip on r118, KF-R142-FULL.zip on r142. Earlier I only searched the -ota tags and
concluded nothing was there.

So check-r117-scope was actually run against real R116 source. It fails with "Protected file changed:
src/App.tsx" — not because the snapshot is missing, but because the check allows 5 files in src and 2 in
src-tauri to differ from R116, while 46 and 26 respectively have changed across the 30 releases since.
Its premise is "between R116 and the R117 review only these files changed", which is a statement about
branch main at R117 and says nothing about this branch. Same for r118 and r119 and their own branches.

check-module-refactor is a different case and keeps its own verdict. Its baseline works, the check runs,
and it fails on a real difference: the module grew from 18 to 29 functions since r142, and
finish_local_import and local_library_import gained a reported-rollback fix in a later release, so the
byte-identical-to-r142 assertion no longer holds. Whether to compare per function, accept it as a
historical gate, or move the baseline forward is still open.

Two more reasons were imprecise. check-neural-speech-assets now says where it does run — CI compiles
whisper-worker.exe with MSVC on windows-2022 — instead of implying a gap. build-and-install-windows now
names its actual local blocker: rustc-LLVM runs out of memory during the optimised crate build, which is
a machine limit rather than a missing input.

Verified: node --check clean, the plan still reports 134 source / 2 ui-tests / 14 external / 4 prepare /
2 daemons, and each reason now states what was measured.

No release: local verification tooling only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R254 applied before R255')


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
print('Applied reviewed R255 skip-reason correction over the exact sequence-175 candidate.')
