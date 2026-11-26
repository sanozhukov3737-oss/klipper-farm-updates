"""Apply the reviewed R265 local-day load chart over the exact sequence-175 candidate.

The dashboard's 14-day load chart bucketed prints by UTC, because both the day key and the lookup used
toISOString().slice(0,10) on a date whose time had been set to local midnight. In Europe/Moscow that put the
"today" bucket on the previous calendar day, so a print started at 23:30 in the evening landed in a bar
labelled with the wrong date and the evening's work disappeared from the day it happened. Confirmed on this
machine before the change: the bucket key read 2026-11-25 while local midnight was 2026-11-26.

Both sides now key on the local calendar day through one helper, so the bucket and the print are always
expressed the same way. The label was already local, which is how the two could disagree without looking
wrong.

Two of the three things I went looking for turned out not to be defects, and saying so is part of the result.
The 'today' period in filterFarmHistory compares epoch milliseconds against local midnight, which is correct
and does not need a time zone. printForecast keys on the file name across whatever history it is given, which
is right because the callers pass one printer's history — and the check now records that assumption with a
deliberately blended sample, so a future caller that mixes printers has to decide explicitly instead of
silently averaging two machines into one number that fits neither.

Verified: TypeScript reports no error in the touched files; the load chart keys match local dates in
Europe/Moscow for both an early-morning and a late-evening print; the regression suite is 136 passed,
0 failed, 22 skipped.

No release: dashboard correctness and one recorded assumption.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R264 applied before R265')


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
print('Applied reviewed R265 local-day load chart over the exact sequence-175 candidate.')
