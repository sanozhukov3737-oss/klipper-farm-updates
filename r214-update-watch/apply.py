"""Apply the reviewed R214 update watcher over the exact sequence-167 candidate.

The updater worked, but only ever when asked: the channel was contacted from one place in the whole
program — the click handler of a button at the bottom of Settings → runtime. There is no timer, no
startup check and no background poll. A farm could therefore run a year-old build and never learn
that a fix exists; the local status call it does show at that moment only reads the sequence inside
the installed build and says nothing about the channel.

Checking where the updater lives explains it: AppUpdater is mounted inside SystemPanel, which is a
deferred panel rendered only once Settings is opened, so a check placed at its mount point would run
exactly when the operator is already looking at the button — automatic in name only. The watcher is
therefore mounted next to NotificationToastHost in FarmApp, where it lives for the whole session.

What it costs: update_check fetches the manifest and nothing else, hard-capped at 64 KB against a
4.7 KB file. The installer is downloaded by a different command, on a different click. A daily check
is therefore a rounding error, which is why the interval is a day rather than a week.

It is quiet by design. No network, no rights, a broken channel — all of it is silence: a farm can run
without internet, and a warning at every start about that would be noise, not information. Rights
matter here because update_check requires Admin, so the host is only mounted for an admin.

The first check waits twenty seconds instead of starting at once. The updater holds a single busy
flag, and a manual click that lands while the automatic check is running would fail with «операция
уже выполняется» — a false alarm caused by us. Twenty seconds is longer than anyone needs to reach
that button, and the rule is checked against the installed sequence too, so a check runs immediately
after an update instead of waiting out the day.

Nothing is installed without a click. The button is unchanged.

A check covers the rules: first run and the daily interval, an immediate re-check when the installed
sequence changes, silence for an already announced sequence, silence for anything not newer than the
installed one, and no links in the journal entry. It fails on the unpatched tree.
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
    'installedSequence': 167,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-167 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-167 candidate before R214 update watcher')


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
print('Applied reviewed R214 update watcher over the exact sequence-167 candidate.')
