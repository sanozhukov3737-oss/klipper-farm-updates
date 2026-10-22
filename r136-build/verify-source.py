#!/usr/bin/env python3
"""Verify complete source parity after the approved feature and release-only overlays."""
import base64
import hashlib
import json
import sys
from pathlib import Path

from apply import FEATURE_SHA, digest, identity_inputs

if len(sys.argv) != 4:
    raise SystemExit('Usage: python r136-build/verify-source.py SOURCE_ROOT BASE_ZIP OUTPUT_JSON')
root, archive, output = map(Path, sys.argv[1:])
repo = Path(__file__).resolve().parent.parent
payload = (repo / 'r136-window-photos-patch.json').read_bytes()
assert digest(payload) == FEATURE_SHA, 'Approved feature patch differs'
patch = json.loads(payload)
assert archive.stat().st_size == patch['baseArchiveSize']
with archive.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == patch['baseArchiveSha256']
identity, identity_sha, identity_rows = identity_inputs(repo)
expected = dict(patch['baselineFiles'])
assert len(expected) == 1786 and len(patch['files']) == 8
for row in patch['files']:
    assert row['beforeSha256'] == expected.get(row['path']), row['path']
    assert digest(base64.b64decode(row['contentBase64'], validate=True)) == row['sha256']
    expected[row['path']] = row['sha256']
for name, before, data in identity_rows:
    assert before == expected[name], 'Release overlay changed an unapproved source: ' + name
    expected[name] = digest(data)
actual = set()
for item in root.rglob('*'):
    assert not item.is_symlink(), 'Source symlink rejected'
    if item.is_file():
        name = item.relative_to(root).as_posix()
        actual.add(name)
        assert name in expected, 'Unreviewed extra source file: ' + name
        assert digest(item.read_bytes()) == expected[name], 'Source bytes differ: ' + name
assert actual == set(expected), 'Source inventory differs'
assert (root / 'RELEASE-BUILD-ID.txt').read_text().strip() == identity['buildId']
assert json.loads((root / 'UPDATE-CHANNEL.json').read_text())['installedSequence'] == 136
report = {'passed': True, 'release': 'R136', 'baseline': 'R135',
          'baseArchiveSha256': patch['baseArchiveSha256'], 'featurePatchSha256': FEATURE_SHA,
          'releaseIdentitySha256': identity_sha, 'buildId': identity['buildId'],
          'baselineFiles': len(patch['baselineFiles']), 'verifiedFiles': len(expected),
          'reviewedFeatureFiles': len(patch['files']), 'releaseIdentityFiles': len(identity_rows),
          'allOtherSourceBytesPreserved': True, 'extraSourceFiles': 0,
          'featureFiles': [{k: v for k, v in row.items() if k != 'contentBase64'} for row in patch['files']],
          'identityFiles': [{k: v for k, v in row.items() if k != 'contentBase64'} for row in identity['files']]}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({k: v for k, v in report.items() if k not in ('featureFiles', 'identityFiles')}, indent=2))
