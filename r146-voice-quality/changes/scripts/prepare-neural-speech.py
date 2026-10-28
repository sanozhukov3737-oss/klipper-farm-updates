"""Prepare pinned Windows speech tools at build time; the installed app never downloads models."""
import argparse
import hashlib
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--cache', type=Path, default=root / '.speech-downloads')
parser.add_argument('--offline', action='store_true')
args = parser.parse_args()
args.cache.mkdir(parents=True, exist_ok=True)
destination = root / 'src-tauri' / 'speech'
pins = json.loads((root / 'scripts' / 'neural-speech-assets.json').read_text())


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


for item in pins:
    archive = args.cache / item['name']
    if not archive.is_file() or digest(archive) != item['sha256']:
        if args.offline:
            raise SystemExit(f"Missing verified speech asset: {item['name']}")
        pending = archive.with_suffix(archive.suffix + '.part')
        with urllib.request.urlopen(item['url'], timeout=120) as response, pending.open('wb') as output:
            shutil.copyfileobj(response, output)
        if pending.stat().st_size != item['bytes'] or digest(pending) != item['sha256']:
            pending.unlink(missing_ok=True)
            raise SystemExit(f"Speech asset hash differs: {item['name']}")
        pending.replace(archive)
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as container:
            for entry in container.infolist():
                path = PurePosixPath(entry.filename)
                if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise SystemExit('Unsafe speech archive entry')
                if entry.is_dir():
                    continue
                if item['name'] == 'whisper-win.zip':
                    if path.name != 'whisper-cli.exe' and path.suffix.lower() != '.dll':
                        continue
                    target = destination / 'whisper' / path.name
                else:
                    if path.parts[0] != 'piper':
                        raise SystemExit('Unexpected Piper archive root')
                    target = destination.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with container.open(entry) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
    else:
        group = 'whisper' if item['name'].endswith('.bin') else 'piper'
        target = destination / group / item['name']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(archive, target)

notice = root / 'scripts' / 'NEURAL-SPEECH-NOTICES.txt'
shutil.copyfile(notice, destination / notice.name)
manifest = [{'path': str(path.relative_to(destination)).replace('\\', '/'), 'bytes': path.stat().st_size, 'sha256': digest(path)}
            for path in sorted(destination.rglob('*')) if path.is_file() and path.name != 'manifest.json']
(destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Prepared {len(manifest)} verified offline speech files')
