"""Apply the reviewed R220 promise handling over the exact sequence-170 candidate.

The lint added in R218 started as a warning for floating promises because the existing code had twenty
seven of them, and rewriting all twenty seven at once, without a behavioural test for each, was riskier
than leaving them visible. They are now fixed, so the rule can hold the line.

Two kinds, and the difference matters.

Most were fire and forget by intent: a journal write, a print record, a Telegram notification, a
refresh after a save. Those have their own error handling, so the fix is to say so — `void` states
that the call is deliberately not awaited, which is what the rule asks for. Without it a reader cannot
tell a deliberate choice from a missing await.

Six were not. An async function invoked inside useEffect, or an async IIFE, left any rejection
unhandled: a failed report load, a failed settings read, a failed Telegram settings read, a failed
camera negotiation. Those got an explicit catch that reports through the diagnostics logger, or sets
the error the operator should see. Two of them — the sign-out path and the storage check — already had
a finally, which is why the missing catch went unnoticed: the cleanup ran, and the failure vanished.

One case was not a lost await at all. `openFlashFor` declared an abort signal that an inner parameter
of the same name shadowed, so cancellation never reached the function that was supposed to honour it.
The outer parameter was dead and has been removed rather than silenced.

Deliberately unchanged: the twenty seven `any` in the Moonraker protocol boundary. Replacing them with
a stricter type was attempted and abandoned within this change, because it does not stay local —
`manifests` and RPC results become possibly-undefined, and the compiler then reports several places
that would read them without a check. That is a real defect class, but repairing it means changing
protocol behaviour, which needs behavioural tests rather than a lint pass. It stays visible as debt
rather than hidden behind a disable comment.
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
    'installedSequence': 170,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-170 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-170 candidate before R220 promise handling')


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
print('Applied reviewed R220 promise handling over the exact sequence-170 candidate.')
