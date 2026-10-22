"""Restore the reviewed R135 working source from the exact published R134 ZIP.

Usage: python apply-r135.py KF-R134-FULL.zip NEW_DIRECTORY
       python apply-r135.py --verify EXISTING_SOURCE_DIRECTORY
Does not build, install, publish, or modify the update channel.
"""
from pathlib import Path, PurePosixPath
import base64
import hashlib
import json
import sys
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


here = Path(__file__).resolve().parent
payload = (here / 'r135-combined-patch.json').read_bytes()
expected_patch = (here / 'r135-combined-patch.sha256').read_text().split()[0]
assert digest(payload) == expected_patch, 'Patch checksum mismatch'
patch = json.loads(payload)
expected = dict(patch['baselineFiles'])
seen = set()
for row in patch['files']:
    name = row['path']
    q = PurePosixPath(name)
    assert name not in seen and not q.is_absolute() and '..' not in q.parts and '\\' not in name
    seen.add(name)
    assert row['beforeSha256'] == expected.get(name), name
    assert digest(base64.b64decode(row['contentBase64'], validate=True)) == row['sha256'], name
    expected[name] = row['sha256']

if len(sys.argv) == 3 and sys.argv[1] == '--verify':
    app = Path(sys.argv[2]).resolve()
elif len(sys.argv) == 3:
    archive, app = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
    assert not app.exists(), 'Destination must not exist'
    assert archive.stat().st_size == patch['baseArchiveSize']
    with archive.open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == patch['baseArchiveSha256']
    with zipfile.ZipFile(archive) as z:
        members = {}
        for info in z.infolist():
            q = PurePosixPath(info.filename)
            assert not q.is_absolute() and '..' not in q.parts and '\\' not in info.filename
            assert info.filename.startswith(patch['archivePrefix'])
            assert (info.external_attr >> 16) & 0o170000 != 0o120000, 'Symlink rejected'
            if info.is_dir():
                continue
            name = info.filename[len(patch['archivePrefix']):]
            assert name not in members
            members[name] = info
        assert set(members) == set(patch['baselineFiles']), 'Archive file inventory mismatch'
        # Validate every source byte before creating a destination.
        for name, info in members.items():
            assert digest(z.read(info)) == patch['baselineFiles'][name], name
        app.mkdir(parents=True)
        for name, info in members.items():
            p = app / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(z.read(info))
    for row in patch['files']:
        p = app / row['path']
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(base64.b64decode(row['contentBase64'], validate=True))
else:
    raise SystemExit(__doc__)

for name, sha in expected.items():
    assert digest((app / name).read_bytes()) == sha, name
print(json.dumps({'passed': True, 'source': str(app), 'patchSha256': expected_patch,
                  'verifiedFiles': len(expected), 'reviewedFiles': len(patch['files']),
                  'installerBuilt': False, 'releasePublished': False}, indent=2))
