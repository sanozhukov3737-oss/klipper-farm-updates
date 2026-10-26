#!/usr/bin/env python3
"""Generate R140's five metadata edits and exact published R139 inventory.

Usage: python prepare-r140-identity.py KF-R139-FULL.zip
Does not edit source, build, sign, install or publish an update.
"""
import base64
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent
BASE_SHA = '125bb78054cb6366242eaf505f2178bdc72f6e916b8888ff001df6a3ade3922e'
BASE_SIZE = 582356862
BASE_PREFIX = 'Klipper-Farm-R139/'
FEATURE_SHA = 'f0bedbb970a385d8da1772277a8fbf915feb581b1f932f52fa558ccdf3350a03'
PREVIOUS_IDENTITY_SHA = '940d05adf5d0667b532a35e23284133f2df195b1962922de810d94176980cb0c'
PREVIOUS_BUILD_ID = 'V20.6-R13.9-FAN-ADDRESS-2026-10-25'
BUILD_ID = 'V20.6-R14.0-TV-SPOTLIGHT-2026-10-26'
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
    assert len(sys.argv) == 2, 'Provide exact published KF-R139-FULL.zip'
    archive = Path(sys.argv[1])
    assert archive.stat().st_size == BASE_SIZE
    with archive.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == BASE_SHA
    feature_bytes = (ROOT / 'r140-tv-feature-patch.json').read_bytes()
    feature = json.loads(feature_bytes)
    assert digest(feature_bytes) == FEATURE_SHA
    assert (ROOT / 'r140-tv-feature-patch.sha256').read_text().split()[0] == FEATURE_SHA
    assert feature['schemaVersion'] == 1 and feature['release'] == 'R140-TV-DRAFT' and feature['baseline'] == 'R139'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == BASE_SIZE
    assert feature['archivePrefix'] == BASE_PREFIX
    assert len(feature['files']) == len({row['path'] for row in feature['files']}) == 8
    assert PATHS.isdisjoint(row['path'] for row in feature['files'])
    previous_bytes = (ROOT / 'r139-release-identity.json').read_bytes()
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
    assert len(baseline) == 1806 and set(originals) == PATHS
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
            assert channel['installedSequence'] == 139 and channel['channel'] == 'stable'
            channel['installedSequence'] = 140
            after = (json.dumps(channel, indent=2) + '\n').encode()
        elif name == 'scripts/build-and-install-windows.mjs':
            text = before.decode()
            old_title = 'Klipper Farm v1.14.5 - R139 Fan and Address Recovery'
            assert text.count(old_title) == 1
            after = text.replace(old_title, 'Klipper Farm v1.14.5 - R140 TV Spotlight').encode()
        else:
            text = before.decode()
            assert PREVIOUS_BUILD_ID in text, name
            text = text.replace(PREVIOUS_BUILD_ID, BUILD_ID).replace('R139', 'R140')
            old_sequence = 'assert.equal(channel.installedSequence,139' if name.endswith('check-r9-clean-installer.mjs') else 'assert.equal(updateChannel.installedSequence,139'
            assert text.count(old_sequence) == 1, name
            after = text.replace(old_sequence, old_sequence[:-3] + '140').encode()
        assert after != before, name
        rows.append({'path': name, 'beforeSha256': digest(before), 'sha256': digest(after),
                     'contentBase64': base64.b64encode(after).decode()})
    result = {'schemaVersion': 1, 'release': 'R140', 'baseline': 'R139', 'sequence': 140,
              'version': '1.14.5-r140', 'productVersion': '1.14.5', 'buildId': BUILD_ID,
              'featurePatchSha256': FEATURE_SHA, 'baseArchiveSha256': BASE_SHA,
              'baseArchiveSize': BASE_SIZE, 'archivePrefix': BASE_PREFIX,
              'baselineFiles': dict(sorted(baseline.items())), 'files': rows}
    data = (json.dumps(result, indent=2) + '\n').encode()
    (ROOT / 'r140-release-identity.json').write_bytes(data)
    sha = digest(data)
    (ROOT / 'r140-release-identity.sha256').write_text(sha + '  r140-release-identity.json\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'buildId': BUILD_ID, 'featurePatchSha256': FEATURE_SHA,
                      'releaseIdentitySha256': sha, 'metadataFiles': len(rows), 'baselineFiles': len(baseline)}))


if __name__ == '__main__':
    main()
