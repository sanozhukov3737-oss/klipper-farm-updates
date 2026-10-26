#!/usr/bin/env python3
"""Apply the frozen R141 performance, telemetry and fullscreen overlay and exactly five release metadata changes.

Usage: python apply-r141-release.py KF-R140-FULL.zip NEW_ROOT [--proof OUTPUT_JSON]
       python apply-r141-release.py --verify EXISTING_ROOT [--proof OUTPUT_JSON]
Does not build, sign, install or publish an update.
"""
import argparse
import base64
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath

FEATURE_SHA = 'aa815014c1868d5b748693cde4da180a0a17e1707b99c5b65d06ca897648f0ca'
IDENTITY_SHA = '254a34bb0d1656d551f3d46c503e656e3a358eb28b231b56c0110a2e4795146c'
BASE_SHA = 'cbbc7d2c2d043cacd953191281d0c7d5ce8d650064576263ad87a5a8c544cf04'
BASE_SIZE = 582390782
BASE_PREFIX = 'Klipper-Farm-R140/'
BUILD_ID = 'V20.6-R14.1-PERFORMANCE-TELEMETRY-2026-10-26'
IDENTITY_PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json',
                  'scripts/build-and-install-windows.mjs', 'scripts/check-r9-clean-installer.mjs',
                  'scripts/check-release-portability.mjs'}
FEATURE_PATHS = {
    'src/App.tsx',
    'src/components/DeferredPanel.tsx',
    'src/components/DeferredPanel.css',
    'src/components/TvDashboard.tsx',
    'src/lib/tvSpotlight.ts',
    'src/lib/modalAccessibility.ts',
    'scripts/check-r141-tv-projection.mjs',
    'scripts/check-r141-performance-report.mjs',
    'ui-tests/r141-performance.mjs',
    'ui-tests/r141-performance-app.html',
    'ui-tests/r141-performance-tv.html',
    'src/components/TvDashboard.css',
    'src/lib/moonraker.ts',
    'src/types.ts',
    'src-tauri/src/transactional_core/temperature.rs',
    'src-tauri/src/transactional_core/mod.rs',
    'src-tauri/src/transactional_core/types.rs',
    'src-tauri/src/transactional_core/actor.rs',
    'src-tauri/src/transactional_core/journal.rs',
    'src-tauri/src/online_updates.rs',
    'scripts/check-v20-6-discovery-display.mjs',
    'scripts/run-rust-tests.mjs',
    'scripts/check-r141-temperature-merge.mjs',
    'src/lib/tvFullscreen.ts',
    'src-tauri/capabilities/default.json',
    'scripts/check-security.mjs',
    'scripts/check-r141-tv-fullscreen.mjs',
    'ui-tests/tv-fullscreen-r141.html',
    'ui-tests/tv-fullscreen-r141.mjs',
    'ui-tests/tv-fullscreen-r141.tsx',
    'ui-tests/tv-fullscreen-r141-window.ts',
    'scripts/check-filament-telemetry.mjs',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    parsed = PurePosixPath(name)
    assert name and not parsed.is_absolute() and '..' not in parsed.parts
    assert '\\' not in name and ':' not in name and '\0' not in name
    assert all(part not in ('', '.', '..') for part in name.split('/'))


def inputs():
    repo = Path(__file__).resolve().parent
    feature_bytes = (repo / 'r141-performance-patch.json').read_bytes()
    identity_bytes = (repo / 'r141-release-identity.json').read_bytes()
    assert digest(feature_bytes) == FEATURE_SHA, 'Frozen feature overlay differs'
    assert (repo / 'r141-performance-patch.sha256').read_text().split()[0] == FEATURE_SHA
    assert digest(identity_bytes) == IDENTITY_SHA, 'Release identity differs'
    assert (repo / 'r141-release-identity.sha256').read_text().split()[0] == IDENTITY_SHA
    feature, identity = json.loads(feature_bytes), json.loads(identity_bytes)
    assert feature['schemaVersion'] == 1 and feature['release'] == 'R141-PERFORMANCE-DRAFT' and feature['baseline'] == 'R140'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == BASE_SIZE
    assert feature['archivePrefix'] == BASE_PREFIX
    assert len(feature['files']) == 32 and {row['path'] for row in feature['files']} == FEATURE_PATHS
    assert identity['schemaVersion'] == 1 and identity['release'] == 'R141' and identity['baseline'] == 'R140'
    assert identity['sequence'] == 141 and identity['buildId'] == BUILD_ID
    assert identity['version'] == '1.14.5-r141' and identity['productVersion'] == '1.14.5'
    assert identity['baseArchiveSha256'] == BASE_SHA and identity['baseArchiveSize'] == BASE_SIZE
    assert identity['archivePrefix'] == BASE_PREFIX
    assert identity['featurePatchSha256'] == FEATURE_SHA and len(identity['files']) == 5
    assert {row['path'] for row in identity['files']} == IDENTITY_PATHS
    assert not FEATURE_PATHS.intersection(IDENTITY_PATHS)
    baseline = identity['baselineFiles']
    assert feature['baselineFiles'] == baseline, 'Frozen feature baseline differs'
    assert isinstance(baseline, dict) and len(baseline) == 1811
    for name, value in baseline.items():
        safe_name(name)
        assert isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), name
    expected = dict(baseline)
    changes = []
    for rows in [feature['files'], identity['files']]:
        for row in rows:
            name = row['path']; safe_name(name)
            assert row['beforeSha256'] == expected.get(name), name
            data = base64.b64decode(row['contentBase64'], validate=True)
            assert digest(data) == row['sha256'], name
            expected[name] = row['sha256']
            changes.append((name, row['beforeSha256'], data))
    assert len(expected) == 1826 and sum(before is None for _, before, _ in changes) == 15
    return feature, identity, baseline, expected, changes


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
    channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text())
    assert channel['installedSequence'] == 141 and channel['channel'] == 'stable'


