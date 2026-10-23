#!/usr/bin/env python3
"""Bind R137 publication to approved source overlays and the exact Windows candidate."""
import base64
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

FEATURE_SHA = '3a78d401483a3ab5b0c6f9f9f3262bc12ebbfb019551a9bf49b83c9c5dfc20d5'
IDENTITY_SHA = 'c4dc52f44ef0853c45712ffd9d787d05e6f5af7b7a1d72445c749470fa9edf41'
BASE_SHA = '78a89704a083466a863085c0bc6a9c5317041212327c8e7e1393b7e914e9fd3f'
BUILD_ID = 'V20.6-R13.7-BACKUP-RETENTION-2026-10-23'
IDENTITY_PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json',
                  'scripts/build-and-install-windows.mjs', 'scripts/check-r9-clean-installer.mjs',
                  'scripts/check-release-portability.mjs'}
PUBLIC_KEY = '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
REQUIRED_TESTS_SHA = 'd4f5077a0573aa5060ed584b4310fae0f801b757cd05d58d900530dd66af8050'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def archive_bytes(archive, name):
    matches = [p for p in archive.namelist()
               if p.replace('\\', '/').endswith('/' + name) or p == name]
    assert len(matches) == 1, (name, matches)
    return archive.read(matches[0])


def report(archive, name):
    return json.loads(archive_bytes(archive, name).decode('utf-8-sig'))


def check_build_reports(evidence, feature, identity):
    delta = report(evidence, 'source-delta.json')
    expected = {'release': 'R137', 'baseline': 'R136', 'baseArchiveSha256': BASE_SHA,
                'featurePatchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA,
                'buildId': BUILD_ID, 'baselineFiles': 1786, 'verifiedFiles': 1786,
                'reviewedFeatureFiles': 2, 'releaseIdentityFiles': 5, 'extraSourceFiles': 0}
    for key, value in expected.items():
        assert delta[key] == value, key
    assert delta['passed'] is True and delta['allOtherSourceBytesPreserved'] is True
    clean = lambda rows: [{k: v for k, v in row.items() if k != 'contentBase64'} for row in rows]
    assert delta['featureFiles'] == clean(feature['files'])
    assert delta['identityFiles'] == clean(identity['files'])
    counts = {}
    for name, count in [('r137-print-start.json', 12), ('r137-sound-core.json', 12),
                        ('r137-auto-retry-core.json', 14), ('r137-native-history-policy.json', 7),
                        ('r137-approved-accounting.json', 7), ('auto-accounting-browser-report.json', 15),
                        ('single-spool-page-report.json', 7), ('r135-graphite-layout-report.json', 24),
                        ('r136-review-report.json', 29)]:
        value = report(evidence, name)
        assert type(value['passed']) is int and value['passed'] == count, name
        cases = value.get('report', value.get('cases'))
        assert isinstance(cases, list) and len(cases) == count, name
        assert all(case.get('passed', True) is True if isinstance(case, dict)
                   else isinstance(case, str) and bool(case) for case in cases), name
        assert not value.get('runtimeErrors'), name
        counts[name] = count
        if name == 'r136-review-report.json':
            assert value['blueAccentsVerified'] is True, name
    for name, count in [('r137-finish-core.json', 8), ('r137-filament-core.json', 9)]:
        value = report(evidence, name)
        assert len(value['cases']) == count and all(case['passed'] is True for case in value['cases']), name
        counts[name] = count
    client = report(evidence, 'r137-client-start-runtime.json')
    assert client['caseCount'] == 38 and client['failures'] == 0
    assert client['nativeBoundaryEmulated'] is True
    assert len(client['cases']) == 38 and all(case['passed'] is True for case in client['cases'])
    counts['r137-client-start-runtime.json'] = 38
    return counts, delta


