#!/usr/bin/env python3
"""Apply the frozen R139 overlay and only the five established release metadata changes.

Usage: python apply-r139-release.py KF-R138-FULL.zip NEW_ROOT [--proof OUTPUT_JSON]
       python apply-r139-release.py --verify EXISTING_ROOT [--proof OUTPUT_JSON]
Does not build, sign, install or publish an update.
"""
import argparse
import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

FEATURE_SHA = '5777b34ba86b476a5afb28a85dab8e0a4104f55007085e5013727a5aaf1cd0a3'
IDENTITY_SHA = '24ab1c0753556e4d2ac83cfec68241c8ffb5abab50793c83491a46f8e8c31e55'
BASE_SHA = '6ca02e8bfd959c42044d6335e9df521d4a9a31d02452f47907c000a1176ca2aa'
BASE_SIZE = 582302630
BUILD_ID = 'V20.6-R13.9-FAN-ADDRESS-2026-10-25'
IDENTITY_PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json',
                  'scripts/build-and-install-windows.mjs', 'scripts/check-r9-clean-installer.mjs',
                  'scripts/check-release-portability.mjs'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inputs():
    repo = Path(__file__).resolve().parent
    feature_bytes = (repo / 'r139-feature-patch.json').read_bytes()
    identity_bytes = (repo / 'r139-release-identity.json').read_bytes()
    assert digest(feature_bytes) == FEATURE_SHA, 'Frozen feature overlay differs'
    assert (repo / 'r139-feature-patch.sha256').read_text().split()[0] == FEATURE_SHA
    assert digest(identity_bytes) == IDENTITY_SHA, 'Release identity differs'
    assert (repo / 'r139-release-identity.sha256').read_text().split()[0] == IDENTITY_SHA
    feature, identity = json.loads(feature_bytes), json.loads(identity_bytes)
    assert feature['schemaVersion'] == 1 and feature['release'] == 'R139' and feature['baseline'] == 'R138'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == BASE_SIZE
    assert feature['archivePrefix'] == 'Klipper-Farm-R138/'
    expected = dict(feature['baselineFiles'])
    assert len(expected) == 1793 and feature['files']
    feature_paths = {row['path'] for row in feature['files']}
    assert len(feature_paths) == len(feature['files'])
    assert identity['schemaVersion'] == 1 and identity['release'] == 'R139' and identity['baseline'] == 'R138'
    assert identity['sequence'] == 139 and identity['buildId'] == BUILD_ID
    assert identity['version'] == '1.14.5-r139' and identity['productVersion'] == '1.14.5'
    assert identity['featurePatchSha256'] == FEATURE_SHA and len(identity['files']) == 5
    assert {row['path'] for row in identity['files']} == IDENTITY_PATHS
    assert not feature_paths.intersection(IDENTITY_PATHS)
    identity_rows = []
    for rows in [feature['files'], identity['files']]:
        for row in rows:
            name = row['path']; parsed = PurePosixPath(name)
            assert name and not parsed.is_absolute() and '..' not in parsed.parts
            assert '\\' not in name and ':' not in name and '\0' not in name
            assert all(part not in ('', '.', '..') for part in name.split('/'))
            if name not in IDENTITY_PATHS:
                assert name.startswith(('src/', 'src-tauri/', 'scripts/', 'ui-tests/'))
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
            with entry.open('rb') as stream:
                assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected[name], name
            actual.add(name)
    assert actual == set(expected), 'Source inventory differs'
    assert (root / 'RELEASE-BUILD-ID.txt').read_text().strip() == BUILD_ID
    assert json.loads((root / 'UPDATE-CHANNEL.json').read_text())['installedSequence'] == 139


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
        assert len(args.paths) == 2, 'Provide exact R138 archive and a new source root'
        archive, root = [path.resolve() for path in args.paths]
        assert not root.exists(), 'Destination must not exist'
        assert archive.stat().st_size == BASE_SIZE
        with archive.open('rb') as stream:
            assert hashlib.file_digest(stream, 'sha256').hexdigest() == BASE_SHA
        subprocess.run([sys.executable, str(repo / 'apply-r139.py'), str(archive), str(root)], check=True)
        for name, before, _ in identity_rows:
            assert digest((root / name).read_bytes()) == before, name
        for name, _, data in identity_rows:
            (root / name).write_bytes(data)
    verify(root, expected)
    clean = lambda rows: [{key: value for key, value in row.items() if key != 'contentBase64'} for row in rows]
    report = {'passed': True, 'release': 'R139', 'baseline': 'R138',
              'baseArchiveSha256': BASE_SHA, 'featurePatchSha256': FEATURE_SHA,
              'releaseIdentitySha256': IDENTITY_SHA, 'buildId': BUILD_ID,
              'baselineFiles': len(feature['baselineFiles']), 'verifiedFiles': len(expected),
              'reviewedFeatureFiles': len(feature['files']), 'releaseIdentityFiles': len(identity_rows),
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
