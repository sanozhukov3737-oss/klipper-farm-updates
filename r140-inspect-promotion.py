#!/usr/bin/env python3
"""Bind R140 publication to approved source overlays and the exact Windows candidate."""
import base64
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

FEATURE_SHA = 'f0bedbb970a385d8da1772277a8fbf915feb581b1f932f52fa558ccdf3350a03'
IDENTITY_SHA = '5f632e3efd2e28869f8f6122bf5b5ac8ff1067c9ca80b0a15e9862261bf39019'
BASE_SHA = '125bb78054cb6366242eaf505f2178bdc72f6e916b8888ff001df6a3ade3922e'
BUILD_ID = 'V20.6-R14.0-TV-SPOTLIGHT-2026-10-26'
IDENTITY_PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json',
                  'scripts/build-and-install-windows.mjs', 'scripts/check-r9-clean-installer.mjs',
                  'scripts/check-release-portability.mjs'}
PUBLIC_KEY = '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
REQUIRED_TESTS_SHA = 'd4f5077a0573aa5060ed584b4310fae0f801b757cd05d58d900530dd66af8050'
R140_REQUIRED_TESTS_SHA = 'a90a901d5211fd53d9e526380766ef3a6b8461f9ef96d0a0d550eda5036322eb'
FEATURE_COUNT = int('8')
VERIFIED_COUNT = int('1811')


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