def extract_baseline(archive, root, baseline):
    assert archive.stat().st_size == BASE_SIZE
    with archive.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == BASE_SHA, 'Published R140 archive differs'
    with zipfile.ZipFile(archive) as bundle:
        entries = {}
        for entry in bundle.infolist():
            assert entry.filename.startswith(BASE_PREFIX), entry.filename
            name = entry.filename[len(BASE_PREFIX):]
            if not name or entry.is_dir():
                continue
            safe_name(name)
            assert name not in entries and ((entry.external_attr >> 16) & 0o170000) != 0o120000
            entries[name] = entry
        assert set(entries) == set(baseline), 'Published R140 inventory differs'
        for name, entry in entries.items():
            with bundle.open(entry) as stream:
                assert hashlib.file_digest(stream, 'sha256').hexdigest() == baseline[name], name
        root.mkdir(parents=True)
        for name, entry in entries.items():
            target = root / name; target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as stream, target.open('wb') as output:
                shutil.copyfileobj(stream, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths', nargs='*', type=Path)
    parser.add_argument('--verify', type=Path)
    parser.add_argument('--proof', type=Path)
    args = parser.parse_args()
    feature, identity, baseline, expected, changes = inputs()
    if args.verify is not None:
        assert not args.paths, 'Use archive/destination or --verify'
        assert not args.verify.is_symlink(), 'Source symlink rejected'
        root = args.verify.resolve()
    else:
        assert len(args.paths) == 2, 'Provide exact R140 archive and a new source root'
        archive, requested = args.paths
        assert not requested.is_symlink(), 'Destination symlink rejected'
        root = requested.resolve()
        assert not root.exists(), 'Destination must not exist'
        extract_baseline(archive.resolve(), root, baseline)
        for name, before, _ in changes:
            target = root / name
            assert not target.exists() if before is None else digest(target.read_bytes()) == before, name
        for name, _, data in changes:
            target = root / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
    verify(root, expected)
    clean = lambda rows: [{key: value for key, value in row.items() if key != 'contentBase64'} for row in rows]
    report = {'passed': True, 'release': 'R141', 'baseline': 'R140',
              'baseArchiveSha256': BASE_SHA, 'featurePatchSha256': FEATURE_SHA,
              'releaseIdentitySha256': IDENTITY_SHA, 'buildId': BUILD_ID,
              'baselineFiles': len(baseline), 'verifiedFiles': len(expected),
              'reviewedFeatureFiles': len(feature['files']), 'releaseIdentityFiles': len(identity['files']),
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
