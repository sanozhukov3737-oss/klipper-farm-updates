#!/usr/bin/env python3
"""Apply only the frozen R139 feature overlay to the exact released R138 source."""
import base64
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent
FEATURE_SHA = 'ebeaf8aa2a09b50d747dcfa1b6d970d50e3397378d3a66b756ea8f74153aa2c0'
BASE_SHA = '6ca02e8bfd959c42044d6335e9df521d4a9a31d02452f47907c000a1176ca2aa'
BASE_SIZE = 582302630


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_relative(name):
    parsed = PurePosixPath(name)
    assert name and not parsed.is_absolute() and '..' not in parsed.parts
    assert '\\' not in name and ':' not in name and '\0' not in name
    assert all(part not in ('', '.', '..') for part in name.split('/'))
    return parsed


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python apply-r139.py KF-R138-FULL.zip NEW_DIRECTORY')
    archive, destination = map(Path, sys.argv[1:])
    feature_bytes = (ROOT / 'r139-feature-patch.json').read_bytes()
    assert hashlib.sha256(feature_bytes).hexdigest() == FEATURE_SHA, 'Frozen R139 overlay differs'
    assert (ROOT / 'r139-feature-patch.sha256').read_text().split()[0] == FEATURE_SHA
    patch = json.loads(feature_bytes)
    assert patch['schemaVersion'] == 1 and patch['baseline'] == 'R138' and patch['release'] == 'R139'
    assert patch['archivePrefix'] == 'Klipper-Farm-R138/'
    assert patch['baseArchiveSha256'] == BASE_SHA and patch['baseArchiveSize'] == BASE_SIZE
    assert archive.stat().st_size == BASE_SIZE and sha(archive) == BASE_SHA, 'Released R138 bytes differ'
    assert not destination.is_symlink()
    assert not destination.exists() or destination.is_dir() and not any(destination.iterdir()), 'Destination must be new or empty'
    baseline = patch['baselineFiles']
    assert len(baseline) == 1793
    reviewed = {}
    assert patch['files'], 'Empty feature overlay rejected'
    for change in patch['files']:
        name = change['path']; safe_relative(name)
        assert name not in reviewed and name.startswith(('src/', 'src-tauri/', 'scripts/', 'ui-tests/'))
        data = base64.b64decode(change['contentBase64'], validate=True)
        assert hashlib.sha256(data).hexdigest() == change['sha256'], name
        assert change['beforeSha256'] == baseline.get(name), name
        reviewed[name] = data
    with zipfile.ZipFile(archive) as bundle:
        entries = {}
        for entry in bundle.infolist():
            assert entry.filename.startswith(patch['archivePrefix'])
            name = entry.filename[len(patch['archivePrefix']):]
            if not name or entry.is_dir():
                continue
            safe_relative(name)
            assert name not in entries and ((entry.external_attr >> 16) & 0o170000) != 0o120000
            entries[name] = entry
        assert set(entries) == set(baseline), 'Released source inventory differs'
        for name, entry in entries.items():
            with bundle.open(entry) as stream:
                assert hashlib.file_digest(stream, 'sha256').hexdigest() == baseline[name], name
        destination.mkdir(parents=True, exist_ok=True)
        for name, entry in entries.items():
            target = destination / name; target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as stream, target.open('wb') as output:
                shutil.copyfileobj(stream, output)
    for name, data in reviewed.items():
        target = destination / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
    expected = dict(baseline)
    expected.update({change['path']: change['sha256'] for change in patch['files']})
    actual = {path.relative_to(destination).as_posix(): sha(path) for path in destination.rglob('*') if path.is_file()}
    assert actual == expected, 'Applied source differs from the frozen overlay'
    print(json.dumps({'passed': True, 'baseline': 'R138', 'release': 'R139', 'baselineFiles': len(baseline), 'reviewedFiles': len(reviewed), 'sourceFiles': len(actual), 'allOtherBytesPreserved': True, 'installerBuilt': False, 'releasePublished': False}))


if __name__ == '__main__':
    main()
