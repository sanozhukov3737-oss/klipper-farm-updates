"""Prepare pinned Windows speech tools at build time; the installed app never downloads models."""
import argparse
import errno
import hashlib
import json
import shutil
import time
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


def safe_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or any(':' in part for part in path.parts):
        raise SystemExit('Unsafe speech archive entry')
    return path


# Verify every input before replacing build-owned runtime files.
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
    if archive.stat().st_size != item['bytes']:
        raise SystemExit(f"Speech asset size differs: {item['name']}")

for stale in ['piper', 'silero']:
    # Some build filesystems expose delayed directory removals for large wheels.
    for attempt in range(4):
        try:
            if (destination / stale).exists():
                shutil.rmtree(destination / stale)
            break
        except OSError as error:
            if error.errno != errno.ENOTEMPTY or attempt == 3:
                raise
            time.sleep(0.05)

for item in pins:
    archive = args.cache / item['name']
    kind = item['kind']
    if kind in ['whisper-tools', 'python-embed', 'wheel']:
        with zipfile.ZipFile(archive) as container:
            for entry in container.infolist():
                path = safe_path(entry.filename)
                if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise SystemExit('Unsafe speech archive entry')
                if entry.is_dir():
                    continue
                if kind == 'whisper-tools':
                    if path.name != 'whisper-cli.exe' and path.suffix.lower() != '.dll':
                        continue
                    target = destination / 'whisper' / path.name
                elif kind == 'python-embed':
                    target = destination.joinpath('silero', 'python', *path.parts)
                else:
                    parts = path.parts
                    if parts[0].endswith('.data'):
                        if len(parts) < 3 or parts[1] not in ['purelib', 'platlib']:
                            continue
                        parts = parts[2:]
                    target = destination.joinpath('silero', 'python', 'Lib', 'site-packages', *parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with container.open(entry) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
    elif kind == 'file':
        target = destination.joinpath(*safe_path(item['target']).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(archive, target)
    else:
        raise SystemExit(f'Unknown speech asset kind: {kind}')

# Embeddable Python loads only this app's standard library and verified wheels.
# No system Python, user site-packages, pip, or package downloads at runtime.
(destination / 'silero/python/python312._pth').write_bytes(b'python312.zip\n.\nLib/site-packages\n')
# The upstream embeddable LICENSE mixes CRLF and LF; retain its full text with
# LF endings so the existing release portability contract remains unchanged.
python_license = destination / 'silero/python/LICENSE.txt'
python_license.write_bytes(python_license.read_bytes().replace(b'\r\n', b'\n'))
shutil.copyfile(root / 'scripts/silero-synthesize.py', destination / 'silero/tts.py')

# Keep Unicode off the Windows ANSI command line. Whisper reads these bytes as UTF-8.
# LF is deliberate: its response-file parser reads one argument per line.
recognition_args = [
    '-m', 'ggml-small-q5_1.bin', '-f', '-', '-of', 'transcript-memory-only',
    '-l', 'ru', '-t', '4', '-np', '-nt', '-ng', '--prompt',
    'Принтер K1 Max, K1C, Ender KE, Flashforge 5M. Найди файл, поставь на печать, корпус, кронштейн, остаток пластика.',
]
(destination / 'whisper' / 'recognition.args').write_bytes(('\n'.join(recognition_args) + '\n').encode('utf-8'))

notice = root / 'scripts' / 'NEURAL-SPEECH-NOTICES.txt'
shutil.copyfile(notice, destination / notice.name)
manifest = [{'path': str(path.relative_to(destination)).replace('\\', '/'), 'bytes': path.stat().st_size, 'sha256': digest(path)}
            for path in sorted(destination.rglob('*')) if path.is_file() and path.name != 'manifest.json']
(destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Prepared {len(manifest)} verified offline speech files')
