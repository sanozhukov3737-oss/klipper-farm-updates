#!/usr/bin/env python3
"""Restore exact R136 and apply only the two reviewed R137 backup changes.

Usage: python apply-r137.py KF-R136-FULL.zip NEW_DIRECTORY [--proof OUTPUT_JSON]
       python apply-r137.py --verify EXISTING_DIRECTORY [--proof OUTPUT_JSON]
Native review only: no release identity, installer or publication.
"""
import argparse
import base64
import hashlib
import json
import re
import zipfile
from pathlib import Path, PurePosixPath

BASE_SIZE = 582278200
BASE_SHA = '78a89704a083466a863085c0bc6a9c5317041212327c8e7e1393b7e914e9fd3f'
PREFIX = 'Klipper-Farm-R136/'
REVIEWED_PATHS = {'src-tauri/src/transactional_core/backup.rs',
                  'src-tauri/src/transactional_core/farm_coordinator.rs'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_name(name):
    assert isinstance(name, str) and name, 'Empty source path'
    path = PurePosixPath(name)
    assert not path.is_absolute() and '..' not in path.parts
    assert '\\' not in name and ':' not in name
    assert all(part not in ('', '.', '..') for part in name.split('/')), name
    return name


def patch_inputs():
    here = Path(__file__).resolve().parent
    payload = (here / 'r137-backup-patch.json').read_bytes()
    expected_patch = (here / 'r137-backup-patch.sha256').read_text().split()[0]
    assert re.fullmatch('[a-f0-9]{64}', expected_patch), 'Invalid patch digest'
    assert digest(payload) == expected_patch, 'Patch checksum mismatch'
    patch = json.loads(payload)
    assert patch['schemaVersion'] == 1 and patch['release'] == 'R137'
    assert patch['baseline'] == 'R136'
    assert patch['baseArchiveSize'] == BASE_SIZE and patch['baseArchiveSha256'] == BASE_SHA
    assert patch['archivePrefix'] == PREFIX
    expected = dict(patch['baselineFiles'])
    assert len(expected) == 1786, 'Baseline inventory differs'
    for name, value in expected.items():
        safe_name(name)
        assert re.fullmatch('[a-f0-9]{64}', value), name
    assert len(patch['files']) == 2
    assert {row['path'] for row in patch['files']} == REVIEWED_PATHS
    prepared = []
    for row in patch['files']:
        name = safe_name(row['path'])
        assert row['beforeSha256'] == expected[name], name
        data = base64.b64decode(row['contentBase64'], validate=True)
        assert digest(data) == row['sha256'] and row['sha256'] != row['beforeSha256'], name
        expected[name] = row['sha256']
        prepared.append((name, data))
    return patch, expected_patch, expected, prepared


def restore(archive, app, patch, prepared):
    assert not app.exists(), 'Destination must not exist'
    assert archive.stat().st_size == BASE_SIZE, 'Published archive size differs'
    with archive.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == BASE_SHA, 'Published archive digest differs'
    with zipfile.ZipFile(archive) as bundle:
        members = {}
        for info in bundle.infolist():
            assert info.filename.startswith(PREFIX), info.filename
            safe_name(info.filename.rstrip('/'))
            assert (info.external_attr >> 16) & 0o170000 != 0o120000, 'Source symlink rejected'
            if info.is_dir():
                continue
            name = safe_name(info.filename[len(PREFIX):])
            assert name not in members, 'Duplicate archive entry: ' + name
            members[name] = info
        assert set(members) == set(patch['baselineFiles']), 'Archive file inventory mismatch'
        # Check every original source byte before creating the destination.
        for name, info in members.items():
            assert digest(bundle.read(info)) == patch['baselineFiles'][name], name
        app.mkdir(parents=True)
        for name, info in members.items():
            target = app / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(info))
    for name, data in prepared:
        (app / name).write_bytes(data)


def verify(app, expected):
    assert app.is_dir() and not app.is_symlink(), 'Source directory missing or symlinked'
    actual = set()
    for item in app.rglob('*'):
        assert not item.is_symlink(), 'Source symlink rejected: ' + str(item)
        if item.is_file():
            name = item.relative_to(app).as_posix()
            assert name in expected, 'Unreviewed extra source file: ' + name
            assert digest(item.read_bytes()) == expected[name], name
            actual.add(name)
    assert actual == set(expected), 'Source file inventory differs'
    assert len(actual) == 1786
    channel = json.loads((app / 'UPDATE-CHANNEL.json').read_bytes())
    assert channel['installedSequence'] == 136, 'Review must retain the published R136 identity'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths', nargs='*', type=Path)
    parser.add_argument('--verify', type=Path)
    parser.add_argument('--proof', type=Path)
    args = parser.parse_args()
    patch, patch_sha, expected, prepared = patch_inputs()
    if args.verify is not None:
        assert not args.paths, 'Use --verify or archive/destination, not both'
        app = args.verify.resolve()
    else:
        assert len(args.paths) == 2, 'Provide the exact published ZIP and a new destination'
        archive, app = args.paths[0].resolve(), args.paths[1].resolve()
        restore(archive, app, patch, prepared)
    verify(app, expected)
    result = {'schemaVersion': 1, 'passed': True, 'release': 'R137', 'baseline': 'R136',
              'source': str(app), 'baseArchiveSize': BASE_SIZE, 'baseArchiveSha256': BASE_SHA,
              'patchSha256': patch_sha, 'baselineFiles': 1786, 'verifiedFiles': len(expected),
              'reviewedFiles': len(prepared), 'extraSourceFiles': 0,
              'allOtherSourceBytesPreserved': True, 'installedSequence': 136,
              'releaseIdentityChanged': False, 'installerBuilt': False, 'releasePublished': False}
    if args.proof:
        proof = args.proof.resolve()
        assert not proof.is_relative_to(app), 'Proof must be written outside the reviewed source'
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
