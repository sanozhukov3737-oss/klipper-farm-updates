"""Apply the reviewed R183 generated stress table over the exact sequence-159 candidate.

R181 and R182 edited the stress table by hand. Checking that table against a published
reference showed ten wrong entries in roughly three hundred —библиотЕка written with the
stress on О, детАль, модЕль, настрОйки, грАдусов, освободИлся, вЫберите — plus three that
this session introduced. A hand-written table cannot be checked: the eye only finds what is
already spelled out.

The table is now generated. `scripts/generate-speech-stress.py` reads the ruaccent dictionary
(MIT, 3.19 million word forms), takes every Russian word of four letters or more that the
interface can say, and writes the table into `silero-synthesize.py` between two markers. The
review reads a diff instead of inventing stress by hand.

Scope is deliberately the application's own strings, all of them: any label can end up in a
notification, and notifications are spoken — «Подсветка включена» lives in ControlPanel.tsx,
not in the voice files. Numbers are covered too, since the unit nouns come from runtime
agreement rather than any literal. That yields 1876 entries, 1860 from the reference.

Three classes are excluded, each for a reason:

* words containing ё, because the letter already marks the stress;
* the 2123 omographs of the reference list, where the reading depends on meaning — pinning
  «все» as «вс+е» would break «всё»;
* words the reference does not have, which stay in a short MANUAL_STRESS block holding the
  transliterated printer names (Креалити, Эндер, Флэшфордж, Клиппер) and the few spoken
  words the reference lacks (филамент, флешка, переподключается).

Words the application never says are now left to the model instead of being guessed. That
is why the table no longer carries «завершается» or «выключил»: no string produces them, and
a table entry for an unseen word is a guess dressed as knowledge.

The fixtures move with the source of truth, as in R181. A new test asserts the opposite of
the old one — that a form outside the vocabulary comes out unmarked rather than invented.
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
    'installedSequence': 159,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-159 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['buildId']:
    raise SystemExit('Expected the accepted sequence-159 candidate before R183 generated stress')


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
print('Applied reviewed R183 generated stress table over the exact sequence-159 candidate.')
