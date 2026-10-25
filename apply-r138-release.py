#!/usr/bin/env python3
"""Apply the frozen R138 review patch and only the five release identity changes.

Usage: python apply-r138-release.py KF-R137-FULL.zip NEW_ROOT [--proof OUTPUT_JSON]
       python apply-r138-release.py --verify EXISTING_ROOT [--proof OUTPUT_JSON]
Does not build, sign, install or publish an update.
"""
import argparse
import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

FEATURE_SHA = 'f00d0eee45ccc36fbee60077526e7fceae099f302adaf574ab01d5f6a7d70fa1'
IDENTITY_SHA = '2223adccadc3a5440c1dbb5a152b1828c96d8d6d5c76089354d85b175f1d9cee'
BASE_SHA = 'a2c7c77fc62cd6818be5f86192827ded786e3a4ac99ebdb6559924a30ae1c6ca'
BASE_SIZE = 582284313
BUILD_ID = 'V20.6-R13.8-LIVE-CARDS-2026-10-25'
FEATURE_PATHS = {'src/lib/printerVisualActivity.ts', 'src/components/PrinterTemperatureSparkline.tsx', 'src/lib/usePrinterVisualActivity.ts', 'src/components/FleetPrinterCard.tsx', 'ui-tests/live-cards-r138.tsx', 'src/App.tsx', 'src/components/FleetLive.module.css', 'src/styles.css', 'src/components/ControlPanel.tsx', 'ui-tests/live-cards-r138.mjs', 'ui-tests/live-cards-r138.html', 'scripts/check-r138-visual-activity.mjs'}
IDENTITY_PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json',
                  'scripts/build-and-install-windows.mjs', 'scripts/check-r9-clean-installer.mjs',
                  'scripts/check-release-portability.mjs'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inputs():
    repo = Path(__file__).resolve().parent
    feature_bytes = (repo / 'r138-live-ui-patch.json').read_bytes()
    identity_bytes = (repo / 'r138-release-identity.json').read_bytes()
    assert digest(feature_bytes) == FEATURE_SHA, 'Frozen reviewed feature patch differs'
    assert (repo / 'r138-live-ui-patch.sha256').read_text().split()[0] == FEATURE_SHA
    assert digest(identity_bytes) == IDENTITY_SHA, 'Release identity differs'
    assert (repo / 'r138-release-identity.sha256').read_text().split()[0] == IDENTITY_SHA
    feature, identity = json.loads(feature_bytes), json.loads(identity_bytes)
    assert feature['schemaVersion'] == 1 and feature['release'] == 'R138' and feature['baseline'] == 'R137'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == BASE_SIZE
    assert feature['archivePrefix'] == 'Klipper-Farm-R137/'
    expected = dict(feature['baselineFiles'])
    assert len(expected) == 1786 and len(feature['files']) == 12
    assert {row['path'] for row in feature['files']} == FEATURE_PATHS
    assert identity['schemaVersion'] == 1 and identity['release'] == 'R138' and identity['baseline'] == 'R137'
    assert identity['sequence'] == 138 and identity['buildId'] == BUILD_ID
    assert identity['version'] == '1.14.5-r138' and identity['productVersion'] == '1.14.5'
    assert identity['featurePatchSha256'] == FEATURE_SHA and len(identity['files']) == 5
    assert {row['path'] for row in identity['files']} == IDENTITY_PATHS
    assert not FEATURE_PATHS.intersection(IDENTITY_PATHS)
    identity_rows = []
    for rows in [feature['files'], identity['files']]:
        for row in rows:
            name = row['path']
            parsed = PurePosixPath(name)
            assert not parsed.is_absolute() and '..' not in parsed.parts and '\\' not in name and ':' not in name
            assert row['beforeSha256'] == expected.get(name), name
            data = base64.b64decode(row['contentBase64'], validate=True)
            assert digest(data) == row['sha256'], name
            expected[name] = row['sha256']
            if name in IDENTITY_PATHS:
                identity_rows.append((name, row['beforeSha256'], data))
    return repo, feature, identity, expected, identity_rows


def verify(root, expected):
    assert root.is_dir() and not root.is_symlink(), 'Source directory missing or symlinked'
    actual = set()
    for entry in root.rglob('*'):
        assert not entry.is_symlink(), 'Source symlink rejected'
        if entry.is_file():
            name = entry.relative_to(root).as_posix()
            assert name in expected, 'Unreviewed extra source file: ' + name
            assert digest(entry.read_bytes()) == expected[name], 'Source bytes differ: ' + name
            actual.add(name)
    assert actual == set(expected) and len(actual) == 1793, 'Source inventory differs'
    assert (root / 'RELEASE-BUILD-ID.txt').read_text().strip() == BUILD_ID
    assert json.loads((root / 'UPDATE-CHANNEL.json').read_text())['installedSequence'] == 138


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths', nargs='*', type=Path)
    parser.add_argument('--verify', type=Path)
    parser.add_argument('--proof', type=Path)
    args = parser.parse_args()
    repo, feature, identity, expected, identity_rows = inputs()
    if args.verify is not None:
        assert not args.paths, 'Use archive/destination or --verify'
        root = args.verify.resolve()
    else:
        assert len(args.paths) == 2, 'Provide exact R137 archive and a new source root'
        archive, root = [path.resolve() for path in args.paths]
        assert not root.exists(), 'Destination must not exist'
        assert archive.stat().st_size == BASE_SIZE
        with archive.open('rb') as stream:
            assert hashlib.file_digest(stream, 'sha256').hexdigest() == BASE_SHA
        subprocess.run([sys.executable, str(repo / 'apply-r138.py'), str(archive), str(root)], check=True)
        # Validate every identity input before changing any release metadata.
        for name, before, _ in identity_rows:
            assert digest((root / name).read_bytes()) == before, name
        for name, _, data in identity_rows:
            (root / name).write_bytes(data)
    verify(root, expected)
    clean = lambda rows: [{key: value for key, value in row.items() if key != 'contentBase64'} for row in rows]
    report = {'passed': True, 'release': 'R138', 'baseline': 'R137',
              'baseArchiveSha256': BASE_SHA, 'featurePatchSha256': FEATURE_SHA,
              'releaseIdentitySha256': IDENTITY_SHA, 'buildId': BUILD_ID,
              'baselineFiles': len(feature['baselineFiles']), 'verifiedFiles': len(expected),
              'reviewedFeatureFiles': 12, 'releaseIdentityFiles': len(identity_rows),
              'allOtherSourceBytesPreserved': True, 'extraSourceFiles': 0,
              'featureFiles': clean(feature['files']), 'identityFiles': clean(identity['files'])}
    if args.proof:
        proof = args.proof.resolve()
        assert not proof.is_relative_to(root), 'Write proof outside reviewed source'
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key not in ['featureFiles', 'identityFiles']}, indent=2))


if __name__ == '__main__':
    main()
