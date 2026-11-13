"""Apply the reviewed R199 spoken stress coverage over the exact sequence-163 candidate.

Measuring the real speech runtime — the bundled interpreter, torch and the Silero model that
ship on the farm — produced two findings, one of which corrected a mistake of mine.

The mistake. I had concluded from an earlier measurement that put_accent=True discarded our
stress marks, because a phrase rendered with and without marks came out byte-identical. The
decisive test shows otherwise: with put_accent=True, «з+апуск» and «зап+уск» — a correct and a
deliberately wrong mark on the same word — produce different audio (5ce085045a at 0.71 s versus
d6bb881d76 at 0.75 s). The marks are read. The identical result only meant the model's own
accentuation happened to agree with the table.

So put_accent stays True, and turning it off would have been a regression: rendering a printer
name outside the table, «Кухня», differs between put_accent True and False (b507b111ca at 0.54 s
versus 9a455102a9 at 0.46 s) — with it off the name is read with no stress at all. The setting is
what gives stress to user names and any word the table does not cover.

Two real gaps were found by the same measurement.

The word «ноль» was absent from the numeral list, although num2words produces it for a zero and
the printer-number reading spells it. Every «0 градусов» and every printer numbered 02 or 10 was
announced with that word unstressed.

The generator collected words of four letters or more, which silently skipped every short
multi-syllable word the assistant says: или, его, имя, это, мою, код. The threshold drops to
three letters, which adds 67 entries. Coverage of the spoken phrases is now complete apart from
ten two-letter function words that carry no stress anyway.

An audit of every entry against the reference dictionary then found one entry of mine that was
wrong: I had pinned «мою» as м+ою, treating it as the verb. In «Мою флешку» it is the possessive
accusative — мою́ — so the reference was right and my override is removed.

Verified on the real runtime: all spoken phrases render with proportional duration and no
anomalies against the median seconds-per-character, the generator reports 1976 entries matching
the reference, and 19 pronunciation tests pass.
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
    'installedSequence': 163,
}
if channel != expected_channel:
    raise SystemExit('Expected exact unchanged trust channel at this sequence-163 candidate')
identity = (root / 'RELEASE-BUILD-ID.txt').read_text(encoding='utf-8-sig').strip()
if identity != manifest['baseBuildId']:
    raise SystemExit('Expected the accepted sequence-163 candidate before R198 microphone preparation')


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
print('Applied reviewed R199 spoken stress coverage over the exact sequence-163 candidate.')
