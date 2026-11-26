"""Apply the reviewed R266 assistant resilience work over the exact sequence-175 candidate.

The assistant already had 17 behavioural checks and 355 cases, so the place to look was not coverage but the
failures that only happen on a farm. Probing it with fifteen scenarios found one real defect.

voiceAssistant.run() ended with `text: error instanceof Error ? error.message : String(error)`, which handed
any thrown value straight into the conversation. A TypeError inside the print path therefore reached the
operator as "Cannot read properties of undefined (reading 'ok')" — a string that explains nothing, cannot be
acted on, and makes the assistant look broken rather than careful.

Now only internal failures are replaced. The classifier keys on the error's name, not its text, because the
distinction that matters is "the code is wrong" versus "the farm is in a state you must react to":
TypeError, RangeError, ReferenceError, SyntaxError, EvalError and URIError become a plain Russian sentence,
while an Error carrying a real explanation — a busy printer, a changed hash — keeps its own wording. That
second half is not an oversight: an existing check asserts the SHA256 message reaches the operator, and it
still passes.

The technical message is not thrown away. VoiceReply gained diagnosticDetail, and the panel writes it to the
diagnostics journal, so the string that would have confused the operator is now where an installer looks.

check-voice-resilience.mjs turns the probe into a permanent check with 17 scenarios, all of them about either
keeping a print from starting wrongly or keeping a technical string out of the speech: two commands at once,
cancel mid-command, a relay failure, a start failure, a conversation that expires, 4 KB of input, empty and
junk input, forty printers and five hundred files, no role, a printer with no status, a start that failed
leaving no hidden proposal, a double confirmation that must start once, cancel before confirming, the printer
disappearing mid-dialogue, a validation failure, an internal error that must not surface, and a situational
error that must.

Verified: the check passes and fails on the real regression — disabling the filter reproduces "техническая
строка утекла в ответ: Cannot read properties..." — and all 18 runnable assistant checks still pass. The
regression suite is 137 passed, 0 failed, 22 skipped.

No release: assistant robustness and its coverage.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R265 applied before R266')


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
print('Applied reviewed R266 assistant resilience over the exact sequence-175 candidate.')
