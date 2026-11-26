"""Apply the reviewed R263 farm report statistics over the exact sequence-175 candidate.

The reports were the thinnest verified part of the application: calculateFarmReportStats was checked only by
grepping for its name, so nothing asserted what it computed. Reading it showed two defects that a farm
operator would notice and a test would not have.

A print the operator stopped on purpose was counted as a failure. The failure filter was
`!/complete|in_progress|printing/`, which swept cancellations in with errors, so stopping three jobs by choice
lowered the reported success rate exactly as much as three printer faults would. Success is now measured over
prints that reached an outcome under their own power — completed against failed — and cancellations are
reported as their own count. A careful operator's farm no longer looks unreliable for being careful.

Hours counted completed prints only. The dashboard's 14-day load chart, twelve lines away, summed every job
regardless of outcome. Two numbers labelled "hours" in one application disagreed, and the smaller one ignored
the machine time spent on cancelled and failed work, which is real wear. Both now include every print that ran
and exclude one still running.

check-farm-report-stats.mjs pins the arithmetic against the real functions, loaded through esbuild the same way
the forecast check does. It covers the boundary that produced both defects: one cancellation among completions,
cancellations with no failures at all, an all-running history, four spellings each of completed, cancelled and
failed, and an unrecognised status that must not be counted as success. It also holds filament to completed
prints and checks the status label and tone fall back to the raw value rather than inventing "Завершено".

Verified: the new check passes and fails against the previous farmReports.ts with "cancelled counted apart from
failures", so it is not vacuous. TypeScript reports no error in the touched files. The regression suite is 136
passed, 0 failed, 22 skipped.

No release: reporting correctness and its coverage.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R262 applied before R263')


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
print('Applied reviewed R263 farm report statistics over the exact sequence-175 candidate.')
