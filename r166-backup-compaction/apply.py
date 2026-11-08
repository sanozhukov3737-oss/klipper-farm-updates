"""Apply the reviewed R166 backup-compaction source over the exact sequence-154 candidate.

Seven full copies of an 844 MB database occupy 5.7 GB on the live farm, and every copy
carried the same 38 MB of free pages as the working file, because the SQLite online
backup copies pages verbatim.

Two changes, both without touching the restore path:

* The copy is VACUUM'd before publication. The connection belongs to us and is open for
  write, so the published file contains no free pages. The restore path keeps reading a
  plain .sqlite3 file exactly as before.
* Seven copies become three. Each copy stays complete and self-contained, so restore
  never depends on a chain: a lost delta cannot destroy the history.

gzip was evaluated and deliberately left out of this overlay: restore opens the backup as
a database, so compression has to be paired with decompression in the restore and drill
paths. That is a change of its own, not a flag on this one.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 154}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-154 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-154 candidate before R166 backup compaction')

def canonical(data):
    return data.replace(b'\r\n', b'\n')

def digest(data):
    return hashlib.sha256(canonical(data)).hexdigest()

rows = []
for row in manifest['files']:
    path = PurePosixPath(row['path'])
    if path.is_absolute() or '..' in path.parts or '\\' in row['path']:
        raise SystemExit('Unsafe source path')
    target = root.joinpath(*path.parts)
    source = overlay.joinpath('changes', *path.parts)
    if not source.is_file() or digest(source.read_bytes()) != row['sha256']:
        raise SystemExit('Candidate source checksum differs: ' + row['path'])
    before = row.get('beforeSha256')
    if before is not None:
        current = digest(target.read_bytes()) if target.is_file() else None
        if current not in (before, row['sha256']):
            raise SystemExit('Existing source differs; refusing overwrite: ' + row['path'])
    rows.append((target, source))
for target, source in rows:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical(source.read_bytes()))
print('Applied reviewed R166 backup-compaction source over the exact sequence-154 candidate.')