def check_native_evidence(path, contract, feature, identity):
    assert path.stat().st_size == contract['buildEvidenceArtifactSizeBytes']
    assert 'sha256:' + file_digest(path) == contract['buildEvidenceArtifactDigest']
    required_path = Path(__file__).with_name('r137-required-tests.json')
    assert file_digest(required_path) == REQUIRED_TESTS_SHA
    required = load_json(required_path)
    assert required['schemaVersion'] == 1 and required['release'] == 'R137' and required['baseline'] == 'R136'
    assert required['expectedRootPassed'] == 214 and required['expectedRootIgnored'] == 2
    assert len(required['tests']) == len(set(required['tests'])) == 11
    with zipfile.ZipFile(path) as evidence:
        native = archive_bytes(evidence, 'r137-native-tests.log').decode('utf-8-sig')
        native = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', native)
        results = re.findall(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;', native)
        assert results and all(status == 'ok' and failed == '0' for status, _, failed, _ in results)
        assert results.count(('ok', '214', '0', '2')) == 1
        assert sum(int(ignored) for _, _, _, ignored in results) == 2
        for marker in ['acknowledged_start_recovers_observation_over_rest_after_ws_failure',
                       'preadmission_disconnected_ws_dispatches_exactly_one_rest_start',
                       'admitted_or_ambiguous_ws_start_is_never_dispatched_again_over_rest',
                       'expired_queued_print_start_never_reaches_the_websocket_wire']:
            assert re.search(re.escape(marker) + r' \.\.\. ok', native), marker
        for marker in required['tests']:
            assert re.search(r'(?m)^test (?:[A-Za-z0-9_]+::)*' + re.escape(marker) + r' \.\.\. ok\s*$', native), marker
        counts, delta = check_build_reports(evidence, feature, identity)
    return {'passed': 214, 'failed': 0, 'ignored': 2,
            'requiredBackupTests': required['tests'], 'requiredBackupTestsSha256': REQUIRED_TESTS_SHA,
            'backupRetentionRegressionsVerified': True,
            'fourNativeStartWireRegressionsVerified': True}, counts, delta


def inventory(archive, prefix):
    files = {}
    for entry in archive.infolist():
        assert entry.filename.startswith(prefix), entry.filename
        name = entry.filename.removeprefix(prefix)
        if not name or entry.is_dir():
            continue
        parts = PurePosixPath(name).parts
        assert not PurePosixPath(name).is_absolute() and '..' not in parts
        assert '\\' not in name and ':' not in name and name not in files
        assert (entry.external_attr >> 16) & 0o170000 != 0o120000
        files[name] = entry
    return files


def main():
    incoming, feature_path, identity_path = map(Path, sys.argv[1:])
    contract = load_json(incoming / 'r137-promotion-contract.json')
    assert contract['schemaVersion'] == 1 and contract['sequence'] == 137
    assert contract['tag'] == 'r137-ota'
    assert contract['repository'] == 'sanozhukov3737-oss/klipper-farm-updates'
    assert contract['patchSha256'] == FEATURE_SHA
    assert contract['releaseIdentitySha256'] == IDENTITY_SHA
    assert contract['baselineSourceSha256'] == BASE_SHA
    assert str(contract['buildRunId']) == '39974599528'
    assert contract['buildHeadSha'] == 'be1e4820abcfb781b9785020370001ddb41378b2'
    assert str(contract['jobs']['build']) == '120485787116'
    assert str(contract['validationRunId']) != str(contract['buildRunId'])
    assert re.fullmatch('[a-f0-9]{40}', contract['validationHeadSha'])
    assert file_digest(feature_path) == FEATURE_SHA and file_digest(identity_path) == IDENTITY_SHA
    feature, identity = load_json(feature_path), load_json(identity_path)
    assert feature['schemaVersion'] == 1 and feature['release'] == 'R137'
    assert feature['baseline'] == 'R136'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == 582278200
    assert feature['archivePrefix'] == 'Klipper-Farm-R136/'
    assert len(feature['baselineFiles']) == 1786 and len(feature['files']) == 2
    assert len({row['path'] for row in feature['files']}) == 2
    assert identity['release'] == 'R137' and identity['baseline'] == 'R136'
    assert identity['sequence'] == 137 and identity['buildId'] == BUILD_ID
    assert identity['featurePatchSha256'] == FEATURE_SHA and len(identity['files']) == 5
    assert {row['path'] for row in identity['files']} == IDENTITY_PATHS
    assert not IDENTITY_PATHS.intersection(row['path'] for row in feature['files'])
    provenance = load_json(incoming / 'provenance.json')
    for key, expected in {'release': 'R137', 'sequence': 137, 'baselineSequence': 136,
                          'buildId': BUILD_ID, 'headSha': contract['buildHeadSha'],
                          'patchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA}.items():
        assert provenance[key] == expected, key
    assert str(provenance['runId']) == str(contract['buildRunId'])
    assert provenance['assets'] == contract['assets']
    validation = load_json(incoming / 'exact-validation.json')
    for key, expected in {'release': 'R137', 'installedSequence': 137, 'upgradeFrom': 136,
                          'headSha': contract['validationHeadSha'],
                          'buildHeadSha': contract['buildHeadSha']}.items():
        assert validation[key] == expected, key
    assert str(validation['runId']) == str(contract['validationRunId'])
    assert str(validation['buildRunId']) == str(contract['buildRunId'])
    for flag in ['passed', 'embeddedUpdateChannelVerified', 'exactInstallerPayloadVerified',
                 'installedBinaryHashesMatch', 'desktopWebViewLoaded', 'legacyDataPreserved',
                 'printerConfigurationPreserved', 'filamentInventoryPreserved', 'costSettingsPreserved', 'installedRestartVerified']:
        assert validation[flag] is True, flag
    assert set(contract['assets']) == {'Klipper-Farm-R137-setup.exe', 'KF-R137-FULL.zip'}
    for name, expected in contract['assets'].items():
        target = incoming / name
        assert target.stat().st_size == expected['sizeBytes'] and file_digest(target) == expected['sha256'], name
    baseline = incoming / 'KF-R136-FULL.zip'
    assert baseline.stat().st_size == 582278200 and file_digest(baseline) == BASE_SHA
    native, build_counts, build_delta = check_native_evidence(incoming / 'build-evidence.zip', contract, feature, identity)
    with zipfile.ZipFile(incoming / 'KF-R137-FULL.zip') as source, zipfile.ZipFile(baseline) as original:
        prefix = 'Klipper-Farm-R137/'
        current, before = inventory(source, prefix), inventory(original, 'Klipper-Farm-R136/')
        source_bytes = lambda name: source.read(prefix + name)
        assert set(before) == set(feature['baselineFiles'])
        for name, entry in before.items():
            assert digest(original.read(entry)) == feature['baselineFiles'][name], name
        expected = dict(feature['baselineFiles'])
        for rows in [feature['files'], identity['files']]:
            for row in rows:
                name = row['path']
                assert row['beforeSha256'] == expected.get(name), name
                data = base64.b64decode(row['contentBase64'], validate=True)
                assert digest(data) == row['sha256'] and source_bytes(name) == data, name
                expected[name] = row['sha256']
        generated = {'DIST-V20-LOCK.json', 'MANIFEST-SHA256.txt', 'OFFLINE-PAYLOAD-SHA256.txt'}
        regenerated = lambda name: name.startswith('dist/') or name in generated
        assert {name for name in current if not regenerated(name)} == {name for name in expected if not regenerated(name)}
        unchanged = 0
        changed = {row['path'] for row in feature['files'] + identity['files']}
        for name, wanted in expected.items():
            if regenerated(name):
                continue
            assert digest(source_bytes(name)) == wanted, name
            unchanged += name not in changed
        manifest = {}
        for line in source_bytes('MANIFEST-SHA256.txt').decode().splitlines():
            if not line.strip() or line.startswith('#'):
                continue
            wanted, name = line.split(' *', 1)
            assert name not in manifest and name in current
            assert digest(source_bytes(name)) == wanted, name
            manifest[name] = wanted
        assert set(manifest) == set(current) - {'MANIFEST-SHA256.txt'}
        assert json.loads(source_bytes('UPDATE-CHANNEL.json')) == {
            'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json',
            'publicKeyHex': PUBLIC_KEY, 'channel': 'stable', 'installedSequence': 137}
        assert source_bytes('RELEASE-BUILD-ID.txt').decode().strip() == BUILD_ID
        assert digest(source_bytes('src/lib/spool-viewer.mjs')) == feature['baselineFiles']['src/lib/spool-viewer.mjs']
    with zipfile.ZipFile(incoming / 'R137-UI-proof.zip') as evidence:
        counts, delta = check_build_reports(evidence, feature, identity)
        assert counts == build_counts and delta == build_delta
        seed = report(evidence, 'upgrade-data-seed.json')
        assert seed['passed'] is True and seed['mode'] == 'seed'
        for name in ['upgrade-data-preserved.json', 'upgrade-data-after-restart.json']:
            value = report(evidence, name)
            assert value['passed'] is True and value['mode'] == 'verify'
            assert value['printerCount'] == 7 and value['spoolCount'] == 2
            assert value['sqliteIntegrity'] == 'ok' and value['rows'] == seed['rows']
            for flag in ['printerConfigurationBytesPreserved', 'legacySpoolBytesPreserved',
                         'filamentInventoryBytesPreserved', 'materialReserveAndUsagePreserved', 'costSettingsBytesPreserved']:
                assert value[flag] is True, flag
        runtime = report(evidence, 'headless-runtime.json')
        assert runtime['passed'] is True and runtime['registeredPrinters'] == 7
        for flag in ['staleCommandRejected', 'offlineMemberIsolation', 'freshTelemetryAllHealthy']:
            assert runtime[flag] is True, flag
        payload = report(evidence, 'installed-payload.json')
        assert payload == report(evidence, 'installed-payload-after-restart.json')
        assert payload['passed'] is True and payload['comparison'] == 'nsis-extracted-exact-v1'
        assert payload['installedSequence'] == 137 and payload['embeddedUpdateChannelVerified'] is True
        assert set(payload['binaries']) == {'klipper-farm-client.exe', 'klipper-farmd.exe'}
        for binary in payload['binaries'].values():
            assert binary['expectedInstalledSha256'] == binary['installedSha256'] == binary['packagedSha256']
        markers = [name for name in evidence.namelist() if '/smoke/' in '/' + name.replace('\\', '/')
                   and PurePosixPath(name.replace('\\', '/')).name.startswith('desktop-startup-smoke-client-') and name.endswith('.json')]
        assert len(markers) >= 3
        for name in markers:
            marker = json.loads(evidence.read(name).decode('utf-8-sig'))
            assert marker['schemaVersion'] == 1 and marker['binary'] == 'klipper-farm-client'
            assert marker['windowLabel'] == 'main' and marker['pageLoad'] == 'finished'
            assert marker['executableFile'].lower() == 'klipper-farm-client.exe'
            assert marker['pid'] > 0 and marker['createdAtMs'] > 0
    result = {'passed': True, 'release': 'R137', 'reviewedFileCount': 2, 'releaseIdentityFileCount': 5,
              'runId': str(contract['buildRunId']), 'headSha': contract['buildHeadSha'],
              'validationRunId': str(contract['validationRunId']), 'validationHeadSha': contract['validationHeadSha'],
              'patchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA,
              'exactPublishedSourceMatchesReviewedPatch': True,
              'unreviewedSourcePreservationVerifiedBeforeAndAfterBuild': True,
              'unchangedSourceFiles': unchanged, 'completeSourceManifestVerified': True,
              'installedSequence': 137, 'embeddedUpdateChannelVerified': True,
              'buildId': BUILD_ID, 'acceptanceCases': counts, 'nativeTests': native,
              'realSQLitePrinterConfigurations': 7, 'legacySpools': 2,
              'installedCostSettingsPreserved': True, 'installedUpgradeAndRestartDataPreserved': True, 'desktopWebViewMarkers': len(markers),
              'nativeRuntimeEmulatorVerified': True, 'exactInstalledNsisPayloadVerified': True,
              'installedBinaries': payload['binaries'], 'physicalPrinterTested': False,
              'scope': 'Windows runner; production Edge UI, native processes and local printer emulators. Physical printers were not tested.'}
    (incoming / 'source-inspection.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
