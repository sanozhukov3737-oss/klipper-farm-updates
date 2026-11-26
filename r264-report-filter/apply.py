"""Apply the reviewed R264 report filter alignment over the exact sequence-175 candidate.

R263 split cancelled from failed in calculateFarmReportStats but left the history filter counting the old way,
so the two disagreed on the same data. The filter's failed branch was still
`!/complete|in_progress|printing/`, which swept cancellations in, and the option was labelled
"Ошибки и отмены" — honest about the merging, but no longer matching the statistics printed beside it. A user
who filtered for failures saw a count that the statistics split into two.

I did not add the CSV export this was meant to be about: it already exists, and reading it first was the
useful part. AnalyticsPanel has exported CSV since earlier work, and does it correctly — semicolon separated
for Russian Excel, CRLF line endings per RFC 4180, a UTF-8 BOM, and quotes doubled inside quoted cells. My
premise that exports were missing was wrong, so the work became the inconsistency R263 left behind.

FarmReportStatus gains 'cancelled'. The filter now applies the same three boundaries the statistics use, so a
filtered list always agrees with the numbers beside it, and the single "Ошибки и отмены" option becomes
"Ошибки" and "Отменённые". The state is typed as FarmReportStatus rather than string, which is what let the
loose value pass through unnoticed.

The report check gains the assertion that makes the disagreement impossible to reintroduce: for one history
containing a completion, a cancellation and a failure, each filter's length must equal the corresponding
count from calculateFarmReportStats. It fails against the previous filter with "cancelled filter selects
cancellations".

Verified: the check passes and fails as described; TypeScript reports no error in the touched files; the
regression suite is 136 passed, 0 failed, 22 skipped.

No release: reporting consistency and its coverage.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R263 applied before R264')


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
print('Applied reviewed R264 report filter alignment over the exact sequence-175 candidate.')
