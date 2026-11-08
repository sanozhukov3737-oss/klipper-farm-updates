"""Apply the reviewed R161 update-progress source over the exact sequence-153 candidate.

Pressing "Установить" closes the application and then everything goes quiet. The helper
verifies up to 13766 offline component files and that check legitimately takes 10-15
minutes on the first update after a component change. With no window, the operator sees
only a vanished program and assumes it failed — reported as "нажал, программа закрылась
и всё".

The helper now shows a small WinForms window from the moment the installer starts until
it exits: what is happening, a marquee bar and elapsed minutes. WinForms with DoEvents
is deliberate — the helper runs in a hidden PowerShell process without a dispatcher, and
this loop reliably repaints while the installer works in the background. The window is
closed in finally, so a failed install still reaches the existing error dialog.

The file also gains a UTF-8 BOM: PowerShell 5.1 reads extension scripts as ANSI without
it, and the Russian messages would otherwise be mojibake and a parse error.
"""

from pathlib import Path, PurePosixPath
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
overlay = Path(__file__).resolve().parent
manifest = json.loads((overlay / 'source-manifest.json').read_text(encoding='utf-8'))
channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))
expected_channel = {'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json', 'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb', 'channel': 'stable', 'installedSequence': 153}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-153 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected exact accepted sequence-153 candidate before R159 installer diagnostics')

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
print('Applied reviewed R161 update-progress source over the exact sequence-153 candidate.')
