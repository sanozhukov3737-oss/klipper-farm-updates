"""Apply the reviewed R258 skip-reason and baseline-contract repair over the exact sequence-175 candidate.

Investigating check-voice-understanding-assets turned up nothing wrong with that check, but it did turn up
two defects in the work of R253-R257.

The first is the reasons. They were written after grepping for each script in /d/tmp/r248work, which held
two workflow files while the repository holds 111. So several reasons stated the opposite of the truth:
build-and-install-windows was said to be called by no workflow when preview10 runs it with --build-only;
check-voice-understanding-assets and check-neural-speech-assets were said to be uncalled when preview10
runs both on every build and passes; check-windows-test-loader was said to be uncalled when it is what
consumes the Cargo JSON log run-rust-tests produces. Every reason now names the workflow and branch that
does run the check, so a local skip cannot be mistaken for a gap in CI.

That grep also misplaced two scripts. prepare-windows-build-cache was filed as preparation, but CI runs it
with --self-test, and the self-test passes here, so it belongs in the source group; the runner gained a
small per-script argument map so it runs the self-test rather than the cache-resetting default. And
check-release-published was in the source group although it queries the published GitHub release over the
network and no workflow calls it, which made the whole suite fail whenever the network was unavailable.

The second defect is a contract break. windows-r143-build supplies its baseline through
KF_PERF_BASELINE_SOURCE, and R256 renamed the variable to KF_MODULE_BASELINE, so a supplied baseline would
have been silently ignored in favour of the committed default. The check now reads KF_MODULE_BASELINE,
then KF_PERF_BASELINE_SOURCE, then the first argument, then the committed directory — and validates the
baseline shape up front. When windows-r143-build supplies the r142 tree, the failure now says which file
is missing and that the r142 tree predates the split this check guards, instead of throwing ENOENT from
inside a read four lines later.

Verified: the check passes against the committed r247 baseline and reports the 115-command surface; the
same check with KF_PERF_BASELINE_SOURCE pointing at the r142 tree fails with the explanation above rather
than ENOENT; the suite reports 135 passed, 0 failed, 22 skipped, with prepare-windows-build-cache now
actually running and check-release-published skipped for its real reason.

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
    raise SystemExit('Expected the accepted sequence-175 candidate with R257 applied before R258')


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
print('Applied reviewed R258 skip-reason and baseline-contract repair.')
