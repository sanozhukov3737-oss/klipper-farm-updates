"""Apply the reviewed R222 boot splash check over the exact sequence-171 candidate with R221 applied.

The check added in R216 asked which file to believe and chose wrong. It read dist/index.html when it
existed and the source index.html otherwise, on the reasoning that dist is produced by a build and may
be absent at the regression step.

In the build it is not absent. work/app is unpacked from the published KF-R144-FULL.zip, which carries
a dist directory from that release — a dist that predates the splash entirely. So the check read a
year-old build, found no splash in it, and failed on a tree whose index.html has had the splash inline
since R211. The fix I wrote passed locally because my local dist was freshly built, which is the same
mistake as trusting a stale artifact: I verified the state I had, not the state the step runs in.

The splash is authored in index.html, before any build, precisely because the stylesheet loads later
and would leave a white screen. So the markup, the inline styles, the position relative to #root and
the fallback message are asserted against the source, always. The compiled bundle is used only for the
one thing it can prove — that the splash is removed when React actually renders rather than on a timer
— and that assertion is skipped with a printed reason when no built bundle is present.
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
    'installedSequence': 171,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-170 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-171 candidate with R221 applied before R222')


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
print('Applied reviewed R222 boot splash check over the exact sequence-171 candidate with R221 applied.')
