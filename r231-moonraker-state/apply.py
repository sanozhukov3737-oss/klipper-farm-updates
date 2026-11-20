"""Apply the reviewed R231 Moonraker state extraction over the exact sequence-175 candidate.

I have promised to split moonraker.ts several times and never measured it properly. Doing that first
changed the answer.

The measurements I quoted before were wrong: I counted from one matching line to the next, and nested
arrow functions matched the same pattern, so nativeWsRpc appeared to be 651 lines. Counting braces
properly: 154 methods, median 5 lines, average 12, and the largest single method is pollOnceScheduled at
140. Total method bodies: 1912 of 2230 lines.

So the file is not a tangle of giant functions. It is one class holding 100 fields across about ten
responsibilities — protocol calls, transport, polling, the actor bridge, light, Spoolman, files, the print
queue. That is a different problem, and a different fix: splitting it means deciding who owns which state,
which is a behavioural change needing its own tests, not a code move.

What is genuinely safe is extracting the parts that do not read the class at all. Nine methods had zero
or near-zero state dependencies, so they became pure functions in moonrakerState: the two actor status
patches, the two telemetry predicates, the K1C transport decision, the transport label, the two
channel/transport conversions and the bounded request settler. Each takes values and returns values; none
touches the client, the network or storage, so each can be tested without either.

moonraker.ts is 2179 lines now, down from 2230, and four modules carry what used to be inside it:
moonrakerPayload (57), moonrakerState (114), moonrakerLightPayload (25), moonrakerSpoolman (32).

check-runtime-stability asserted the text of the authorization-failure comment in moonraker.ts. The
function moved, so the check would have guarded an empty line while reporting success. It now reads
moonrakerState and asserts the invariant — a 401/403 pattern and a negated result — rather than a
sentence that can be reworded.

This is a refactor with no user-visible change, so it does not get its own release: it joins the overlay
chain after R230 and rides with the next build that carries a real change.
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
    raise SystemExit('Expected the accepted sequence-175 candidate before R231 state extraction')


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
print('Applied reviewed R231 Moonraker state extraction over the exact sequence-175 candidate.')
