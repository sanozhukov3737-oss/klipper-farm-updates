"""Check complete R133 source parity after the combined R134 patch."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

root, patch_file, baseline, output = map(Path, sys.argv[1:])
patch = json.loads(patch_file.read_text(encoding='utf-8'))
sha = lambda data: hashlib.sha256(data).hexdigest()
assert sha(baseline.read_bytes()) == patch['baseArchiveSha256'], 'Published R133 archive differs'
modified = {row['path']: row for row in patch['files']}
for name, row in modified.items():
    assert sha((root / name).read_bytes()) == row['sha256'], 'Patched source differs: ' + name
count = 0
with zipfile.ZipFile(baseline) as archive:
    for item in archive.infolist():
        if item.is_dir():
            continue
        assert item.filename.startswith('Klipper-Farm-R133/')
        name = item.filename.removeprefix('Klipper-Farm-R133/')
        if name not in modified:
            assert (root / name).read_bytes() == archive.read(item), 'Unreviewed source differs: ' + name
            count += 1
report = {
    'release': 'R134', 'baseline': 'R133', 'passed': True,
    'baseArchiveSha256': patch['baseArchiveSha256'],
    'patchSha256': sha(patch_file.read_bytes()),
    'allUnreviewedSourceBytesPreserved': True, 'unchangedFiles': count,
    'modifiedFiles': [{k: v for k, v in row.items() if k != 'contentBase64'} for row in patch['files']],
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'R134 source verified: {len(modified)} reviewed files, {count} unchanged R133 files.')
