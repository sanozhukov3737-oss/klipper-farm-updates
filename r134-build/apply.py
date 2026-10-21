#!/usr/bin/env python3
"""Apply the reviewed print-transfer integration after validating every payload and base file."""
import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_root', type=Path)
    parser.add_argument('patch', type=Path, nargs='?', default=Path(__file__).with_name('approved-filament-patch.json'))
    args = parser.parse_args()
    root = args.source_root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError('Source root must be a directory')
    patch = json.loads(args.patch.read_text(encoding='utf-8'))
    if patch.get('schemaVersion') != 1 or not isinstance(patch.get('files'), list) or not patch['files']:
        raise ValueError('Unsupported or empty patch')
    prepared, seen = [], set()
    for entry in patch['files']:
        name = entry['path']
        if not isinstance(name, str) or not name or '\\' in name or ':' in name or '\0' in name:
            raise ValueError('Invalid patch path')
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or str(path) != name or name.casefold() in seen:
            raise ValueError('Unsafe or duplicate patch path: ' + name)
        seen.add(name.casefold())
        target = (root / name).resolve()
        if target == root or not target.is_relative_to(root):
            raise ValueError('Patch path escapes source: ' + name)
        if target.exists() and not target.is_file():
            raise ValueError('Patch target is not a file: ' + name)
        before = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
        if before != entry['beforeSha256']:
            raise ValueError('Base file differs: ' + name)
        data = base64.b64decode(entry['contentBase64'], validate=True)
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('Patch payload differs: ' + name)
        prepared.append((target, data))
    # Validate all paths, inputs and hashes before the first filesystem write.
    for target, data in prepared:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    print(f'Applied and hash-verified {len(prepared)} reviewed print-transfer source files.')


if __name__ == '__main__':
    main()
