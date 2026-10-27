#!/usr/bin/env python3
"""Apply the reviewed palette to the exact published R141 source archive."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import zipfile

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    patch = json.loads((Path(__file__).parent / 'r142-graphite-patch.json').read_text(encoding='utf-8'))
    digest = hashlib.sha256()
    with args.archive.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if args.archive.stat().st_size != patch['baseArchiveSize'] or digest.hexdigest() != patch['baseArchiveSha256']:
        raise SystemExit('Expected the exact published KF-R141-FULL.zip')
    if args.destination.exists() and any(args.destination.iterdir()):
        raise SystemExit('Destination must be new or empty')
    prefix = patch['archivePrefix']
    with zipfile.ZipFile(args.archive) as archive:
        entries = [(item, item.filename[len(prefix):]) for item in archive.infolist() if not item.is_dir()]
        for item, name in entries:
            if not item.filename.startswith(prefix) or not name or Path(name).is_absolute() or '..' in Path(name).parts or '\\' in name:
                raise SystemExit('Unsafe archive member')
        args.destination.mkdir(parents=True, exist_ok=True)
        for item, name in entries:
            destination = args.destination / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(item))
    for name, expected in patch['baselineFiles'].items():
        if sha((args.destination / name).read_bytes()) != expected:
            raise SystemExit('Baseline mismatch: ' + name)
    for row in patch['files']:
        destination = args.destination / row['path']
        if sha(destination.read_bytes()) != row['beforeSha256']:
            raise SystemExit('Source mismatch: ' + row['path'])
        data = base64.b64decode(row['contentBase64'], validate=True)
        if sha(data) != row['sha256']:
            raise SystemExit('Patch digest mismatch: ' + row['path'])
        destination.write_bytes(data)
    print('Applied the reviewed palette and its existing visual check. Rebuild the frontend before packaging; this is not a Windows installer.')

if __name__ == '__main__':
    main()
