#!/usr/bin/env python3
"""Apply the reviewed R141 performance and temperature draft to exact published R140 source.

python apply-r141-performance.py PATH_TO_EXTRACTED_R140
python apply-r141-performance.py --archive KF-R140-FULL.zip --output NEW_DIRECTORY

Checks every baseline file and all reviewed before/after hashes before changing
source. Reapplying is safe. This does not build, change release identity or
publish an update. Run before rebuilding dist/release manifests.
"""
import argparse
import base64
import hashlib
import json
import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

PATCH_SHA = '9b06cabe0f214a0b1f7f2e079671f5b239596262b5329cae609a4f0d9e9325ae'
BASE_SHA = 'cbbc7d2c2d043cacd953191281d0c7d5ce8d650064576263ad87a5a8c544cf04'
BASE_SIZE = 582390782
BUILD_ID = 'V20.6-R14.0-TV-SPOTLIGHT-2026-10-26'
PREFIX = 'Klipper-Farm-R140/'
PATHS = {
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
}
IGNORED_DIRECTORIES = {'node_modules', 'ui-tests/node_modules', '.git', '.klipper-build-cache'}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_name(name):
    assert isinstance(name, str) and name
    path = PurePosixPath(name)
    assert not path.is_absolute() and '..' not in path.parts
    assert '\\' not in name and ':' not in name and '\0' not in name
    assert all(part not in ('', '.', '..') for part in name.split('/'))


def source_files(root):
    result = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            assert not (Path(directory) / name).is_symlink(), 'Symlink directory in source'
        # Published offline-tools/node_modules are part of the exact source
        # payload. Only development dependencies at these roots are ignored.
        directories[:] = [name for name in directories
                          if (Path(directory) / name).relative_to(root).as_posix() not in IGNORED_DIRECTORIES
                          and name != '__pycache__']
        for name in files:
            path = Path(directory) / name
            assert not path.is_symlink() and path.is_file(), 'Expected regular source file'
            relative = path.relative_to(root).as_posix()
            safe_name(relative)
            result[relative] = path
    return result


def load_patch():
    raw = Path(__file__).with_name('r141-performance-patch.json').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == PATCH_SHA, 'Reviewed performance patch differs'
    value = json.loads(raw)
    assert value['schemaVersion'] == 1 and value['release'] == 'R141-PERFORMANCE-DRAFT'
    assert value['baseline'] == 'R140' and value['baselineSequence'] == 140
    assert value['baselineBuildId'] == BUILD_ID
    assert value['baseArchiveSha256'] == BASE_SHA and value['baseArchiveSize'] == BASE_SIZE
    assert value['archivePrefix'] == PREFIX
    assert value['installerBuilt'] is False and value['releasePublished'] is False
    assert len(value['baselineFiles']) == 1811
    assert len(value['files']) == 23 and {row['path'] for row in value['files']} == PATHS
    assert sum(row['beforeSha256'] is None for row in value['files']) == 9
    for name in value['baselineFiles']:
        safe_name(name)
    prepared = {}
    for row in value['files']:
        safe_name(row['path'])
        assert row['beforeSha256'] == value['baselineFiles'].get(row['path']), row['path']
        data = base64.b64decode(row['contentBase64'], validate=True)
        assert hashlib.sha256(data).hexdigest() == row['sha256'], row['path']
        prepared[row['path']] = (row, data)
    return value, prepared


def preflight(root, patch, prepared):
    assert root.is_dir() and not root.is_symlink(), 'Expected extracted R140 source directory'
    assert (root / 'RELEASE-BUILD-ID.txt').read_text().strip() == BUILD_ID, 'Expected R140 build identity'
    assert json.loads((root / 'UPDATE-CHANNEL.json').read_text())['installedSequence'] == 140
    files = source_files(root)
    assert set(files).issubset(set(patch['baselineFiles']) | PATHS), 'Unreviewed extra source file'
    assert set(patch['baselineFiles']).issubset(files), 'Missing published R140 source file'
    changes = []
    for name, path in files.items():
        current = digest(path)
        if name in prepared:
            row, data = prepared[name]
            assert current in {row['beforeSha256'], row['sha256']}, 'Source differs: ' + name
            if current != row['sha256']:
                changes.append((name, data))
        else:
            assert current == patch['baselineFiles'][name], 'Unreviewed source differs: ' + name
    for name, (row, data) in prepared.items():
        if name not in files:
            assert row['beforeSha256'] is None, 'Missing R140 file: ' + name
            changes.append((name, data))
    # Validate every destination and its parents before any source mutation.
    for name, _ in changes:
        target = root / name
        target.resolve().relative_to(root)
        for parent in target.parents:
            if parent == root:
                break
            assert not parent.is_symlink(), 'Symlink parent: ' + name
            assert not parent.exists() or parent.is_dir(), 'Invalid parent: ' + name
        assert not target.is_symlink(), name
    return changes


def apply(root, patch, prepared):
    changes = preflight(root, patch, prepared)
    temporary_files = []
    try:
        for index, (name, data) in enumerate(changes):
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + f'.r141-performance-{os.getpid()}-{index}.partial')
            mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o644
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
            temporary_files.append((temporary, target))
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        for temporary, target in temporary_files:
            os.replace(temporary, target)
    finally:
        for temporary, _ in temporary_files:
            temporary.unlink(missing_ok=True)
    assert not preflight(root, patch, prepared), 'Final overlay verification failed'
    return len(changes)


def extract_archive(archive, output, patch):
    assert archive.is_file() and not archive.is_symlink()
    assert archive.stat().st_size == BASE_SIZE and digest(archive) == BASE_SHA, 'Published R140 ZIP differs'
    assert not output.exists(), 'Archive output must be a new directory'
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.r141-source-', dir=output.parent))
    try:
        with zipfile.ZipFile(archive) as bundle:
            entries = {}
            for entry in bundle.infolist():
                assert entry.filename.startswith(PREFIX), entry.filename
                name = entry.filename.removeprefix(PREFIX)
                if not name or entry.is_dir():
                    continue
                safe_name(name)
                assert name not in entries and (entry.external_attr >> 16) & 0o170000 != 0o120000
                entries[name] = entry
            assert set(entries) == set(patch['baselineFiles']), 'Published source inventory differs'
            for name, entry in entries.items():
                target = staging / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, target.open('xb') as destination:
                    shutil.copyfileobj(source, destination)
        return staging
    except BaseException:
        shutil.rmtree(staging)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', nargs='?', type=Path)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    assert (args.root is not None) != (args.archive is not None), 'Choose extracted source or --archive'
    assert bool(args.output) == bool(args.archive), '--output is required only with --archive'
    patch, prepared = load_patch()
    staging = None
    try:
        if args.archive:
            output = args.output.absolute()
            staging = extract_archive(args.archive, output, patch)
            root = staging.resolve(strict=True)
        else:
            root = args.root.resolve(strict=True)
        changed = apply(root, patch, prepared)
        if staging is not None:
            assert not output.exists(), 'Output appeared while preparing source'
            os.rename(staging, output)
            staging = None
            root = output
        print(json.dumps({'passed': True, 'appliedFiles': changed, 'verifiedFiles': 1820,
                          'baselineFiles': 1811, 'scope': 'Reviewed performance, heater provenance and TV outline draft only',
                          'source': str(root), 'installerBuilt': False, 'releasePublished': False}))
    finally:
        if staging is not None:
            shutil.rmtree(staging)


if __name__ == '__main__':
    main()
