#!/usr/bin/env python3
"""Freeze the approved R142 palette and five release metadata edits over published R141."""
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

ROOT=Path(__file__).resolve().parent
BASE_SHA='abf4ffe061e203237f921b11f624ae04f821587d6fcf5410f83b4d28ba114878'
BASE_SIZE=582467387
PREFIX='Klipper-Farm-R141/'
APPROVED_SHA='9ead6976bd1006b663399b12841b24212fa4ec0f6846e121a9f7189b2c2b1f8f'
OLD_BUILD='V20.6-R14.1-PERFORMANCE-TELEMETRY-2026-10-26'
BUILD='V20.6-R14.2-GRAPHITE-FILES-2026-10-27'
METADATA=['RELEASE-BUILD-ID.txt','UPDATE-CHANNEL.json','scripts/build-and-install-windows.mjs','scripts/check-r9-clean-installer.mjs','scripts/check-release-portability.mjs']
FEATURE={'src/styles.css','ui-tests/files-contrast-r139.mjs'}

def digest(data):return hashlib.sha256(data).hexdigest()
def dump(name,value):
    data=(json.dumps(value,indent=2)+'\n').encode();(ROOT/name).write_bytes(data)
    (ROOT/(name.removesuffix('.json')+'.sha256')).write_text(digest(data)+'  '+name+'\n')
    return digest(data)

def main():
    archive=Path(sys.argv[1])
    assert archive.stat().st_size==BASE_SIZE
    with archive.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==BASE_SHA
    approved=(ROOT/'r142-graphite-patch.json').read_bytes();assert digest(approved)==APPROVED_SHA
    draft=json.loads(approved);assert {r['path'] for r in draft['files']}==FEATURE and len(draft['files'])==2
    baseline={};originals={}
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            assert item.filename.startswith(PREFIX)
            if item.is_dir():continue
            name=item.filename[len(PREFIX):];parsed=PurePosixPath(name)
            assert name and not parsed.is_absolute() and '..' not in parsed.parts and '\\' not in name and ':' not in name
            assert name not in baseline and ((item.external_attr>>16)&0o170000)!=0o120000
            data=z.read(item);baseline[name]=digest(data)
            if name in METADATA:originals[name]=data
    assert len(baseline)==1856
    assert draft['baselineFiles']=={k:v for k,v in baseline.items() if not k.startswith('dist/')}
    for row in draft['files']:
        assert baseline[row['path']]==row['beforeSha256']
        assert digest(base64.b64decode(row['contentBase64'],validate=True))==row['sha256']
    feature={**draft,'baselineFiles':dict(sorted(baseline.items())),'approvedDraftFeatureSha256':APPROVED_SHA}
    feature_sha=dump('r142-release-feature.json',feature)
    rows=[]
    for name in METADATA:
        before=originals[name];text=before.decode()
        if name=='RELEASE-BUILD-ID.txt':
            assert text.strip()==OLD_BUILD;after=(BUILD+'\n').encode()
        elif name=='UPDATE-CHANNEL.json':
            value=json.loads(text);assert value['installedSequence']==141 and value['channel']=='stable'
            value['installedSequence']=142;after=(json.dumps(value,indent=2)+'\n').encode()
        elif name=='scripts/build-and-install-windows.mjs':
            old='Klipper Farm v1.14.5 - R141 Performance and Telemetry';assert text.count(old)==1
            after=text.replace(old,'Klipper Farm v1.14.5 - R142 Graphite Files').encode()
        else:
            assert OLD_BUILD in text
            text=text.replace(OLD_BUILD,BUILD).replace('R141','R142')
            old='assert.equal(channel.installedSequence,141' if name.endswith('check-r9-clean-installer.mjs') else 'assert.equal(updateChannel.installedSequence,141'
            assert text.count(old)==1
            after=text.replace(old,old[:-3]+'142').encode()
        assert after!=before
        rows.append({'path':name,'beforeSha256':digest(before),'sha256':digest(after),'contentBase64':base64.b64encode(after).decode()})
    identity={'schemaVersion':1,'release':'R142','baseline':'R141','sequence':142,'version':'1.14.5-r142','productVersion':'1.14.5','buildId':BUILD,'featurePatchSha256':feature_sha,'approvedDraftFeatureSha256':APPROVED_SHA,'baseArchiveSha256':BASE_SHA,'baseArchiveSize':BASE_SIZE,'archivePrefix':PREFIX,'baselineFiles':dict(sorted(baseline.items())),'files':rows}
    identity_sha=dump('r142-release-identity.json',identity)
    print(json.dumps({'passed':True,'baselineFiles':len(baseline),'featureFiles':2,'identityFiles':5,'featureSha256':feature_sha,'identitySha256':identity_sha,'buildId':BUILD}))

if __name__=='__main__':main()
