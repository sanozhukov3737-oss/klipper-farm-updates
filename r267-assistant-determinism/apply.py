"""Apply the reviewed R267 horizon and service-command determinism over the exact sequence-175 candidate.

Running the assistant against the actual model on this machine — the 2.33 GB Qwen3 Q4_K_M build and the
llama-server-avx2 runtime that the installer places — found two answers that CI had reported as correct and
that were wrong here. The same prompt, the same model file and temperature 0 produced mode=first for "через
час" on this AMD Ryzen, while the CI evidence from run 45645736893 recorded mode=after with minutes=60 on
Intel. Session-stable in both cases: four phrasings, three repetitions each, identical every time.

That is the finding worth keeping. Whether the interpreter says "through an hour" or "first to finish" is not
a decision a farm should make differently depending on its CPU, so the two cases the text can settle are now
settled from the text.

A stated horizon decides the forecast mode. voiceForecastMinutes already read the duration; the validator only
applied it when the model had already chosen after, or when the phrase parser recognised the wording. Neither
held for "кто ещё будет занят через полчаса" or "через час что будет". Now any forecast request carrying a
readable horizon becomes after with that horizon, whatever the model said and whatever shape the sentence has.
Without a horizon nothing is invented: "кто освободится первым" stays first with no minutes.

A service command is not a file. "Отправь M112 на принтер" came back as print with query M112 — an emergency
stop read as the name of something to print. The frontend now refuses print and find when the query is a
G-code or macro verb (M112, G28, SET_PIN, RESTART and alike) or when the request says to send, run or execute
a command. The deterministic parser already refused these; the model path did not.

Both rules are additions to the existing validator, next to the printer, control and previous-file checks that
already correct the model, so the assistant keeps one place where model output is judged.

Verified against the real model with the full path — model answer, then validator: 19 of 19 phrases correct,
including all five refusals, where before the change two were wrong. The validator is demonstrably doing the
work in three of them ("через час что будет" model=first, "Отправь M112" model=print/M112, "Выполни G28"
model=control/pause). The check-voice-semantic suite is 29 cases and fails against the previous
voiceSemantic.ts with "Через час что будет?".

I also tried and reverted a prompt change. Adding explicit rules and examples for both cases did not move the
model at all, which is further reason to keep the decision in code.

No release: assistant determinism and its coverage.
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
    raise SystemExit('Expected the accepted sequence-175 candidate with R266 applied before R267')


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
print('Applied reviewed R267 horizon and service-command determinism.')
