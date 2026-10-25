#!/usr/bin/env python3
"""Apply the reviewed R138 visual patch to an exact published R137 archive."""
import base64
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def safe_relative(name):
    path = PurePosixPath(name)
    assert name and not path.is_absolute() and '..' not in path.parts
    assert '\\' not in name and ':' not in name
    assert all(part not in ('', '.', '..') for part in name.split('/'))
    return path


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python apply-r138.py KF-R137-FULL.zip NEW_DIRECTORY')
    archive, destination = map(Path, sys.argv[1:])
    patch = json.loads((ROOT / 'r138-live-ui-patch.json').read_text(encoding='utf-8'))
    assert patch['baseline'] == 'R137' and patch['release'] == 'R138'
    assert archive.stat().st_size == patch['baseArchiveSize'] and sha(archive) == patch['baseArchiveSha256']
    assert not destination.exists() or not any(destination.iterdir()), 'Destination must be new or empty'
    baseline = patch['baselineFiles']
    reviewed = {}
    for change in patch['files']:
        name = change['path']; safe_relative(name)
        assert name not in reviewed and name.startswith(('src/', 'scripts/', 'ui-tests/'))
        data = base64.b64decode(change['contentBase64'], validate=True)
        assert hashlib.sha256(data).hexdigest() == change['sha256'], name
        assert change['beforeSha256'] == baseline.get(name), name
        reviewed[name] = data
    with zipfile.ZipFile(archive) as bundle:
        entries = {}
        for entry in bundle.infolist():
            assert entry.filename.startswith(patch['archivePrefix'])
            name = entry.filename[len(patch['archivePrefix']):]
            if not name or entry.is_dir(): continue
            safe_relative(name)
            assert name not in entries and ((entry.external_attr >> 16) & 0o170000) != 0o120000
            entries[name] = entry
        assert set(entries) == set(baseline), 'Published source inventory differs'
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
    actual = {str(path.relative_to(destination)).replace('\\', '/'): sha(path) for path in destination.rglob('*') if path.is_file()}
    assert actual == expected, 'Applied source differs from the reviewed patch'
    print(json.dumps({'passed': True, 'baseline': 'R137', 'release': 'R138', 'baselineFiles': len(baseline), 'reviewedFiles': len(reviewed), 'sourceFiles': len(actual), 'allOtherBytesPreserved': True, 'installerBuilt': False, 'releasePublished': False}))


if __name__ == '__main__':
    main()
