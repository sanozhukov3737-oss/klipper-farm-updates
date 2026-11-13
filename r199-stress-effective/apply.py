"""Apply the reviewed R199 stress-taking-effect fix over the exact sequence-163 candidate.

Reported: «темпу» still does not sound right in the near-end announcement, after a dozen rounds
of fixing stress. Measuring the real speech runtime on this machine explains why.

The synthesizer was called with put_accent=True and put_stress_homo=True, which tell the model to
place accents itself. Rendering the same phrase with and without our stress marks produced
byte-identical audio — 154800 samples, no difference at a single position. Every mark in the table
was being discarded, so R181 through R196 changed nothing audible.

With put_accent=False the marks are honoured and the output changes on every word: the near-end
phrase with the table gives 34dbc596f8be at 3.21 s, with a deliberately wrong mark 05a8d3fc73da at
3.12 s, and unmarked 10d4ca3fb7d4 at 2.91 s. The table is live for the first time.

Turning the model's own accentuation off means words outside the table are read without stress,
so coverage matters more than before. The generator previously collected words of four letters or
more, which skipped every short multi-syllable word — или, его, имя, мою, это, код. The threshold
drops to three letters, and «н+ет» joins the fixtures. Coverage of the spoken phrases is now
complete apart from ten two-letter function words.

Lowering the threshold surfaced one homograph: the reference reads «мою» as the verb мо́ю, while
our interface says «Мою флешку». That word is pinned in MANUAL_STRESS as м+ою.

The synthesizer test asserted put_accent=True. It now asserts the opposite and explains why, so a
future change cannot silently disable the table again.

Verified on the real runtime: the marks change the audio, the generator reports the table matches
the reference at 2001 entries, 19 pronunciation tests pass, and the runtime probe fixtures match.
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
print('Applied reviewed R199 effective stress over the exact sequence-163 candidate.')
