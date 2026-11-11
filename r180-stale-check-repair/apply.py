"""Apply the reviewed R180 stale-check repair over the exact sequence-159 candidate.

Two verification scripts had been red for a long time. Neither is part of the build gate, so
nothing noticed, and both were red for the same reason: they describe an older application
than the one that ships.

`check-ui-files.mjs` expected three details that no longer exist — a dark surface of #181b21
where the palette moved to #1a1d23, backgrounds of #f3f5f8 and #101216 where the palette has
#ffffff and #111318, and a detail shell attribute that is now declared together with a second
class. All three were already wrong in the R144 base archive, so the scripts drifted from the
stylesheet rather than the stylesheet drifting from them. The expectations now match the
shipped palette, and the class check looks for the class instead of the whole attribute, so
adding another class no longer breaks it.

`check-offline-first.mjs` looked for AbortController and an 8_000 ms timeout inside the
frontend Telegram module. The frontend no longer sends anything: telegramSend is a native
command, and the protection moved with it — curl runs with connect-timeout 5 and max-time 8
inside a spawn_blocking on the ActorIo class. The check now asserts both halves of what
actually protects the core path: the frontend must not reach the network on its own, and the
native layer must keep its timeouts and its off-path execution. That is stricter than before,
because the old check never verified that the frontend stays off the network.

Both scripts were already wired as npm scripts; they were simply never run. They stay wired,
and nothing is added to the CI gate by this overlay.
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
    'installedSequence': 159,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-159 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected the accepted sequence-159 candidate before R180 stale-check repair')


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
print('Applied reviewed R180 stale-check repair over the exact sequence-159 candidate.')
