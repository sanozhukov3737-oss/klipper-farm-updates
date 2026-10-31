#!/usr/bin/env python3
"""Prepare a local sequence-145 candidate only after exact FIX4 acceptance.

No network, signing, Git writes, release publication or CI dispatch. Run/provenance
and signed stable-manifest inputs must be freshly fetched by the caller. Their
authentication/identity is checked here; local JSON cannot prove fetch freshness.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shutil
import stat
import subprocess
import time
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit


REPO = 'sanozhukov3737-oss/klipper-farm-updates'
RUN_ID = 41195183959
COMMIT = '9a559e32a4faa4b583f990d0b5285138c5ab1895'
BRANCH = 'r146-offline-voice-quality'
WORKFLOW_PATH = '.github/workflows/preview10-natural-understanding.yml'
WORKFLOW_NAME = 'Build and verify small Windows app updates'
SOURCE_SHA = '51d178088b16c7392a3fd15420859b65ba1405212552c89aaa07c308c5305e91'
WORKFLOW_SHA = 'e1b6848514f30da84d4659728676f88d18308771bb743499e5457fbb237e63a8'
FIX4_BUILD = 'V20.6-R14.5-UPDATE-DELIVERY-FIX4-2026-10-31'
PRODUCTION_BUILD = 'V20.6-R14.5-UPDATE-DELIVERY-PRODUCTION-CANDIDATE-2026-10-31'
PUBLIC_KEY = '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
CHANNEL = {'endpoint': f'https://github.com/{REPO}/releases/latest/download/update-v20.json',
           'publicKeyHex': PUBLIC_KEY, 'channel': 'stable', 'installedSequence': 144}
CHANNEL_BYTES = (json.dumps(CHANNEL, indent=2) + '\n').encode()
CHANNEL_BEFORE_SHA = '91b693d1d3c216af9abd09229242f98e42fd6c9b922feedac64a466ce01f311b'
PREFIX = 'r148-understanding/'
FLAGS = ('cleanInstallVerified', 'updateReuseVerified', 'actualInstalledWebView',
         'actualInstalledSemanticBridge', 'understandingCleanupVerified')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON field: ' + key)
        result[key] = value
    return result


def parse_json(data: bytes):
    return json.loads(data.decode('utf-8-sig'), object_pairs_hook=no_duplicates)


def read_regular(path: Path, maximum=2 * 1024 ** 2) -> bytes:
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= maximum,
            'Input must be a bounded regular file: ' + path.name)
    return path.read_bytes()


def canonical(data: bytes) -> bytes:
    return data.replace(b'\r\n', b'\n')


def pinned_hash(value) -> bool:
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def positive_size(value, maximum) -> bool:
    return type(value) is int and 0 < value <= maximum


def verify_stable(manifest: dict) -> None:
    expected = {'schemaVersion', 'channel', 'sequence', 'version', 'publishedAt',
                'artifact', 'releaseNotes', 'signerKeyId', 'signatureHex'}
    require(isinstance(manifest, dict) and set(manifest) == expected, 'Stable manifest fields differ from updater schema')
    require(manifest['schemaVersion'] == 1 and type(manifest['schemaVersion']) is int
            and manifest['channel'] == 'stable' and type(manifest['sequence']) is int
            and manifest['sequence'] == 144, 'Expected authenticated stable sequence 144')
    version = manifest['version']
    require(isinstance(version, str) and len(version) <= 64 and re.fullmatch(
        r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version) is not None,
        'Invalid stable version')
    timestamp = manifest['publishedAt']
    require(type(timestamp) is int and 0 < timestamp <= int(time.time() * 1000) + 600000,
            'Invalid stable publication time')
    notes = manifest['releaseNotes']
    require(notes is None or isinstance(notes, str) and len(notes.encode()) <= 8192,
            'Invalid stable release notes')
    artifact = manifest['artifact']
    require(isinstance(artifact, dict) and set(artifact) == {'url', 'sha256', 'sizeBytes'},
            'Invalid stable artifact schema')
    require(isinstance(artifact['url'], str) and len(artifact['url']) <= 2048,
            'Invalid stable artifact URL')
    url = urlsplit(artifact['url'])
    require(url.scheme == 'https' and bool(url.hostname) and url.username is None
            and url.password is None and not url.fragment, 'Invalid stable artifact URL')
    require(pinned_hash(artifact['sha256']) and positive_size(artifact['sizeBytes'], 512 * 1024 ** 2),
            'Invalid stable artifact identity')
    require(manifest['signerKeyId'] == digest(bytes.fromhex(PUBLIC_KEY))[:32]
            and isinstance(manifest['signatureHex'], str)
            and re.fullmatch('[0-9a-f]{128}', manifest['signatureHex']) is not None,
            'Invalid stable signer identity')
    # Same domain and explicit field order as sign-v20-update.mjs / kf-update.
    verifier = r"""
