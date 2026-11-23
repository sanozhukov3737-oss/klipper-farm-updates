"""Apply the reviewed R251 request scheduler timer host over the exact sequence-175 candidate.

PrinterRequestScheduler called window.setTimeout and window.clearTimeout directly. In the WebView that is
correct, but the scheduler is a plain state machine with no DOM dependency, and four checks import it in
Node where `window` does not exist at all: check-hardware-reliability, stress-hardware-reliability and
both verification-lab entry points all died with `ReferenceError: window is not defined` before reaching
the assertions they were written for.

The timers now come from a single host chosen once at module load: window when it exists, globalThis
otherwise. Picking window first is not cosmetic — check-printer-fault-recovery installs a fake
globalThis.window and replaces window.setTimeout with a deterministic timer map, so a straight switch to
globalThis would have made that harness observe real timers instead of its own.

Fixing that exposed a second failure of the same kind this series keeps producing. check-hardware-
reliability asserted same_printer_channel and the `matches!(requested.socket.port(), 80 | 7125)` guard
were in lib.rs; both moved to upload_commands in r248. The check now reads that file too. The two
remaining markers it looks for are in discovery_commands, which it already read.

One mistake worth recording: the first edit matched `class PrinterRequestScheduler{` inside
`export class PrinterRequestScheduler{` and left a dangling `export` in front of the new comment block,
which dropped the class from the module's exports. tsc caught it as
"declares 'PrinterRequestScheduler' locally, but it is not exported", and the final file keeps the
export in place with `tsc --noEmit` reporting nothing for this file.

Verified: tsc reports zero errors in requestScheduler.ts, check-hardware-reliability and
stress-hardware-reliability pass, the six other scripts that drive the scheduler still pass
(check-printer-fault-recovery, check-legacy-library-routing, check-print-start-delivery,
check-r127-print-confirmation, check-r127-notification-sound, check-runtime-stability), and
whole-suite failures drop from 32 to 30 with nothing new failing.

verification-lab and verification-lab-v20 now reach further and stop at "Frontend was not built from the
packaged source", which is the unbuilt dist/ tree on this machine, not this change.

No release: runtime robustness and verification repair only.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R250 applied before R251')


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
print('Applied reviewed R251 request scheduler timer host over the exact sequence-175 candidate.')