def r140_requirements():
    path = Path(__file__).with_name('r139-required-tests.json')
    assert file_digest(path) == R140_REQUIRED_TESTS_SHA
    value = load_json(path)
    assert value['schemaVersion'] == 1 and value['release'] == 'R139' and value['baseline'] == 'R138'
    assert type(value['expectedRootPassed']) is int and value['expectedRootPassed'] >= 214
    assert value['expectedRootIgnored'] == 2
    tests = value['tests']
    assert isinstance(tests, list) and len(tests) > 0 and len(tests) == len(set(tests))
    assert all(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_:]+', name) for name in tests)
    assert value['expectedRootPassed'] >= 214 + len(tests)
    specs = value['acceptanceReports']
    assert isinstance(specs, list) and len(specs) > 0
    names = set()
    for spec in specs:
        assert set(spec).issubset({'filename', 'count', 'casesField', 'passedField', 'booleanPassed', 'errorFields'})
        assert re.fullmatch(r'r139-[A-Za-z0-9._-]+\.json', spec['filename'])
        assert spec['filename'] not in names
        names.add(spec['filename'])
        assert type(spec['count']) is int and spec['count'] > 0
        assert all(isinstance(spec[key], str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', spec[key]) for key in ['casesField', 'passedField'])
        assert type(spec.get('booleanPassed', False)) is bool
        assert isinstance(spec.get('errorFields', []), list)
        assert all(isinstance(key, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', key) for key in spec.get('errorFields', []))
    return value


def check_new_acceptance_reports(evidence):
    counts = {}
    for spec in r140_requirements()['acceptanceReports']:
        name, count = spec['filename'], spec['count']
        value = report(evidence, name)
        if spec.get('booleanPassed', False):
            assert value[spec['passedField']] is True, name
        else:
            assert type(value[spec['passedField']]) is int and value[spec['passedField']] == count, name
        cases = value[spec['casesField']]
        assert isinstance(cases, list) and len(cases) == count, name
        assert all(case.get('passed') is True if isinstance(case, dict)
                   else isinstance(case, str) and bool(case.strip()) for case in cases), name
        for key in spec.get('errorFields', []):
            assert key in value and value[key] in ([], 0), (name, key)
        counts[name] = count
    return counts


def check_tv_acceptance_reports(evidence, feature):
    counts = {}
    data = report(evidence, 'tv-spotlight-data.json')
    assert type(data['passed']) is int and data['passed'] == 32
    assert len(data['cases']) == 32 and all(case['passed'] is True for case in data['cases'])
    counts['tv-spotlight-data.json'] = 32
    current = report(evidence, 'tv-spotlight-r140-report.json')
    assert type(current['passed']) is int and current['passed'] == 20
    assert len(current['cases']) == 20 and all(case['passed'] is True for case in current['cases'])
    assert current['runtimeErrors'] == [] and current['externalRequests'] == []
    assert current['actualReactComponent'] is True and current['physicalPrintersTested'] is False
    production = {'src/components/TvDashboard.tsx', 'src/components/TvDashboard.css', 'src/lib/tvSpotlight.ts'}
    assert current['productionSources'] == {row['path']: row['sha256'] for row in feature['files'] if row['path'] in production}
    required_current = {'camera-only-current-visible-slide',
                        'failed-camera-fallback-is-remembered-until-retry-or-config-change',
                        'no-webgl-keeps-approved-spool-placeholder-without-alternate-model',
                        'ten-second-autorotation-and-manual-wrap',
                        'inventory-subscription-is-read-only-and-current-usage-is-separate'}
    assert required_current.issubset({case['name'] for case in current['cases']})
    counts['tv-spotlight-r140-report.json'] = 20
    legacy = report(evidence, 'tv-camera-report.json')
    assert type(legacy['passed']) is int and legacy['passed'] == 20
    assert len(legacy['report']) == 20 and all(case['status'] == 'passed' for case in legacy['report'])
    counts['tv-camera-report.json'] = 20
    return counts


def check_build_reports(evidence, feature, identity):
    delta = report(evidence, 'source-delta.json')
    expected = {'release': 'R140', 'baseline': 'R139', 'baseArchiveSha256': BASE_SHA,
                'featurePatchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA,
                'buildId': BUILD_ID, 'baselineFiles': 1806, 'verifiedFiles': VERIFIED_COUNT,
                'reviewedFeatureFiles': FEATURE_COUNT, 'releaseIdentityFiles': 5, 'extraSourceFiles': 0}
    for key, value in expected.items():
        assert delta[key] == value, key
    assert delta['passed'] is True and delta['allOtherSourceBytesPreserved'] is True
    clean = lambda rows: [{k: v for k, v in row.items() if k != 'contentBase64'} for row in rows]
    assert delta['featureFiles'] == clean(feature['files'])
    assert delta['identityFiles'] == clean(identity['files'])
    counts = {}
    for name, count in [('r139-print-start.json', 12), ('r139-sound-core.json', 12),
                        ('r139-auto-retry-core.json', 14), ('r139-native-history-policy.json', 7),
                        ('r139-approved-accounting.json', 7)]:
        value = report(evidence, name)
        assert type(value['passed']) is int and value['passed'] == count, name
        cases = value.get('report', value.get('cases'))
        assert isinstance(cases, list) and len(cases) == count, name
        assert all(case.get('passed', True) is True if isinstance(case, dict)
                   else isinstance(case, str) and bool(case) for case in cases), name
        assert not value.get('runtimeErrors'), name
        counts[name] = count
    for name, count in [('r139-finish-core.json', 8), ('r139-filament-core.json', 9)]:
        value = report(evidence, name)
        assert len(value['cases']) == count and all(case['passed'] is True for case in value['cases']), name
        counts[name] = count
    client = report(evidence, 'r139-client-start-runtime.json')
    assert client['caseCount'] == 38 and client['failures'] == 0
    assert client['nativeBoundaryEmulated'] is True
    assert len(client['cases']) == 38 and all(case['passed'] is True for case in client['cases'])
    counts['r139-client-start-runtime.json'] = 38
    visual = report(evidence, 'r139-visual-activity.json')
    assert visual['passed'] == 10 and len(visual['results']) == 10
    assert all(case['passed'] is True for case in visual['results'])
    counts['r139-visual-activity.json'] = 10
    fresh_counts = check_new_acceptance_reports(evidence)
    assert not set(fresh_counts).intersection(counts), 'Duplicate acceptance report contract'
    counts.update(fresh_counts)
    counts.update(check_tv_acceptance_reports(evidence, feature))
    aggregate = report(evidence, 'r140-tv-acceptance.json')
    for key, expected in {'passed': True, 'featurePatchSha256': FEATURE_SHA,
                          'exactFeatureFilesVerified': FEATURE_COUNT,
                          'filamentProjectionCases': 32, 'spotlightBrowserCases': 20,
                          'existingCameraBrowserCases': 20, 'totalCases': 72,
                          'physicalPrintersTested': False}.items():
        assert aggregate[key] == expected and type(aggregate[key]) is type(expected), key
    assert aggregate['productionSources'] == report(evidence, 'tv-spotlight-r140-report.json')['productionSources']
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
    current = r140_requirements()
    with zipfile.ZipFile(path) as evidence:
        native = archive_bytes(evidence, 'r139-native-tests.log').decode('utf-8-sig')
        native = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', native)
        results = re.findall(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;', native)
        assert results and all(status == 'ok' and failed == '0' for status, _, failed, _ in results)
        assert results.count(('ok', str(current['expectedRootPassed']), '0', '2')) == 1
        assert sum(int(ignored) for _, _, _, ignored in results) == 2
        for marker in ['acknowledged_start_recovers_observation_over_rest_after_ws_failure',
                       'preadmission_disconnected_ws_dispatches_exactly_one_rest_start',
                       'admitted_or_ambiguous_ws_start_is_never_dispatched_again_over_rest',
                       'expired_queued_print_start_never_reaches_the_websocket_wire']:
            assert re.search(re.escape(marker) + r' \.\.\. ok', native), marker
        for marker in required['tests']:
            assert re.search(r'(?m)^test (?:[A-Za-z0-9_]+::)*' + re.escape(marker) + r' \.\.\. ok\s*$', native), marker
        for marker in current['tests']:
            assert re.search(r'(?m)^test (?:[A-Za-z0-9_]+::)*' + re.escape(marker) + r' \.\.\. ok\s*$', native), marker
        counts, delta = check_build_reports(evidence, feature, identity)
    return {'passed': current['expectedRootPassed'], 'failed': 0, 'ignored': 2,
            'requiredBackupTests': required['tests'], 'requiredBackupTestsSha256': REQUIRED_TESTS_SHA,
            'requiredNewTests': current['tests'], 'requiredNewTestsSha256': R140_REQUIRED_TESTS_SHA,
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
    contract = load_json(incoming / 'r140-promotion-contract.json')
    assert contract['schemaVersion'] == 1 and contract['sequence'] == 140
    assert contract['tag'] == 'r140-ota'
    assert contract['repository'] == 'sanozhukov3737-oss/klipper-farm-updates'
    assert contract['patchSha256'] == FEATURE_SHA
    assert contract['releaseIdentitySha256'] == IDENTITY_SHA
    assert contract['baselineSourceSha256'] == BASE_SHA
    assert re.fullmatch('[a-f0-9]{40}', contract['buildHeadSha'])
    assert re.fullmatch('[1-9][0-9]*', str(contract['buildRunId']))
    assert file_digest(feature_path) == FEATURE_SHA and file_digest(identity_path) == IDENTITY_SHA
    feature, identity = load_json(feature_path), load_json(identity_path)
    assert feature['schemaVersion'] == 1 and feature['release'] == 'R140-TV-DRAFT'
    assert feature['baseline'] == 'R139'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == 582356862
    assert feature['archivePrefix'] == 'Klipper-Farm-R139/'
    assert len(identity['baselineFiles']) == 1806 and len(feature['files']) == FEATURE_COUNT
    assert len({row['path'] for row in feature['files']}) == FEATURE_COUNT
    assert identity['release'] == 'R140' and identity['baseline'] == 'R139'
    assert identity['sequence'] == 140 and identity['buildId'] == BUILD_ID
    assert identity['baseArchiveSha256'] == BASE_SHA and identity['baseArchiveSize'] == 582356862
    assert identity['archivePrefix'] == 'Klipper-Farm-R139/'
    assert identity['featurePatchSha256'] == FEATURE_SHA and len(identity['files']) == 5
    assert {row['path'] for row in identity['files']} == IDENTITY_PATHS
    assert not IDENTITY_PATHS.intersection(row['path'] for row in feature['files'])
    provenance = load_json(incoming / 'provenance.json')
    for key, expected in {'release': 'R140', 'sequence': 140, 'baselineSequence': 139,
                          'buildId': BUILD_ID, 'headSha': contract['buildHeadSha'],
                          'patchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA}.items():
        assert provenance[key] == expected, key
    assert str(provenance['runId']) == str(contract['buildRunId'])
    assert provenance['assets'] == contract['assets']
    validation = load_json(incoming / 'exact-validation.json')
    for key, expected in {'release': 'R140', 'installedSequence': 140, 'upgradeFrom': 139,
                          'headSha': contract['buildHeadSha']}.items():
        assert validation[key] == expected, key
    assert str(validation['runId']) == str(contract['buildRunId'])
    if 'buildRunId' in validation:
        assert str(validation['buildRunId']) == str(contract['buildRunId'])
    for flag in ['passed', 'cleanInstallVerified', 'embeddedUpdateChannelVerified', 'exactInstallerPayloadVerified',
                 'installedBinaryHashesMatch', 'desktopWebViewLoaded', 'legacyDataPreserved',
                 'printerConfigurationPreserved', 'filamentInventoryPreserved', 'costSettingsPreserved', 'installedRestartVerified']:
        assert validation[flag] is True, flag
    assert set(contract['assets']) == {'Klipper-Farm-R140-setup.exe', 'KF-R140-FULL.zip'}
    for name, expected in contract['assets'].items():
        target = incoming / name
        assert target.stat().st_size == expected['sizeBytes'] and file_digest(target) == expected['sha256'], name
    baseline = incoming / 'KF-R139-FULL.zip'
    assert baseline.stat().st_size == 582356862 and file_digest(baseline) == BASE_SHA
    native, build_counts, build_delta = check_native_evidence(incoming / 'build-evidence.zip', contract, feature, identity)
    with zipfile.ZipFile(incoming / 'KF-R140-FULL.zip') as source, zipfile.ZipFile(baseline) as original:
        prefix = 'Klipper-Farm-R140/'
        current, before = inventory(source, prefix), inventory(original, 'Klipper-Farm-R139/')
        source_bytes = lambda name: source.read(prefix + name)
        assert set(before) == set(identity['baselineFiles'])
        for name, entry in before.items():
            assert digest(original.read(entry)) == identity['baselineFiles'][name], name
        expected = dict(identity['baselineFiles'])
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
            'publicKeyHex': PUBLIC_KEY, 'channel': 'stable', 'installedSequence': 140}
        assert source_bytes('RELEASE-BUILD-ID.txt').decode().strip() == BUILD_ID
        assert digest(source_bytes('src/lib/spool-viewer.mjs')) == identity['baselineFiles']['src/lib/spool-viewer.mjs']
    with zipfile.ZipFile(incoming / 'R140-UI-proof.zip') as evidence:
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
        for flag in ['staleCommandRejected', 'offlineMemberIsolation', 'freshTelemetryAllHealthy', 'duplicatePhysicalAddressRejected']:
            assert runtime[flag] is True, flag
        payload = report(evidence, 'installed-payload.json')
        assert payload == report(evidence, 'installed-payload-after-restart.json')
        clean_payload = report(evidence, 'clean-installed-payload.json')
        assert clean_payload == payload, 'Clean-installed bytes differ from upgraded bytes'
        assert payload['passed'] is True and payload['comparison'] == 'nsis-extracted-exact-v1'
        assert payload['installedSequence'] == 140 and payload['embeddedUpdateChannelVerified'] is True
        assert set(payload['binaries']) == {'klipper-farm-client.exe', 'klipper-farmd.exe'}
        for binary in payload['binaries'].values():
            assert binary['expectedInstalledSha256'] == binary['installedSha256'] == binary['packagedSha256']
        markers = [name for name in evidence.namelist() if '/smoke/' in '/' + name.replace('\\', '/')
                   and PurePosixPath(name.replace('\\', '/')).name.startswith('desktop-startup-smoke-client-') and name.endswith('.json')]
        assert len(markers) >= 3
        clean_markers = [name for name in evidence.namelist() if '/clean-smoke/' in '/' + name.replace('\\', '/')
                         and PurePosixPath(name.replace('\\', '/')).name.startswith('desktop-startup-smoke-client-') and name.endswith('.json')]
        assert len(clean_markers) >= 1, 'Missing actual clean installation WebView proof'
        for name in markers + clean_markers:
            marker = json.loads(evidence.read(name).decode('utf-8-sig'))
            assert marker['schemaVersion'] == 1 and marker['binary'] == 'klipper-farm-client'
            assert marker['windowLabel'] == 'main' and marker['pageLoad'] == 'finished'
            assert marker['executableFile'].lower() == 'klipper-farm-client.exe'
            assert marker['pid'] > 0 and marker['createdAtMs'] > 0
    result = {'passed': True, 'release': 'R140', 'reviewedFileCount': FEATURE_COUNT, 'releaseIdentityFileCount': 5,
              'runId': str(contract['buildRunId']), 'headSha': contract['buildHeadSha'],
              'patchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA,
              'exactPublishedSourceMatchesReviewedPatch': True,
              'unreviewedSourcePreservationVerifiedBeforeAndAfterBuild': True,
              'unchangedSourceFiles': unchanged, 'completeSourceManifestVerified': True,
              'installedSequence': 140, 'embeddedUpdateChannelVerified': True,
              'buildId': BUILD_ID, 'acceptanceCases': counts, 'nativeTests': native,
              'realSQLitePrinterConfigurations': 7, 'legacySpools': 2,
              'cleanInstallVerified': True, 'installedCostSettingsPreserved': True, 'installedUpgradeAndRestartDataPreserved': True, 'desktopWebViewMarkers': len(markers) + len(clean_markers),
              'nativeRuntimeEmulatorVerified': True, 'exactInstalledNsisPayloadVerified': True,
              'installedBinaries': payload['binaries'], 'physicalPrinterTested': False,
              'scope': 'Windows runner: actual installed WebView, native processes, clean installation, upgrade/restart and local printer emulators. Current R140 acceptance reports are pinned by the reviewed native and acceptance contract; physical printers were not tested.'}
    (incoming / 'source-inspection.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