const crypto=require('node:crypto');let input='';
process.stdin.setEncoding('utf8');process.stdin.on('data',v=>input+=v);
process.stdin.on('end',()=>{const {manifest:m,key}=JSON.parse(input);
const a={url:m.artifact.url,sha256:m.artifact.sha256,sizeBytes:m.artifact.sizeBytes};
const u={schemaVersion:m.schemaVersion,channel:m.channel,sequence:m.sequence,
version:m.version,publishedAt:m.publishedAt,artifact:a,releaseNotes:m.releaseNotes,signerKeyId:m.signerKeyId};
const der=Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(key,'hex')]);
const ok=crypto.verify(null,Buffer.concat([Buffer.from('klipper-farm-update-manifest-v1\0'),
Buffer.from(JSON.stringify(u))]),crypto.createPublicKey({key:der,format:'der',type:'spki'}),Buffer.from(m.signatureHex,'hex'));
process.exitCode=ok?0:1;});
"""
    result = subprocess.run(['node', '-e', verifier], input=json.dumps({'manifest': manifest, 'key': PUBLIC_KEY}),
                            text=True, capture_output=True, timeout=15)
    require(result.returncode == 0, 'Stable manifest signature does not match the existing trust key')


def verify_acceptance(run: dict, proof: dict) -> None:
    require(isinstance(run, dict) and isinstance(proof, dict), 'Acceptance evidence must be JSON objects')
    require(isinstance(run.get('repository'), dict), 'Acceptance repository identity is missing')
    require(type(run.get('id')) is int and run.get('id') == RUN_ID and run.get('head_sha') == COMMIT
            and run.get('head_branch') == BRANCH and run.get('path') == WORKFLOW_PATH
            and run.get('name') == WORKFLOW_NAME and run.get('repository', {}).get('full_name') == REPO,
            'Acceptance run identity differs from exact FIX4')
    require(run.get('status') == 'completed' and run.get('conclusion') == 'success',
            'Exact FIX4 Windows run is not completed successfully')
    require(str(proof.get('buildRunId')) == str(RUN_ID) and proof.get('buildHeadSha') == COMMIT
            and proof.get('buildId') == FIX4_BUILD and proof.get('installedSequence') == 144,
            'Acceptance provenance identity differs from exact FIX4')
    require(proof.get('preview') is True and proof.get('stablePublished') is False
            and proof.get('runtimePublished') is False and proof.get('standaloneInstaller') is True
            and proof.get('requiredComponentsFetchedWhenMissing') is True
            and proof.get('distribution') == 'small-installer-with-verified-components'
            and all(proof.get(flag) is True for flag in FLAGS), 'Missing installed Windows acceptance proof')
    installer = proof.get('installer', {})
    require(isinstance(installer, dict) and installer.get('fileName') == 'Klipper-Farm-Update-Delivery-setup.exe'
            and positive_size(installer.get('bytes'), 512 * 1024 ** 2)
            and pinned_hash(installer.get('sha256')), 'Invalid accepted installer identity')
    runtime = proof.get('runtime', {})
    require(isinstance(runtime, dict), 'Accepted runtime identity is missing')
    sha = runtime.get('sha256')
    require(pinned_hash(sha) and positive_size(runtime.get('bytes'), 2 * 1024 ** 3 - 1),
            'Invalid accepted runtime identity')
    name = 'klipper-farm-runtime-' + sha + '.zip'
    require(runtime.get('name') == name and runtime.get('url') ==
            f'https://github.com/{REPO}/releases/download/klipper-farm-runtime-v1/{name}',
            'Accepted runtime is not the immutable pinned release identity')
    model = proof.get('model', {})
    require(isinstance(model, dict) and model.get('bytes') == 2497281120 and model.get('sha256') ==
            '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
            'Accepted understanding model pin differs')


def replace_once(text: str, old: str, new: str) -> str:
    require(text.count(old) == 1, 'Pinned template occurrence differs: ' + old[:80])
    return text.replace(old, new, 1)


def make_candidate(source: bytes, workflow: bytes):
    require(digest(source) == SOURCE_SHA and digest(workflow) == WORKFLOW_SHA,
            'FIX4 frozen source or workflow checksum differs')
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)) and all(name.startswith(PREFIX) for name in names),
                'Unexpected source archive inventory')
        files = {name: archive.read(name) for name in names}
    manifest_name = PREFIX + 'source-manifest.json'
    manifest = parse_json(files[manifest_name])
    require(manifest['buildId'] == FIX4_BUILD and manifest['stableInstalledSequence'] == 144,
            'FIX4 overlay identity differs')
    rows = manifest['files']
    require(len(rows) == 56 and not any(row['path'] == 'UPDATE-CHANNEL.json' for row in rows),
            'FIX4 source manifest inventory differs')
    require(len({row['path'] for row in rows}) == len(rows)
            and set(names) == {PREFIX + 'apply.py', manifest_name,
                              *(PREFIX + 'changes/' + row['path'] for row in rows)},
            'Duplicate rows or unexpected source archive files')
    for row in rows:
        name = row['path']
        require(not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts
                and '\\' not in name, 'Unsafe source path')
        data = files[PREFIX + 'changes/' + name]
        require(digest(canonical(data)) == row['sha256'] and len(canonical(data)) == row['bytes'],
                'FIX4 source row checksum differs: ' + name)
    channel_after = dict(CHANNEL, installedSequence=145)
    channel_bytes = (json.dumps(channel_after, indent=2) + '\n').encode()
    require(digest(CHANNEL_BYTES) == CHANNEL_BEFORE_SHA, 'Original channel pin differs')
    files[PREFIX + 'changes/UPDATE-CHANNEL.json'] = channel_bytes
    rows.append({'path': 'UPDATE-CHANNEL.json', 'beforeSha256': CHANNEL_BEFORE_SHA,
                 'sha256': digest(channel_bytes), 'bytes': len(channel_bytes)})
    # Preserve the candidate's own portability/installer checks: they must assert
    # the new production identity and embedded sequence, not the old FIX4 values.
    sequence_contracts = {
        'scripts/check-r9-clean-installer.mjs': (
            "assert.equal(channel.installedSequence,144,'R144 native updater must identify the installed release as R144');",
            "assert.equal(channel.installedSequence,145,'production native updater must identify the installed release as R145');"),
        'scripts/check-release-portability.mjs': (
            "assert.equal(updateChannel.installedSequence,144,'packaged updater sequence must match R144');",
            "assert.equal(updateChannel.installedSequence,145,'packaged production updater sequence must match R145');"),
    }
    for row in rows:
        name = PREFIX + 'changes/' + row['path']
        data = files[name].replace(FIX4_BUILD.encode(), PRODUCTION_BUILD.encode())
        if row['path'] in sequence_contracts:
            data = replace_once(data.decode(), *sequence_contracts[row['path']]).encode()
        files[name] = data
        row.update(sha256=digest(canonical(data)), bytes=len(canonical(data)))
    rows.sort(key=lambda row: row['path'])
    manifest.update(buildId=PRODUCTION_BUILD, stableInstalledSequence=145,
                    beforeInstalledSequence=144, reviewedPreviousPreviewCommit=COMMIT)
    files[manifest_name] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    apply_name = PREFIX + 'apply.py'
    apply = files[apply_name].decode()
    apply = replace_once(apply,
        "if channel['installedSequence'] != 144:\n    raise SystemExit('Expected the R144-based preview channel; stable channel is not changed')",
        'expected_channel = ' + repr(CHANNEL) + '\n'
        "if channel not in (expected_channel, dict(expected_channel, installedSequence=145)):\n"
        "    raise SystemExit('Expected exact unchanged trust channel at sequence 144 or this sequence-145 candidate')")
    apply = replace_once(apply, 'stable sequence remains 144. Windows verification still required.',
                         'production candidate sequence is 145. Windows verification and stable publication still required.')
    apply = replace_once(apply,
        "print('Applied reviewed UPDATE-DELIVERY source;",
        "applied_channel = json.loads((root / 'UPDATE-CHANNEL.json').read_text(encoding='utf-8-sig'))\n"
        "if applied_channel != dict(expected_channel, installedSequence=145):\n"
        "    raise SystemExit('Applied production channel does not match sequence 145 with unchanged endpoint, key and channel')\n"
        "print('Applied reviewed UPDATE-DELIVERY source;")
    files[apply_name] = apply.encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 31, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    source_after = output.getvalue()
    text = replace_once(workflow.decode(), SOURCE_SHA, digest(source_after))
    text = replace_once(text, "buildId='" + FIX4_BUILD + "';installedSequence=144;",
                         'productionCandidate=$true;buildId=$candidateBuildId;installedSequence=$candidateChannel.installedSequence;')
    anchor = '          $components=Get-Content work/app/.update-components/component-build-report.json -Raw | ConvertFrom-Json\n          $modelInfo='
    guard = (
        "          $candidateChannel=Get-Content work/app/UPDATE-CHANNEL.json -Raw | ConvertFrom-Json\n"
        "          $candidateBuildId=(Get-Content work/app/RELEASE-BUILD-ID.txt -Raw).Trim()\n"
        f"          if ($candidateChannel.installedSequence -ne 145 -or $candidateBuildId -cne '{PRODUCTION_BUILD}' -or $candidateChannel.channel -cne 'stable' -or $candidateChannel.publicKeyHex -cne '{PUBLIC_KEY}' -or $candidateChannel.endpoint -cne '{CHANNEL['endpoint']}') {{ throw 'Production candidate embedded channel or identity differs' }}\n")
    text = replace_once(text, anchor, guard + anchor)
    anchor = '          Copy-Item candidate/update-provenance.json runtime-publish/update-provenance.json'
    text = replace_once(text, anchor,
        "          $candidateProof=Get-Content candidate/update-provenance.json -Raw | ConvertFrom-Json\n"
        "          if ($candidateProof.installedSequence -ne 145 -or $candidateProof.installedSequence -ne $candidateChannel.installedSequence -or $candidateProof.buildId -cne $candidateBuildId) { throw 'Production candidate provenance sequence or identity differs' }\n" + anchor)
    return source_after, text.encode()


def prepare(source: Path, workflow: Path, run_path: Path, proof_path: Path,
            stable_path: Path, output: Path) -> dict:
    require(not output.exists() and not output.is_symlink(), 'Output directory already exists; refusing overwrite')
    # Nothing is created until all evidence, authentication and pinned inputs pass.
    source_bytes, workflow_bytes = read_regular(source), read_regular(workflow)
    run_bytes, proof_bytes, stable_bytes = (read_regular(path) for path in (run_path, proof_path, stable_path))
    verify_acceptance(parse_json(run_bytes), parse_json(proof_bytes))
    verify_stable(parse_json(stable_bytes))
    next_source, next_workflow = make_candidate(source_bytes, workflow_bytes)
    report = {'localDraftOnly': True, 'stablePublished': False, 'runtimePublished': False,
              'ciDispatched': False, 'acceptedRunId': RUN_ID, 'acceptedCommit': COMMIT,
              'buildId': PRODUCTION_BUILD, 'installedSequence': 145,
              'sourceSha256': digest(next_source), 'workflowSha256': digest(next_workflow),
              'inputHashes': {'acceptedRun': digest(run_bytes), 'acceptedProvenance': digest(proof_bytes),
                              'authenticatedStableManifest': digest(stable_bytes)},
              'nextRequirement': 'Review and run Windows acceptance for this exact production candidate; no stable release is published.'}
    payloads = {'preview10-understanding-source.zip': next_source,
                'preview10-natural-understanding.yml': next_workflow,
                'production-candidate-proof.json': (json.dumps(report, indent=2) + '\n').encode()}
    # Exclusive directory creation prevents accidental replacement of old output.
    # Build all bytes first, then publish this small local directory.
    output.mkdir()
    try:
        for name, data in payloads.items():
            with (output / name).open('xb') as target:
                target.write(data)
    except BaseException:
        shutil.rmtree(output)
        raise
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('source', 'workflow', 'accepted-run', 'accepted-provenance', 'stable-manifest', 'output'):
        parser.add_argument('--' + argument, type=Path, required=True)
    args = parser.parse_args()
    report = prepare(args.source, args.workflow, args.accepted_run, args.accepted_provenance,
                     args.stable_manifest, args.output)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
