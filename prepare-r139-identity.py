#!/usr/bin/env python3
"""Generate five R139 metadata edits after the reviewed feature overlay is frozen.

Only writes r139-release-identity.json and its checksum. Source files are not edited.
"""
import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE_SHA = '6ca02e8bfd959c42044d6335e9df521d4a9a31d02452f47907c000a1176ca2aa'
PREVIOUS_IDENTITY_SHA = '2223adccadc3a5440c1dbb5a152b1828c96d8d6d5c76089354d85b175f1d9cee'
PREVIOUS_BUILD_ID = 'V20.6-R13.8-LIVE-CARDS-2026-10-25'
BUILD_ID = 'V20.6-R13.9-FAN-ADDRESS-2026-10-25'
PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json', 'scripts/build-and-install-windows.mjs',
         'scripts/check-r9-clean-installer.mjs', 'scripts/check-release-portability.mjs'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    feature_bytes = (ROOT / 'r139-feature-patch.json').read_bytes()
    feature = json.loads(feature_bytes)
    feature_sha = digest(feature_bytes)
    assert (ROOT / 'r139-feature-patch.sha256').read_text().split()[0] == feature_sha
    assert feature['release'] == 'R139' and feature['baseline'] == 'R138'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == 582302630
    assert len(feature['baselineFiles']) == 1793 and feature['files']
    assert PATHS.isdisjoint(row['path'] for row in feature['files'])
    previous_bytes = (ROOT / 'r138-release-identity.json').read_bytes()
    assert digest(previous_bytes) == PREVIOUS_IDENTITY_SHA
    previous = json.loads(previous_bytes)
    assert {row['path'] for row in previous['files']} == PATHS
    rows = []
    for row in previous['files']:
        name = row['path']
        before = base64.b64decode(row['contentBase64'], validate=True)
        assert digest(before) == row['sha256'] == feature['baselineFiles'][name], name
        if name == 'RELEASE-BUILD-ID.txt':
            assert before.decode().strip() == PREVIOUS_BUILD_ID
            after = (BUILD_ID + '\n').encode()
        elif name == 'UPDATE-CHANNEL.json':
            channel = json.loads(before)
            assert channel['installedSequence'] == 138 and channel['channel'] == 'stable'
            channel['installedSequence'] = 139
            after = (json.dumps(channel, indent=2) + '\n').encode()
        elif name == 'scripts/build-and-install-windows.mjs':
            text = before.decode()
            old_title = 'Klipper Farm v1.14.5 - R138 Live Printer Cards'
            assert text.count(old_title) == 1
            after = text.replace(old_title, 'Klipper Farm v1.14.5 - R139 Fan and Address Recovery').encode()
        else:
            text = before.decode()
            assert PREVIOUS_BUILD_ID in text, name
            text = text.replace(PREVIOUS_BUILD_ID, BUILD_ID).replace('R138', 'R139')
            old_sequence = 'assert.equal(channel.installedSequence,138' if name.endswith('check-r9-clean-installer.mjs') else 'assert.equal(updateChannel.installedSequence,138'
            assert text.count(old_sequence) == 1, name
            after = text.replace(old_sequence, old_sequence[:-3] + '139').encode()
        assert after != before, name
        rows.append({'path': name, 'beforeSha256': digest(before), 'sha256': digest(after),
                     'contentBase64': base64.b64encode(after).decode()})
    result = {'schemaVersion': 1, 'release': 'R139', 'baseline': 'R138', 'sequence': 139,
              'version': '1.14.5-r139', 'productVersion': '1.14.5', 'buildId': BUILD_ID,
              'featurePatchSha256': feature_sha, 'files': rows}
    data = (json.dumps(result, indent=2) + '\n').encode()
    (ROOT / 'r139-release-identity.json').write_bytes(data)
    sha = digest(data)
    (ROOT / 'r139-release-identity.sha256').write_text(sha + '  r139-release-identity.json\n')
    print(json.dumps({'passed': True, 'buildId': BUILD_ID, 'featurePatchSha256': feature_sha,
                      'releaseIdentitySha256': sha, 'metadataFiles': len(rows)}))


if __name__ == '__main__':
    main()
