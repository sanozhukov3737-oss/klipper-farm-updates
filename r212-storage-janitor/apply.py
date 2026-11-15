"""Apply the reviewed R212 storage janitor over the exact sequence-166 candidate.

Two problems found while checking the camera pause path on the real farm.

The first is the pause itself: it works, the chain from detector to guarded pause to confirmation is
whole, but the mode on this installation is «notify», so it only ever notifies. Setting «Автопауза»
in the camera guard panel is what turns it on — no code needed.

The second is real: nothing in the application ever removes the local traces of a deleted printer. On
this farm there are seven printers in the configuration and seventeen file caches, so ten belong to
printers that no longer exist, plus a camera-guard entry and a page-state entry hanging off the same
dead printer. They are read on every open of the files panel and never used.

There were no means to fix that: the database bridge could read and write a named key, but had no way
to list keys or delete one, so an orphan could neither be found nor removed. Two commands are added.
`db_list_keys` takes a mandatory prefix and asks for Viewer, so a caller picks a namespace instead of
enumerating the store, and the prefix goes through the existing key validator. `db_delete_json` asks
for Admin and for the same write policy as `db_set_json`, so it cannot delete a user record or the
audit log. The obvious shortcut — dumping the whole store through `db_backup_json`, which does list
keys — is rejected: it is Admin-only and would pull every secret into the frontend to delete a cache.

The cleanup runs once per launch rather than when a printer is deleted, because a printer can be
deleted elsewhere and a configuration can come back from a backup, and both would strand caches
again. It refuses to act on an empty printer list: an empty list is a failed read, not a farm with no
printers, and treating it as the latter would wipe every cache on one bad start. It reports what it
removed to the journal instead of disappearing silently, and it re-reads the camera settings right
before writing, so a concurrent edit by the running guard wins over the cleanup.

Alongside, the TV dashboard no longer lets a camera stay broken until restart. A failure used to be
recorded permanently: the reset existed but was never called from anywhere, and a printer marked as
failed stayed blank forever. The camera now retries after 5, 10, 20 and then every 30 seconds, resets
on return of the connection and on a new job, and is no longer hidden while Moonraker reports a
degraded connection — the camera has its own port and does not go through Moonraker at all.

A structural check covers the janitor: orphans found, live printers and foreign keys untouched, an
empty configuration deletes nothing, a failing key does not stop the others, and an unavailable store
is never reported as a successful cleanup. It fails on the unpatched tree.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {
    'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json',
    'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb',
    'channel': 'stable',
    'installedSequence': 166,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-166 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-166 candidate before R212 storage janitor')


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
            raise SystemExit('Existing source differs; refusing to overwrite: ' + row['path'])
    rows.append((target, source))
for target, source in rows:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical(source.read_bytes()))
print('Applied reviewed R212 storage janitor over the exact sequence-166 candidate.')
