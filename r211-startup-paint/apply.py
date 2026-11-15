"""Apply the reviewed R211 startup paint over the exact sequence-166 candidate.

The window appears about 2.2 seconds after the process starts — measured across six launches in
desktop-startup.log. That time goes into reading a 278 MB executable and starting WebView2, and no
change here shortens it.

What it fixes is what the operator sees during those two seconds: a blank white page. index.html
was 247 bytes with an empty #root, so until React mounted there was nothing on screen at all, which
reads as a freeze rather than a wait.

The splash is inline in index.html rather than a component: the stylesheet is a separate bundle that
loads later, and any external reference would leave the white page in place. It is a sibling of
#root, not a child, because React renders into #root and would erase nested markup on its first
commit. main.tsx removes it when #root actually receives its first node — not on a timer, since
render() in React 18 returns before painting and a fixed delay could uncover an empty screen. If the
bundle never loads, the splash says so after fifteen seconds instead of sitting silent.

App.tsx read the printer configuration twice at mount, both reads on the first frame. One read now
serves both values.

The submission of a 278 MB executable is deliberately untouched: the size comes from the bundled
speech components, and removing them would break offline installation.

A structural check covers the built result: splash present and inline, positioned as a sibling,
removed by MutationObserver, with the fallback message. It fails on the unpatched tree.
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
    raise SystemExit('Expected the accepted sequence-166 candidate before R211 startup paint')


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
print('Applied reviewed R211 startup paint over the exact sequence-166 candidate.')
