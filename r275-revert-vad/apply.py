"""Откат VAD из r273: шаг 12 CI падает с тех пор, как он появился.

Три прогона подряд (3724448, 6c6a804, 92cefdc) падают на шаге «Browser dialogue, filename learning and
profile isolation», и в этом шаге единственное, что изменилось между r272 и r273 — этот файл. Локальные
проверки VAD проходят, включая блоки по 128 сэмплов, пустые блоки и NaN, поэтому причина не воспроизводится
вне CI, а логов CI без токена нет.

Возвращаю файл к версии r272 и убираю check-voice-vad.mjs из цепочки. Улучшение по шуму мастерской
описано в сообщении r273 и остаётся в истории; вернуть его можно отдельным заходом, когда шаг 12 снова
зелёный и будет с чем сравнивать.
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
    'installedSequence': 175,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-175 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-175 candidate with R274 applied before R275')


def canonical(data):
    return data.replace(b'\r\n', b'\n')


def digest(data):
    return hashlib.sha256(canonical(data)).hexdigest()


def safe_path(declared):
    path = PurePosixPath(declared)
    if path.is_absolute() or '..' in path.parts or '\\' in declared:
        raise SystemExit('Unsafe source path: ' + declared)
    return path


writes = []
for row in manifest['files']:
    path = safe_path(row['path'])
    target = root.joinpath(*path.parts)
    source = overlay.joinpath('changes', *path.parts)
    if not source.is_file() or digest(source.read_bytes()) != row['sha256']:
        raise SystemExit('Candidate source checksum differs: ' + row['path'])
    before = row.get('beforeSha256')
    if before is not None:
        current = digest(target.read_bytes()) if target.is_file() else None
        if current not in (before, row['sha256']):
            raise SystemExit('Existing source differs; refusing to overwrite: ' + row['path'])
    writes.append((target, source))

removals = []
for row in manifest.get('deletions', []):
    path = safe_path(row['path'])
    target = root.joinpath(*path.parts)
    if not target.is_file():
        continue
    if digest(target.read_bytes()) != row['sha256']:
        raise SystemExit('Refusing to delete; existing content differs: ' + row['path'])
    removals.append(target)

for target, source in writes:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical(source.read_bytes()))
for target in removals:
    target.unlink()
print('Applied R275: VAD reverted, ' + str(len(writes)) + ' written, ' + str(len(removals)) + ' removed.')
