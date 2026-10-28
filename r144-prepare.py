"""Restore the exact published R143 source and apply the reviewed R144 delta."""
import argparse,base64,hashlib,json,pathlib,zipfile

parser=argparse.ArgumentParser();parser.add_argument('archive',type=pathlib.Path);parser.add_argument('destination',type=pathlib.Path);args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parent
changes=json.loads((root/'r144-source-changes.json').read_text())
assert changes['sequence']==144
with args.archive.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==changes['baselineSha256'],'Published baseline source hash differs'
assert args.archive.stat().st_size==changes['baselineBytes']
assert not args.destination.exists(),'Source destination must be fresh'
args.destination.mkdir(parents=True)
with zipfile.ZipFile(args.archive) as package:
    for entry in package.infolist():
        parts=pathlib.PurePosixPath(entry.filename).parts
        assert parts[0]=='Klipper-Farm-R143' and '..' not in parts and '\\' not in entry.filename
        assert (entry.external_attr>>16)&0o170000!=0o120000,'Baseline cannot contain symlinks'
        if len(parts)==1:continue
        path=args.destination.joinpath(*parts[1:])
        if entry.is_dir():path.mkdir(parents=True,exist_ok=True)
        else:path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(package.read(entry))
for entry in changes['files']:
    path=pathlib.PurePosixPath(entry['path']);assert not path.is_absolute() and '..' not in path.parts and '\\' not in entry['path']
    target=args.destination.joinpath(*path.parts)
    before=hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
    assert before==entry['beforeSha256'],f'Unreviewed baseline bytes: {path}'
    content=base64.b64decode(entry['contentBase64'],validate=True)
    assert hashlib.sha256(content).hexdigest()==entry['afterSha256']
    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
assert (args.destination/'RELEASE-BUILD-ID.txt').read_text().strip()==changes['buildId']
channel=json.loads((args.destination/'UPDATE-CHANNEL.json').read_text());assert channel['installedSequence']==144
assert channel['publicKeyHex']=='28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
print(json.dumps({'baselineVerified':True,'baselineTag':changes['baselineTag'],'filesApplied':len(changes['files']),'buildId':changes['buildId']}))
