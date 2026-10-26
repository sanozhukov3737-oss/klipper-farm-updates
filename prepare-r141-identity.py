#!/usr/bin/env python3
"""Generate R141's five metadata edits and exact published R140 inventory.

Usage: python prepare-r141-identity.py KF-R140-FULL.zip
Does not edit source, build, sign, install or publish an update.
"""
import base64
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent
BASE_SHA = 'cbbc7d2c2d043cacd953191281d0c7d5ce8d650064576263ad87a5a8c544cf04'
BASE_SIZE = 582390782
BASE_PREFIX = 'Klipper-Farm-R140/'
FEATURE_SHA = 'cb183b8172c436a920630a12e7d37794128fb51bd39b2ae723bd53c60dfc05e4'
PREVIOUS_IDENTITY_SHA = '5f632e3efd2e28869f8f6122bf5b5ac8ff1067c9ca80b0a15e9862261bf39019'
PREVIOUS_BUILD_ID = 'V20.6-R14.0-TV-SPOTLIGHT-2026-10-26'
BUILD_ID = 'V20.6-R14.1-PERFORMANCE-TELEMETRY-2026-10-26'
PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json', 'scripts/build-and-install-windows.mjs',
         'scripts/check-r9-clean-installer.mjs', 'scripts/check-release-portability.mjs'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    parsed = PurePosixPath(name)
    assert name and not parsed.is_absolute() and '..' not in parsed.parts
    assert '\\' not in name and ':' not in name and '\0' not in name
    assert all(part not in ('', '.', '..') for part in name.split('/'))


def main():
    assert len(sys.argv) == 2, 'Provide exact published KF-R140-FULL.zip'
    archive = Path(sys.argv[1])
    assert archive.stat().st_size == BASE_SIZE
    with archive.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == BASE_SHA
    feature_bytes = (ROOT / 'r141-performance-patch.json').read_bytes()
    feature = json.loads(feature_bytes)
    assert digest(feature_bytes) == FEATURE_SHA
    assert (ROOT / 'r141-performance-patch.sha256').read_text().split()[0] == FEATURE_SHA
    assert feature['schemaVersion'] == 1 and feature['release'] == 'R141-PERFORMANCE-DRAFT' and feature['baseline'] == 'R140'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == BASE_SIZE
    assert feature['archivePrefix'] == BASE_PREFIX
    assert len(feature['files']) == len({row['path'] for row in feature['files']}) == 32
    assert PATHS.isdisjoint(row['path'] for row in feature['files'])
    previous_bytes = (ROOT / 'r140-release-identity.json').read_bytes()
    assert digest(previous_bytes) == PREVIOUS_IDENTITY_SHA
    previous = json.loads(previous_bytes)
    assert {row['path'] for row in previous['files']} == PATHS
    baseline = {}
    originals = {}
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            assert entry.filename.startswith(BASE_PREFIX), entry.filename
            name = entry.filename[len(BASE_PREFIX):]
            if not name or entry.is_dir():
                continue
            safe_name(name)
            assert name not in baseline and ((entry.external_attr >> 16) & 0o170000) != 0o120000
            with bundle.open(entry) as stream:
                baseline[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
            if name in PATHS:
                originals[name] = bundle.read(entry)
    assert len(baseline) == 1811 and set(originals) == PATHS
    assert feature['baselineFiles'] == baseline, 'Frozen feature baseline inventory differs'
    for row in feature['files']:
        safe_name(row['path'])
        assert row['beforeSha256'] == baseline.get(row['path']), row['path']
        assert digest(base64.b64decode(row['contentBase64'], validate=True)) == row['sha256'], row['path']
    rows = []
    for row in previous['files']:
        name = row['path']
        before = base64.b64decode(row['contentBase64'], validate=True)
        assert before == originals[name] and digest(before) == row['sha256'] == baseline[name], name
        if name == 'RELEASE-BUILD-ID.txt':
            assert before.decode().strip() == PREVIOUS_BUILD_ID
            after = (BUILD_ID + '\n').encode()
        elif name == 'UPDATE-CHANNEL.json':
            channel = json.loads(before)
            assert channel['installedSequence'] == 140 and channel['channel'] == 'stable'
            channel['installedSequence'] = 141
            after = (json.dumps(channel, indent=2) + '\n').encode()
        elif name == 'scripts/build-and-install-windows.mjs':
            text = before.decode()
            old_title = 'Klipper Farm v1.14.5 - R140 TV Spotlight'
            assert text.count(old_title) == 1
            after = text.replace(old_title, 'Klipper Farm v1.14.5 - R141 Performance and Telemetry').encode()
        else:
            text = before.decode()
            assert PREVIOUS_BUILD_ID in text, name
            text = text.replace(PREVIOUS_BUILD_ID, BUILD_ID).replace('R140', 'R141')
            old_sequence = 'assert.equal(channel.installedSequence,140' if name.endswith('check-r9-clean-installer.mjs') else 'assert.equal(updateChannel.installedSequence,140'
            assert text.count(old_sequence) == 1, name
            after = text.replace(old_sequence, old_sequence[:-3] + '141').encode()
        assert after != before, name
        rows.append({'path': name, 'beforeSha256': digest(before), 'sha256': digest(after),
                     'contentBase64': base64.b64encode(after).decode()})
    result = {'schemaVersion': 1, 'release': 'R141', 'baseline': 'R140', 'sequence': 141,
              'version': '1.14.5-r141', 'productVersion': '1.14.5', 'buildId': BUILD_ID,
              'featurePatchSha256': FEATURE_SHA, 'baseArchiveSha256': BASE_SHA,
              'baseArchiveSize': BASE_SIZE, 'archivePrefix': BASE_PREFIX,
              'baselineFiles': dict(sorted(baseline.items())), 'files': rows}
    data = (json.dumps(result, indent=2) + '\n').encode()
    (ROOT / 'r141-release-identity.json').write_bytes(data)
    sha = digest(data)
    (ROOT / 'r141-release-identity.sha256').write_text(sha + '  r141-release-identity.json\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'buildId': BUILD_ID, 'featurePatchSha256': FEATURE_SHA,
                      'releaseIdentitySha256': sha, 'metadataFiles': len(rows), 'baselineFiles': len(baseline), 'reviewedFeatureFiles': len(feature['files']), 'expectedSourceFiles': len(set(baseline) | {row['path'] for row in feature['files']})}))


if __name__ == '__main__':
    main()
