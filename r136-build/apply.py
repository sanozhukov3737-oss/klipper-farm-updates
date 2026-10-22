#!/usr/bin/env python3
"""Restore exact R135, apply the approved R136 features, then release identity only."""
import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

FEATURE_SHA = 'c1590be23656c77d00169f849e84daf169d1285d68df0c740929c130f024693f'
IDENTITY_PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json',
                  'scripts/build-and-install-windows.mjs',
                  'scripts/check-r9-clean-installer.mjs',
                  'scripts/check-release-portability.mjs'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity_inputs(repo):
    payload = (repo / 'r136-release-identity.json').read_bytes()
    wanted = (repo / 'r136-release-identity.sha256').read_text().split()[0]
    assert digest(payload) == wanted, 'Release identity checksum mismatch'
    identity = json.loads(payload)
    assert identity['schemaVersion'] == 1
    assert identity['release'] == 'R136' and identity['baseline'] == 'R135'
    assert identity['sequence'] == 136 and identity['featurePatchSha256'] == FEATURE_SHA
    assert identity['buildId'] == 'V20.6-R13.6-COST-PHOTOS-BLUE-2026-10-22'
    assert len(identity['files']) == len(IDENTITY_PATHS)
    assert {row['path'] for row in identity['files']} == IDENTITY_PATHS
    prepared = []
    for row in identity['files']:
        name = row['path']
        q = PurePosixPath(name)
        assert not q.is_absolute() and '..' not in q.parts and '\\' not in name
        data = base64.b64decode(row['contentBase64'], validate=True)
        assert digest(data) == row['sha256'], name
        prepared.append((name, row['beforeSha256'], data))
    return identity, wanted, prepared


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python r136-build/apply.py KF-R135-FULL.zip NEW_SOURCE_ROOT')
    repo = Path(__file__).resolve().parent.parent
    archive, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    assert not root.exists(), 'Destination must not exist'
    assert digest((repo / 'r136-window-photos-patch.json').read_bytes()) == FEATURE_SHA
    identity, wanted, prepared = identity_inputs(repo)
    subprocess.run([sys.executable, str(repo / 'apply-r136.py'), str(archive), str(root)], check=True)
    # Validate every before/payload hash before changing any reviewed source byte.
    for name, before, _ in prepared:
        assert digest((root / name).read_bytes()) == before, 'Identity base differs: ' + name
    for name, _, data in prepared:
        (root / name).write_bytes(data)
    print(json.dumps({'passed': True, 'release': 'R136', 'source': str(root),
                      'featurePatchSha256': FEATURE_SHA, 'identitySha256': wanted,
                      'identityFiles': len(prepared), 'buildId': identity['buildId']}, indent=2))


if __name__ == '__main__':
    main()
