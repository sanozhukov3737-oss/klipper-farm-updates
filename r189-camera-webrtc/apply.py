"""Apply the reviewed R189 camera WebRTC negotiation over the exact sequence-161 candidate.

The camera still did not appear after R186 taught the component to walk endpoints. Probing the
printers explained why: there is no MJPEG endpoint at all. Ports 80 and 8081 refuse, 8080 is
closed, and 8000 answers every path with the same HTML page — the camera's own test page,
titled "Video On Demand". The stream exists only over WebRTC on 8000.

That page is a working reference, so the component was compared against it line by line:

    reference                                   our component
    iceServers: [{urls: stun:...}]              iceServers: []            no STUN
    addTransceiver('video', {sendrecv})         recvonly for the K1C
    send the offer when event.candidate === null  send after 2500 ms regardless
    default codec order                         H.264 forced first

The decisive difference is the third. The reference waits for the null candidate, which marks
the end of ICE gathering, before posting the offer. Ours capped the wait at 2.5 seconds and
posted whatever it had, often an SDP with no candidates. The printer answers such an offer
correctly — which is why signalling looked healthy — but media has nowhere to go, so no frames
arrive and the component reports "Камера не передаёт видеокадры".

The component now mirrors the reference: STUN as the page uses, a bidirectional transceiver,
default codec order, and an offer sent only after the null candidate, with a 12 second ceiling
for a slow network.

WebRTC also becomes the primary path and MJPEG the fallback, in that order. The walk from R186
stays, since a different firmware may still serve a stream, but it no longer runs first: on
these printers it cost twelve short timeouts before the only working path was even tried.
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
    'installedSequence': 161,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-161 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected the accepted sequence-161 candidate before R189 camera negotiation')


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
print('Applied reviewed R189 camera WebRTC negotiation over the exact sequence-161 candidate.')
