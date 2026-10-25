#!/usr/bin/env python3
"""Pin one successful R138 build+Windows validation run to downloaded bytes.

Usage: python r138-promotion-contract.py INCOMING_DIRECTORY OUTPUT_CONTRACT_JSON
Metadata filenames: build-run.json, build-jobs.json, source-artifact.json,
build-evidence-artifact.json, build-workflow.yml. Supply the full
validated-artifact.zip or installer-only reviewed-installer.zip + its metadata.
"""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

REPOSITORY = 'sanozhukov3737-oss/klipper-farm-updates'
PATCH_SHA = 'f00d0eee45ccc36fbee60077526e7fceae099f302adaf574ab01d5f6a7d70fa1'
IDENTITY_SHA = '2223adccadc3a5440c1dbb5a152b1828c96d8d6d5c76089354d85b175f1d9cee'
BASE_SHA = 'a2c7c77fc62cd6818be5f86192827ded786e3a4ac99ebdb6559924a30ae1c6ca'
BUILD_ID = 'V20.6-R13.8-LIVE-CARDS-2026-10-25'
EXPECTED = {'Klipper-Farm-R138-setup.exe', 'KF-R138-FULL.zip', 'R138-UI-proof.zip', 'provenance.json', 'exact-validation.json'}
REVIEWED_EXPECTED = {'Klipper-Farm-R138-setup.exe', 'provenance.json', 'exact-validation.json'}
FLAGS = ['passed', 'cleanInstallVerified', 'exactInstallerPayloadVerified', 'installedBinaryHashesMatch', 'desktopWebViewLoaded',
         'legacyDataPreserved', 'printerConfigurationPreserved', 'filamentInventoryPreserved',
         'costSettingsPreserved', 'installedRestartVerified', 'embeddedUpdateChannelVerified']


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def artifact_metadata(incoming, filename, name, run):
    artifact = load(incoming / filename)
    assert artifact['name'] == name and artifact['expired'] is False, filename
    assert str(artifact['workflow_run']['id']) == str(run['id']), filename
    assert artifact['workflow_run']['head_sha'] == run['head_sha'], filename
    assert re.fullmatch('sha256:[a-f0-9]{64}', artifact['digest']), filename
    assert type(artifact['size_in_bytes']) is int and artifact['size_in_bytes'] > 0
    return artifact


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    incoming, output = map(Path, sys.argv[1:])
    run = load(incoming / 'build-run.json')
    assert run['status'] == 'completed' and run['conclusion'] == 'success'
    assert run['head_branch'] == 'r138-live-cards' and run['event'] in ['push', 'workflow_dispatch']
    assert run['path'] == '.github/workflows/windows-r138-reviewed.yml'
    assert re.fullmatch('[a-f0-9]{40}', run['head_sha'])
    if 'repository' in run:
        assert run['repository']['full_name'] == REPOSITORY
    jobs = load(incoming / 'build-jobs.json')['jobs']
    job_ids = {}
    for name in ['build', 'validate']:
        selected = [job for job in jobs if job['name'] == name]
        assert len(selected) == 1, name
        job = selected[0]
        assert str(job['run_id']) == str(run['id']) and job['head_sha'] == run['head_sha'], name
        assert job['status'] == 'completed' and job['conclusion'] == 'success', name
        assert len(job['steps']) > 2 and all(step['conclusion'] == 'success' for step in job['steps'] if not step['name'].startswith('Post ')), name
        job_ids[name] = str(job['id'])
    artifact = artifact_metadata(incoming, 'source-artifact.json', 'r138-ota-validated', run)
    evidence = artifact_metadata(incoming, 'build-evidence-artifact.json', 'r138-ota-build-evidence', run)
    archive, archive_metadata, expected_names = incoming / 'validated-artifact.zip', artifact, EXPECTED
    if not archive.exists():
        archive = incoming / 'reviewed-installer.zip'
        archive_metadata = artifact_metadata(incoming, 'reviewed-installer-artifact.json', 'r138-reviewed-installer', run)
        expected_names = REVIEWED_EXPECTED
    assert 'sha256:' + digest(archive) == archive_metadata['digest']
    assert archive.stat().st_size == archive_metadata['size_in_bytes']
    evidence_zip = incoming / 'build-evidence.zip'
    assert 'sha256:' + digest(evidence_zip) == evidence['digest']
    assert evidence_zip.stat().st_size == evidence['size_in_bytes']
    with zipfile.ZipFile(archive) as bundle:
        assert len(bundle.infolist()) == len(expected_names) and set(bundle.namelist()) == expected_names
        pins, metadata = {}, {}
        for info in bundle.infolist():
            assert not info.is_dir() and (info.external_attr >> 16) & 0o170000 != 0o120000
            with bundle.open(info) as stream:
                pin = {'sha256': hashlib.file_digest(stream, 'sha256').hexdigest(), 'sizeBytes': info.file_size}
            if info.filename in ['provenance.json', 'exact-validation.json']:
                metadata[info.filename] = pin
            elif info.filename != 'R138-UI-proof.zip':
                pins[info.filename] = pin
        origin = json.loads(bundle.read('provenance.json').decode('utf-8-sig'))
        validation = json.loads(bundle.read('exact-validation.json').decode('utf-8-sig'))
    for key, expected in {'release': 'R138', 'sequence': 138, 'baselineSequence': 137,
                          'buildId': BUILD_ID, 'patchSha256': PATCH_SHA,
                          'releaseIdentitySha256': IDENTITY_SHA, 'headSha': run['head_sha']}.items():
        assert origin[key] == expected, key
    assert str(origin['runId']) == str(run['id'])
    assert set(origin['assets']) == {'Klipper-Farm-R138-setup.exe', 'KF-R138-FULL.zip'}
    for name, pin in origin['assets'].items():
        assert set(pin) == {'sha256', 'sizeBytes'}
        assert re.fullmatch('[a-f0-9]{64}', pin['sha256']) and type(pin['sizeBytes']) is int and pin['sizeBytes'] > 0
        if name in pins:
            assert pin == pins[name], name
    assert 'Klipper-Farm-R138-setup.exe' in pins
    for key, expected in {'release': 'R138', 'installedSequence': 138, 'upgradeFrom': 137,
                          'headSha': run['head_sha']}.items():
        assert validation[key] == expected, key
    assert str(validation['runId']) == str(run['id'])
    if 'buildRunId' in validation:
        assert str(validation['buildRunId']) == str(run['id'])
    if 'buildHeadSha' in validation:
        assert validation['buildHeadSha'] == run['head_sha']
    for flag in FLAGS:
        assert validation[flag] is True, flag
    contract = {'schemaVersion': 1, 'repository': REPOSITORY, 'sequence': 138, 'tag': 'r138-ota',
                'buildRunId': str(run['id']), 'buildHeadSha': run['head_sha'],
                'buildWorkflowSha256': digest(incoming / 'build-workflow.yml'), 'jobs': job_ids,
                'sourceArtifactId': str(artifact['id']), 'sourceArtifactDigest': artifact['digest'],
                'sourceArtifactSizeBytes': artifact['size_in_bytes'],
                'buildEvidenceArtifactId': str(evidence['id']), 'buildEvidenceArtifactDigest': evidence['digest'],
                'buildEvidenceArtifactSizeBytes': evidence_zip.stat().st_size,
                'patchSha256': PATCH_SHA, 'releaseIdentitySha256': IDENTITY_SHA, 'baselineSourceSha256': BASE_SHA,
                'assets': origin['assets'], 'metadata': metadata}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(contract, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'sequence': 138, 'buildRunId': str(run['id']),
                      'buildHeadSha': run['head_sha'], 'contract': str(output),
                      'localArtifactName': archive_metadata['name']}))


if __name__ == '__main__':
    main()
