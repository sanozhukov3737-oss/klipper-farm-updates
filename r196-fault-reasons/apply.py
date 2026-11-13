"""Apply the reviewed R196 fault reason translation over the exact sequence-162 candidate.

Reported from the farm: when a print fails, the assistant says something useless. Reading the
spoken output confirmed it, and the cause is a chain rather than one defect.

Klipper reports the reason in English — «Heater extruder not heating at expected rate», «Move out
of range: 220.5 0.0 10.0». That text is taken from state_message, placed into the fault message
and handed to the synthesizer, which strips latin words for good reason: single codes read better
that way. Here it destroyed the meaning. The operator heard «ошибка.» and nothing else for a
heater failure, or «ошибка.: эм си ю» for an MCU shutdown, or a row of coordinates read as words.

printerFaultReason recognises the failure by its keywords and returns a short Russian phrase for
the ear: не нагревается хотэнд, неисправен датчик температуры, сбой платы управления,
координата вне области печати, плата не успевает отвечать и so on. Unknown text becomes
«причина не распознана, подробности в журнале» rather than a stream of fragments.

The full English message is untouched: it still reaches the notification, the audit journal and
the printer card. Only what is spoken changed.

The order of the keyword table matters and is deliberate: thermistor patterns are tested before
the generic heater pattern, so an ADC-out-of-range shutdown is announced as a sensor fault rather
than as a heater fault.

Verified by bundling the real modules and running nine Klipper messages through the exported
function, then through the synthesizer: every phrase is coherent, and no output contains latin
fragments or coordinate numbers.
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
    'installedSequence': 162,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-162 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected the accepted sequence-162 candidate before R196 fault reason translation')


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
print('Applied reviewed R196 fault reason translation over the exact sequence-162 candidate.')
