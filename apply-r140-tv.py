#!/usr/bin/env python3
"""Apply the reviewed TV-only draft to an extracted Klipper Farm R139 tree.

Usage: python apply-r140-tv.py PATH_TO_R139_SOURCE
This does not build an installer, change version metadata or publish updates.
"""
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

PATCH_SHA = 'a1a065ff465c49dfedab87778724381df55670e523801b3822a0784de8fb4a8d'
PATHS = {'src/components/TvDashboard.tsx', 'src/components/TvDashboard.css',
         'src/lib/tvSpotlight.ts', 'scripts/check-tv-spotlight.mjs',
         'ui-tests/tv-camera.mjs', 'ui-tests/tv-spotlight-r140.html',
         'ui-tests/tv-spotlight-r140.mjs', 'ui-tests/tv-spotlight-r140.tsx'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    root = Path(sys.argv[1]).resolve(strict=True)
    assert root.is_dir()
    assert (root / 'RELEASE-BUILD-ID.txt').read_text().strip() == 'V20.6-R13.9-FAN-ADDRESS-2026-10-25', 'Expected R139 source'
    assert json.loads((root / 'UPDATE-CHANNEL.json').read_text())['installedSequence'] == 139, 'Expected installed sequence 139'
    raw = Path(__file__).with_name('r140-tv-feature-patch.json').read_bytes()
    assert digest(raw) == PATCH_SHA, 'Reviewed TV patch differs'
    patch = json.loads(raw)
    assert patch['baseline'] == 'R139' and not patch['releasePublished']
    assert len(patch['files']) == 8 and {row['path'] for row in patch['files']} == PATHS
    prepared = []
    for row in patch['files']:
        target = root / row['path']
        target.resolve().relative_to(root)
        assert not target.is_symlink(), row['path']
        data = base64.b64decode(row['contentBase64'], validate=True)
        assert digest(data) == row['sha256'], row['path']
        if target.exists():
            assert target.is_file(), row['path']
            current = digest(target.read_bytes())
            if current == row['sha256']:
                continue
            assert row['beforeSha256'] and current == row['beforeSha256'], 'Source differs: ' + row['path']
        else:
            assert row['beforeSha256'] is None, 'Missing R139 file: ' + row['path']
        prepared.append((target, data))
    # Preflight every before-hash before changing any source file.
    for target, data in prepared:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.r140-tv-partial')
        assert not temporary.exists(), str(temporary)
        with temporary.open('xb') as stream:
            stream.write(data)
        os.replace(temporary, target)
    print(json.dumps({'passed': True, 'appliedFiles': len(prepared),
                      'scope': 'TV presentation and acceptance tests only',
                      'installerBuilt': False, 'releasePublished': False}))


if __name__ == '__main__':
    main()
