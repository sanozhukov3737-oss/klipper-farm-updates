"""Apply the reviewed R223 protocol typing over the exact sequence-171 candidate.

The forty two any in the frontend were left as debt in R220 with the reason stated: replacing them does
not stay local, and the first attempt broke on possibly-undefined payloads. This finishes it properly.

What the debt actually was. Twenty seven of them sat in moonraker.ts, and the shape was not "the code
reads fields off a possibly-undefined value" — every RPC result already went through moonrakerRecord or
moonrakerStatus. The any was in the type signatures: optional params, catch bindings, the settled-result
arrays and the status records. Those become unknown, and one documented alias — JsonRecord in
moonrakerPayload — remains the single any in the project, at the boundary where JSON arrives and its
shape is only known after a check.

Two real defects came out of it, both invisible while any stood in the way.

print start declared `Promise<void>` while returning the Moonraker response; the dependency that calls
it was typed the same way. any absorbed the contradiction. It now declares the response it actually
returns, which is what a caller needs if it ever wants to inspect the reply.

spoolmanSpools read `r?.error.message` on the raw response. A string error produced "Spoolman error" with
no cause; an error object without a message threw. Writing the test for it then exposed a second
problem with my own fix: moonrakerRecord unwraps nesting and returns the deepest record, so error and
response — which live on different levels — were being read from the same one. payloadRecords, which
walks every level, is now exported for that, and both call sites use it.

The remaining any have reasons, written next to them: BarcodeDetector is absent from the TypeScript
library, ComponentType<any> is what React.lazy requires for components with different props, and
JsonRecord is the JSON boundary itself. Each carries an eslint-disable with the reason on the spot
rather than a bare any.

Both rules that were warnings are now errors, and the npm lint script fails on any warning. The build
would not pass with a lost await or a new any.

Two structural checks had to change because they asserted the defect: check-offline-first required the
literal string secureInvoke<any>('moonraker_rpc'), which locked the any in place, and
check-moonraker-compat required the exact text of the server.info assignment that now normalizes first.
Both check the call that matters instead of its spelling.
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
    raise SystemExit('Expected exact unchanged trust channel at this sequence-171 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-171 candidate before R223 protocol typing')


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
print('Applied reviewed R223 protocol typing over the exact sequence-171 candidate.')
