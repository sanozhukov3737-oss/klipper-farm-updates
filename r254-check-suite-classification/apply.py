"""Apply the reviewed R254 regression suite classification fix over the exact sequence-175 candidate.

R253 sorted the scripts into source, ui-tests, clean-tree, daemon and external. Checking the result
against the actual workflows showed two mistakes.

First, prepare-* were counted as checks. They are not: prepare-camera-detector, prepare-sidecar,
prepare-voice-runtime and prepare-windows-build-cache create the files other checks read. Running them
inside a verification pass means the pass mutates the tree it is measuring, and prepare-voice-runtime
fails outright when public/voice/ is absent, because it writes into that directory instead of creating
it. They get their own group and are skipped with that reason.

Second, several skip reasons were imprecise. Measured against the workflows rather than assumed:

check-r117-scope, r118 and r119 are gates for their own historical branches — windows-r117.yml fires
only on main, windows-r118.yml only on r118-background-panels, windows-r119.yml only on
r119-printer-catalog, each only when its own workflow file changes. They compare against released
snapshots and against code thirty releases old, so they are not runnable on this branch by design.

check-neural-speech-assets was described as blocked by missing MSVC without saying where it does run: CI
compiles whisper-worker.exe from whisper-worker.cpp on windows-2022 and then calls the script. The old
wording implied a gap that is only a local limitation.

check-voice-assets was not listed at all, so it failed after the speech assets were cleaned up. It
needs public/voice/ru-small.tar.gz, which prepare-voice-model.py builds from the 46 MB Vosk model; CI
builds it before the check runs.

Of the fifteen checks R253 called external, only two are actually invoked by a workflow:
check-headless-telemetry-runtime and check-windows-gui-binaries. The rest are manual tools, gates for
other branches, or aggregators — so skipping them locally does not open a gap that CI would close.

Verified: node --check clean; the plan now reports 134 source, 2 ui-tests, 14 external, 4 prepare and 2
daemons; a full run gives 134 passed, 0 failed, 23 skipped.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R253 applied before R254')


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
print('Applied reviewed R254 regression suite classification fix over the exact sequence-175 candidate.')
