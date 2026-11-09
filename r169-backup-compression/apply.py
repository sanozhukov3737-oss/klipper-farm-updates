"""Apply the reviewed R169 backup-compression source over the exact sequence-155 candidate.

R166 already removed the free pages from a copy and cut the retention to three, so backups
went from 5.7 GB to roughly 2.4 GB. The remaining cost is raw size: the database holds a
lot of repetitive text, and gzip shrinks it about 7.5 times.

R166 deliberately left compression out, because restore opens a backup as a database. This
overlay adds both halves at once:

* a backup is compressed to `.sqlite3.gz` before publication, through a `.gz.partial`
  file so a half-written archive can never be mistaken for a usable copy;
* the restore drill decompresses a compressed backup into its scratch file before opening
  it. Uncompressed `.sqlite3` files from earlier versions keep working unchanged, so old
  backups stay restorable;
* schedule inspection recognises the gzip magic instead of the SQLite header, otherwise a
  fresh compressed copy would not count as completed and every call would make another one;
* name reuse now checks the compressed name too. Without that, a second backup with the
  same timestamp overwrote the first, because only the `.sqlite3` name was reserved;
* `flate2` becomes a direct dependency. It was already in `Cargo.lock` as a transitive
  entry, so the lock changes by exactly one line and `--locked` builds stay valid.

Measured on the live farm database: 865 MB live, 799 MB after VACUUM INTO, 106 MB after
gzip, compression 7.5x, free pages 54 MB before VACUUM and 0 after. The decompressed copy
passes quick_check, exposes all 27 tables and all 27011 audit rows.

Three copies now cost about 320 MB instead of 5.7 GB.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 155}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-155 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-155 candidate before R169 backup compression')

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
print('Applied reviewed R169 backup-compression source over the exact sequence-155 candidate.')
