"""Apply the reviewed R225 protocol behaviour tests over the exact sequence-172 candidate.

R223 typed the Moonraker boundary but left one thing said plainly: the types were closed, the deep
behaviour of response handling was not verified. This closes that.

A behavioural test now drives the real MoonrakerClient with only the IPC bridge replaced, and feeds it
the shapes a farm actually sees: Creality's wrapped result, a list nested under result.data, a null
object list, a string where an object is expected, an array where a record is expected, a cyclic
reference, and nesting deeper than the walk limit. It then drives the paths that consume them —
Spoolman spools, light status, object list, job queue — with valid, empty, error-shaped and transport
failure responses.

It found a real defect immediately. Spoolman answered as `{result: [...]}` — an array directly under
result — was parsed as an empty list, so the warehouse panel said there were no spools while the spools
existed. Different Moonraker and Spoolman versions answer under `response`, under `result`, or with the
array as the whole body; all three are now accepted.

The same test caught two mistakes of mine while I wrote it, which is the point of writing it: my first
synthetic light payload did not match the real `/printer/objects/query` shape, and my first expectation
for lightPayload ignored that it deliberately returns the response unwrapped for its callers.

Two pure parsers moved out of the client, because they are pure: moonrakerLightPayload and
moonrakerSpoolman. No transport, only shape checking. That makes them testable directly and keeps the
client from growing: it is 2229 lines instead of 2244, and the parts that can be verified in isolation
no longer need to be reached through it.

The two moderate advisories are closed too. Both came from vosk-browser, which depends on uuid 9. The
package override pins uuid 11.1.1, and vosk-browser uses only v4 — the vulnerable functions are v3,
v5 and v6 with a buffer argument, which it never calls. npm audit now reports zero.

Four checks that were never run now run. Three read the built dist and therefore belong after the
frontend build rather than before it: check-production-bundle, check-ui-files, check-full-audit. The
fourth, check-background-camera-browser-r118, needs playwright and now runs in the step that already
installs it. The regression list itself grows by the new behavioural test, to 115.
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
    'installedSequence': 172,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-172 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-172 candidate before R225 protocol behaviour')


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
print('Applied reviewed R225 protocol behaviour tests over the exact sequence-172 candidate.')
