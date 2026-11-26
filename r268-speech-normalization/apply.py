"""Apply the reviewed R268 speech normalisation repair over the exact sequence-175 candidate.

Widening the phrase set from 19 to 49 — different cases, word orders, colloquial forms, negations — and
running it against the real model found three defects, one of them a class rather than a case.

The serious one: the rule that recognises the Flashforge printer name had no word boundaries.

    .replace(/(?:пять|5)\\s*(?:эм|м|m)/gu,'5m')

Inside "15 минут" it matched the trailing "5" and the "м", so the phrase normalised to "15mинут" and
voiceForecastMinutes could no longer read the duration. Every horizon whose last digit is 5 was lost —
"через 5 минут", "15", "25", "45", "55" — and it failed silently, because the assistant simply answered with
a different forecast mode. "пять минут" became "5mинут" for the same reason. The rule now requires a boundary
on both sides, so the printer alias still works and durations are untouched.

Second: a status question was read as a file search. "Что печатается?" reached the model as text, came back as
find with a query of the whole sentence, and the validator had no reason to object. The deterministic reader
already knew how to answer status questions, but only when every word was a status word — and "печатается"
was not in its list while "печатает" was. The word forms and the "что" interrogative are added, and a pure
status question now wins over a model that calls it a file.

Third: "Можно камеру Макса?" — the model read it correctly as camera for max, and the validator replaced that
correct answer with a clarification, because the action reader demanded an explicit открой/покажи. Asking for
the camera is a read-only request; the verbs можно and дайте are accepted for it. Permission questions about
physical actions such as pause are deliberately left alone: they name no printer, and the validator keeps
refusing to act on them.

Two of my initial expectations were wrong and are corrected in the set rather than forced into code:
"Поставь в очередь корпус" is a plan, not a print, and "Что с катушками?" is vague enough that asking is the
right answer.

Verified: 49 of 49 phrases pass on the real model with the full path (model answer, then validator). The new
check-voice-normalization.mjs pins all of it without needing the model, and fails against the previous
voiceCommands.ts with "срок не прочитан: через 5 минут". Seven of the phrases are added to
preview10-installed-speech.mjs so CI exercises them on the real model too, with its checksum updated. The
regression suite is 138 passed, 0 failed, 22 skipped.

No release: speech normalisation, status reading and their coverage.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R267 applied before R268')


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
print('Applied reviewed R268 speech normalisation repair.')
