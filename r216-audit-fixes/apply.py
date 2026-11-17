"""Apply the reviewed R216 audit fixes over the exact sequence-168 candidate.

A full audit of the program ran all 134 structural checks rather than the 39 the build uses. Twenty
eight failed. Fourteen were stale string matches that had outlived the code they describe, four
encoded a wrong assumption, and the rest needed a build artifact that a static tree cannot have. Two
real defects came out of it: a backup publication path that lost its Windows retry bound, and an icon
setting that was written and never displayed.

The backup fix matters most. Compressing backups moved publication onto plain `std::fs::rename`,
which on Windows fails outright when a scanner briefly holds the file. The uncompressed path had used
`durable_fs::rename_atomic`, which retries through `MoveFileExW` up to seven times precisely for that
case. Compressed backups had silently lost that protection, and a backup is not something to lose to
an antivirus. Publication now goes through the same retry-bounded helper.

The `icon` field turned out to be a setting that was never finished rather than dead weight, and the
first instinct to delete it was wrong. It is written on every catalogue selection and read nowhere,
because display goes through `printerArtwork` — uploaded image, then the catalogue photo, then the
preset — and the photos cover all five hundred models. But the six-value silhouette mapping (k1,
k1max, ender, corexy, bedslinger, custom) exists, `ModelIcon` renders it, and nothing ever displayed
it. So choosing a model now sets the icon, and the printer card falls back to that model's silhouette
when the bundled photo fails to load: a damaged build or a full disk currently leaves a generic
placeholder where the model is known. The silhouette also gained the sizing it never had, which is
why it could never have been visible.

The checks themselves were the larger problem, and the failures said something uncomfortable: five of
them broke because the code got better. `check-v20-core` forbade `std::net::TcpStream` in the actor
and found the test module's mock socket — it now reads production code only, and still looks at the
full source where the test itself is the point. `check-v20-6-discovery-display` required the exact
call `applyStatus(...,snapshot)` and the call had gained a fourth argument, `controllerLive`, which
stops a cached snapshot from presenting itself as a live controller. `check-camera-guard` required the
pause call without the applicability guard that now runs before the command is sent.

The wrong assumptions were worse than the stale strings, because they would have failed just as
happily on correct code. `check-farm-upgrades` demanded that the notification write allowlist equal
the read filter; they differ on purpose, since plastic usage is written by the atomic inventory
command and must still be readable. It is a subset relationship, and that is what it now asserts.
`check-v20-core` also compared `dist` against a captured bundle lock, which is only meaningful right
after a build and a lock refresh — it now asks for that explicitly instead of failing on any tree.

Two checks describe a built release, not a source tree, and now say so. `check-release-portability`
compares the checksum manifests, which list `dist/**` and components that source archives do not
contain; `check-boot-splash` reads the built `index.html`, which does not exist before a build and is
produced after the regression step in the pipeline. Both verify everything else in any tree, and the
manifest comparison runs when the tree really is a release tree. The boot splash falls back to the
source, where the markup is inline, and skips only the assertion that needs the compiled bundle.

`check-release-published` now finds the component manifest by default and, when it is absent, reports
that runtime verification was skipped instead of demanding a command line argument. Sixteen checks
required environment a reviewer does not have — playwright, prepared speech assets, baseline
snapshots, vendored crates, built binaries — and those are left failing rather than pretending
otherwise; a skip that looks like a pass is worse than an honest failure.
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
    'installedSequence': 168,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-168 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-168 candidate before R216 audit fixes')


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
print('Applied reviewed R216 audit fixes over the exact sequence-168 candidate.')
