"""Apply the reviewed R218 hardening over the exact sequence-169 candidate.

Six problems the audit left open. The first is the one an operator would notice.

Update notifications were admin-only, because update_check requires Admin: it prepares an install, so
that is correct. But that check was also the only thing that fetched the channel, so a farm run by an
operator without admin rights never learned that a release existed. A new command, update_available,
answers only "is there a newer sequence" and asks for Viewer. It returns the version and sequence and
nothing else — no manifest hash, no size, no release body — so it cannot be used to prepare anything.
update_status drops from Admin to Viewer for the same reason: it reads the version out of the packaged
channel and opens neither download nor install, and without it a non-admin check has nothing to compare
against. update_check keeps Admin, and the check asserts exactly that.

Lint did not exist. Twenty thousand lines were checked by tsc alone, which says nothing about a lost
await, an unused variable or `==`. ESLint with typescript-eslint now runs over src and scripts. The
rules are about defects rather than taste: no floating promises, no unused variables, prefer-const,
eqeqeq. Style rules are deliberately absent — a thousand complaints about quotes would bury the real
ones. Floating promises start as warnings because the existing code has twenty seven of them, and
changing all twenty seven at once, without a behavioural test for each, is riskier than keeping them
visible; new code is held to the stricter default. Running it found two real defects: openFlashFor
declared an abort signal that an inner parameter shadowed, so cancellation never reached it, and the
spool viewer carried a dead tube function that nothing called.

Coverage was thirty percent: the build ran 39 of 134 structural checks, so 94 guarded nothing. Another
43 that pass in a source tree with no build artifacts now run too — eighty three in total. That is what
would have caught the overlay which sat in the repository for a day without reaching a build.

Silent catch blocks. Most of the 28 are best-effort interface work where silence is right, but three
were not. A failed journal write lost an audit record without a trace; it now reports to the console,
the only channel available because the diagnostics logger can itself write to the journal. The other
two are localStorage hints, where failure is acceptable and is now stated in a comment instead of an
empty block that reads like an oversight.

Ninety eight workflows were still active, one per review stage from R99 onwards. Two remain: the build
and the runtime publication. The rest are disabled rather than deleted, with their identifiers recorded
so they can be turned back on.

Two high-severity advisories sat in the build toolchain: vite and its source-map-js. vite moves to 6.4.6
and the tree rebuilds, typechecks, lints and passes every runnable check. Two moderate advisories remain,
both without an upstream fix: uuid through a build dependency, and vosk-browser, a development
dependency only.
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
    'installedSequence': 169,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-169 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-169 candidate before R218 hardening')


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
print('Applied reviewed R218 hardening over the exact sequence-169 candidate.')
