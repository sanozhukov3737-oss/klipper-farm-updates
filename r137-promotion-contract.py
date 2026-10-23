#!/usr/bin/env python3
"""Generate a real R137 contract from successful CI metadata and downloaded artifact bytes.

Usage: python r137-promotion-contract.py INCOMING_DIRECTORY OUTPUT_CONTRACT_JSON
Accepts validated-artifact.zip or reviewed-installer.zip plus its API metadata.
The latter binds the exact installer locally; promotion CI still verifies the full
five-file validated artifact and source/installed proof before publication.
"""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

REPOSITORY = 'sanozhukov3737-oss/klipper-farm-updates'
PATCH_SHA = '3a78d401483a3ab5b0c6f9f9f3262bc12ebbfb019551a9bf49b83c9c5dfc20d5'
IDENTITY_SHA = 'c4dc52f44ef0853c45712ffd9d787d05e6f5af7b7a1d72445c749470fa9edf41'
BASE_SHA = '78a89704a083466a863085c0bc6a9c5317041212327c8e7e1393b7e914e9fd3f'
BUILD_ID = 'V20.6-R13.7-BACKUP-RETENTION-2026-10-23'
BUILD_RUN_ID = '39974599528'
BUILD_HEAD_SHA = 'be1e4820abcfb781b9785020370001ddb41378b2'
BUILD_JOB_ID = '120485787116'
EXPECTED = {'Klipper-Farm-R137-setup.exe', 'KF-R137-FULL.zip', 'R137-UI-proof.zip', 'provenance.json', 'exact-validation.json'}
REVIEWED_EXPECTED = {'Klipper-Farm-R137-setup.exe', 'provenance.json', 'exact-validation.json'}


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
    # The compiled build job succeeded. Its original validation failed before
    # R137 installation, so an independent successful validation is mandatory.
    assert str(run['id']) == BUILD_RUN_ID and run['head_sha'] == BUILD_HEAD_SHA
    assert run['status'] == 'completed' and run['conclusion'] == 'failure'
    assert run['head_branch'] == 'r137-backup-retention' and run['event'] == 'push'
    assert run['path'] == '.github/workflows/windows-r137-reviewed.yml'
    assert re.fullmatch('[a-f0-9]{40}', run['head_sha'])
    if 'repository' in run:
        assert run['repository']['full_name'] == REPOSITORY
    validation_run = load(incoming / 'validation-run.json')
    assert str(validation_run['id']) != BUILD_RUN_ID
    assert validation_run['status'] == 'completed' and validation_run['conclusion'] == 'success'
    assert validation_run['head_branch'] == 'r137-backup-retention' and validation_run['event'] == 'push'
    assert validation_run['path'] == '.github/workflows/validate-r137-exact.yml'
    assert re.fullmatch('[a-f0-9]{40}', validation_run['head_sha'])
    if 'repository' in validation_run:
        assert validation_run['repository']['full_name'] == REPOSITORY
    jobs = load(incoming / 'build-jobs.json')['jobs']
    validation_jobs = load(incoming / 'validation-jobs.json')['jobs']
    job_ids = {}
    for name in ['build', 'validate']:
        source_jobs = jobs if name == 'build' else validation_jobs
        selected = [job for job in source_jobs if job['name'] == name]
        assert len(selected) == 1, name
        job = selected[0]
        expected_run = run if name == 'build' else validation_run
        assert str(job['run_id']) == str(expected_run['id']) and job['head_sha'] == expected_run['head_sha'], name
        assert job['status'] == 'completed' and job['conclusion'] == 'success', name
        assert len(job['steps']) > 2 and all(step['conclusion'] == 'success' for step in job['steps'] if not step['name'].startswith('Post ')), name
        job_ids[name] = str(job['id'])
    assert job_ids['build'] == BUILD_JOB_ID
    artifact = artifact_metadata(incoming, 'source-artifact.json', 'r137-ota-validated', validation_run)
    evidence = artifact_metadata(incoming, 'build-evidence-artifact.json', 'r137-ota-build-evidence', run)
    archive, archive_metadata, expected_names = incoming / 'validated-artifact.zip', artifact, EXPECTED
    if not archive.exists():
        archive = incoming / 'reviewed-installer.zip'
        archive_metadata = artifact_metadata(incoming, 'reviewed-installer-artifact.json', 'r137-reviewed-installer', validation_run)
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
            elif info.filename != 'R137-UI-proof.zip':
                pins[info.filename] = pin
        origin = json.loads(bundle.read('provenance.json').decode('utf-8-sig'))
        validation = json.loads(bundle.read('exact-validation.json').decode('utf-8-sig'))
    for key, expected in {'release': 'R137', 'sequence': 137, 'baselineSequence': 136,
                          'buildId': BUILD_ID, 'patchSha256': PATCH_SHA,
                          'releaseIdentitySha256': IDENTITY_SHA, 'headSha': run['head_sha']}.items():
        assert origin[key] == expected, key
    assert str(origin['runId']) == str(run['id'])
    assert set(origin['assets']) == {'Klipper-Farm-R137-setup.exe', 'KF-R137-FULL.zip'}
    for name, pin in origin['assets'].items():
        assert set(pin) == {'sha256', 'sizeBytes'}
        assert re.fullmatch('[a-f0-9]{64}', pin['sha256']) and type(pin['sizeBytes']) is int and pin['sizeBytes'] > 0
        if name in pins:
            assert pin == pins[name], name
    assert 'Klipper-Farm-R137-setup.exe' in pins
    for key, expected in {'release': 'R137', 'installedSequence': 137, 'upgradeFrom': 136,
                          'headSha': validation_run['head_sha'], 'buildHeadSha': BUILD_HEAD_SHA}.items():
        assert validation[key] == expected, key
    assert str(validation['runId']) == str(validation_run['id'])
    assert str(validation['buildRunId']) == BUILD_RUN_ID
    for flag in ['passed', 'exactInstallerPayloadVerified', 'installedBinaryHashesMatch', 'desktopWebViewLoaded',
                 'legacyDataPreserved', 'printerConfigurationPreserved', 'filamentInventoryPreserved',
                 'costSettingsPreserved', 'installedRestartVerified', 'embeddedUpdateChannelVerified']:
        assert validation[flag] is True, flag
    contract = {'schemaVersion': 1, 'repository': REPOSITORY, 'sequence': 137, 'tag': 'r137-ota',
                'buildRunId': str(run['id']), 'buildHeadSha': run['head_sha'],
                'buildWorkflowSha256': digest(incoming / 'build-workflow.yml'), 'jobs': job_ids,
                'validationRunId': str(validation_run['id']), 'validationHeadSha': validation_run['head_sha'],
                'validationWorkflowSha256': digest(incoming / 'validation-workflow.yml'),
                'sourceArtifactId': str(artifact['id']), 'sourceArtifactDigest': artifact['digest'],
                'sourceArtifactSizeBytes': artifact['size_in_bytes'],
                'buildEvidenceArtifactId': str(evidence['id']), 'buildEvidenceArtifactDigest': evidence['digest'],
                'buildEvidenceArtifactSizeBytes': evidence_zip.stat().st_size,
                'patchSha256': PATCH_SHA, 'releaseIdentitySha256': IDENTITY_SHA, 'baselineSourceSha256': BASE_SHA,
                'assets': origin['assets'], 'metadata': metadata}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(contract, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'sequence': 137, 'buildRunId': str(run['id']),
                      'buildHeadSha': run['head_sha'], 'validationRunId': str(validation_run['id']),
                      'validationHeadSha': validation_run['head_sha'],
                      'contract': str(output), 'localArtifactName': archive_metadata['name']}))


if __name__ == '__main__':
    main()
