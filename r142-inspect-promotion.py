#!/usr/bin/env python3
"""Bind R142 publication to approved source overlays and the exact Windows candidate."""
import base64
import hashlib
import json
import shutil
import subprocess
import tempfile
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

FEATURE_SHA = 'f78f37f93f8b72e38d8f54ae574a97c47dc8fc511ed28fed58c33aab4e96cfc9'
IDENTITY_SHA = '9e6553aac3e0e6468cfff058d24be0b5131919a0e29b23185d24b53fc4ff8812'
BASE_SHA = 'abf4ffe061e203237f921b11f624ae04f821587d6fcf5410f83b4d28ba114878'
BUILD_ID = 'V20.6-R14.2-GRAPHITE-FILES-2026-10-27'
IDENTITY_PATHS = {'RELEASE-BUILD-ID.txt', 'UPDATE-CHANNEL.json',
                  'scripts/build-and-install-windows.mjs', 'scripts/check-r9-clean-installer.mjs',
                  'scripts/check-release-portability.mjs'}
PUBLIC_KEY = '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
REQUIRED_TESTS_SHA = 'd4f5077a0573aa5060ed584b4310fae0f801b757cd05d58d900530dd66af8050'
BASELINE_REQUIRED_TESTS_SHA = 'a90a901d5211fd53d9e526380766ef3a6b8461f9ef96d0a0d550eda5036322eb'
FEATURE_COUNT = 2
VERIFIED_COUNT = 1856
R142_REQUIREMENTS_SHA = '2fad3b15c11c24167f88c4bfd1d96b4938b5741a9a8b71218cd74bd2093d6623'
R142_CHECKER_SHA = 'fa7e077beaba123ea31d8c984d9a498489ce626abf5a7983dcd5be6e9b7e5dc5'
FULLSCREEN_CASES = {
    'borrowed-native-fullscreen-arrows-X-preserves-host',
    'maximized-owned-fullscreen-X-restores-maximized',
    'normal-owned-fullscreen-X-restores-bounds',
    'normal-owned-fullscreen-Escape-restores-bounds',
    'reopen-after-Escape-X-restores-bounds',
}


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


def baseline_requirements():
    path = Path(__file__).with_name('r139-required-tests.json')
    assert file_digest(path) == BASELINE_REQUIRED_TESTS_SHA
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


def r142_requirements():
    path = Path(__file__).with_name('r142-required-tests.json')
    assert file_digest(path) == R142_REQUIREMENTS_SHA
    value = load_json(path)
    assert value['schemaVersion'] == 1 and value['release'] == 'R142' and value['baseline'] == 'R141'
    assert value['expectedRootPassed'] == 232 and value['expectedRootIgnored'] == 2
    assert len(value['newTests']) == len(set(value['newTests'])) == 0
    assert len(value['tests']) == len(set(value['tests'])) == 33
    return value


def check_new_acceptance_reports(evidence):
    counts = {}
    for spec in baseline_requirements()['acceptanceReports']:
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
    assert current['productionSources'] == ({name: feature['baselineFiles'][name] for name in production} | {row['path']: row['sha256'] for row in feature['files'] if row['path'] in production})
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
    expected = {'release': 'R142', 'baseline': 'R141', 'baseArchiveSha256': BASE_SHA,
                'featurePatchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA,
                'buildId': BUILD_ID, 'baselineFiles': 1856, 'verifiedFiles': VERIFIED_COUNT,
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
    current = r142_requirements()
    with zipfile.ZipFile(path) as evidence:
        native = archive_bytes(evidence, 'r142-native-tests.log').decode('utf-8-sig')
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
            'requiredNewTests': current['tests'], 'requiredNewTestsSha256': R142_REQUIREMENTS_SHA,
            'requiredR142Tests': current['newTests'],
            'backupRetentionRegressionsVerified': True,
            'fourNativeStartWireRegressionsVerified': True}, counts, delta


def inventory(archive, prefix):
    files = {}
    for entry in archive.infolist():
        assert entry.filename.startswith(prefix), entry.filename
        name = entry.filename.removeprefix(prefix)
        assert (entry.external_attr >> 16) & 0o170000 != 0o120000
        if not name or entry.is_dir():
            continue
        parts = PurePosixPath(name).parts
        assert not PurePosixPath(name).is_absolute() and '..' not in parts
        assert '\\' not in name and ':' not in name and name not in files
        assert (entry.external_attr >> 16) & 0o170000 != 0o120000
        files[name] = entry
    return files


def extract_verified_entries(archive, entries, directory):
    seen = set()
    for name, entry in entries.items():
        parts = name.split('/')
        assert all(part not in ('', '.', '..') for part in parts), name
        assert not PurePosixPath(name).is_absolute() and '\\' not in name and ':' not in name, name
        assert name.casefold() not in seen, f'Case-colliding archive path: {name}'
        seen.add(name.casefold())
        assert not entry.is_dir() and (entry.external_attr >> 16) & 0o170000 != 0o120000, name
        destination = directory.joinpath(*parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with archive.open(entry) as source, destination.open('xb') as target:
            shutil.copyfileobj(source, target)


def check_r142_acceptance(path, source_root, feature_path, identity_path, contract):
    requirements_path = Path(__file__).with_name('r142-required-tests.json')
    checker = Path(__file__).with_name('r142-build') / 'check-r142-acceptance.py'
    assert file_digest(requirements_path) == R142_REQUIREMENTS_SHA
    assert file_digest(checker) == R142_CHECKER_SHA
    with tempfile.TemporaryDirectory(prefix='kf-r142-proof-') as temporary:
        directory = Path(temporary)
        with zipfile.ZipFile(path) as archive:
            extract_verified_entries(archive, inventory(archive, ''), directory)
        aggregates = list(directory.rglob('r142-acceptance.json'))
        native_logs = list(directory.rglob('r142-native-tests.log'))
        assert len(aggregates) == len(native_logs) == 1, 'Missing or ambiguous R142 aggregate/native log'
        aggregate = load_json(aggregates[0])
        recomputed = directory / 'recomputed-r142-acceptance.json'
        completed = subprocess.run([
            sys.executable, str(checker), str(requirements_path),
            '--source-root', str(source_root), '--proof-directory', str(aggregates[0].parent),
            '--patch', str(feature_path), '--identity', str(identity_path),
            '--native-log', str(native_logs[0]), '--output', str(recomputed),
            '--build-run-id', str(contract['buildRunId']), '--build-head-sha', contract['buildHeadSha'],
        ], capture_output=True, text=True, encoding='utf-8')
        assert completed.returncode == 0, (completed.stderr + completed.stdout)[-8000:]
        assert load_json(recomputed) == aggregate, 'Stored R142 aggregate differs from independently recomputed proof'
    return aggregate


def check_installed_fullscreen(evidence):
    value = report(evidence, 'installed-fullscreen-report.json')
    assert value['schemaVersion'] == 1 and value['release'] == 'R142'
    assert value['passed'] is True and type(value['passedCases']) is int and value['passedCases'] == 5
    assert value['configuredPrinters'] == 7
    for flag in ['actualInstalledWebView', 'actualWindowsWindowManager', 'actualFullscreenStateVerified', 'nativeWindowCallsReal', 'domFullscreenNeverUsed']:
        assert value[flag] is True, flag
    assert value['runtimeErrors'] == [] and value['physicalPrintersTested'] is False
    assert type(value['client']['pid']) is int and value['client']['pid'] > 0
    assert re.fullmatch('[a-f0-9]{64}', value['client']['sha256'])
    window_helper = Path(__file__).with_name('r142-build') / 'check-r142-installed-fullscreen-window.ps1'
    assert value['windowHelperSha256'] == file_digest(window_helper)
    assert len(value['cases']) == 5 and {case['id'] for case in value['cases']} == FULLSCREEN_CASES
    for case in value['cases']:
        assert case['passed'] is True
        assert all(isinstance(case[key], dict) and bool(case[key]) for key in ['before', 'expanded', 'after'])
        before, expanded, after = (case[key] for key in ['before', 'expanded', 'after'])
        for state in [before, expanded, after]:
            native, windows = state['native'], state['win32']
            assert type(native['fullscreen']) is bool and type(native['maximized']) is bool
            assert native['domFullscreen'] is False and type(native['observedAt']) is int and native['observedAt'] > 0
            assert windows['processId'] == value['client']['pid'] and windows['isIconic'] is False
            for rect in ['bounds', 'monitor']:
                assert all(type(windows[rect][key]) is int for key in ['left', 'top', 'right', 'bottom'])
                assert windows[rect]['right'] > windows[rect]['left'] and windows[rect]['bottom'] > windows[rect]['top']
        assert expanded['native']['fullscreen'] is True and expanded['native']['tvMounted'] is True
        assert before['native']['tvMounted'] is False and after['native']['tvMounted'] is False
        assert after['native']['bodyOverflow'] != 'hidden'
        assert after['native']['fullscreen'] is before['native']['fullscreen']
        for key in ['left', 'top', 'right', 'bottom']:
            assert abs(expanded['win32']['bounds'][key] - expanded['win32']['monitor'][key]) <= 3, (case['id'], key)
        if case['id'].startswith('borrowed-'):
            assert before['native']['fullscreen'] is True
            for state in [before, after]:
                assert all(abs(state['win32']['bounds'][key] - state['win32']['monitor'][key]) <= 3
                           for key in ['left', 'top', 'right', 'bottom'])
        else:
            assert after['native']['maximized'] is before['native']['maximized']
            assert all(abs(after['win32']['bounds'][key] - before['win32']['bounds'][key]) <= 2
                       for key in ['left', 'top', 'right', 'bottom'])
            assert before['native']['fullscreen'] is False
            if case['id'].startswith('maximized-'):
                assert before['native']['maximized'] is True
                assert before['win32']['isZoomed'] is True and after['win32']['isZoomed'] is True
            else:
                assert before['native']['maximized'] is False
                assert before['win32']['isZoomed'] is False and after['win32']['isZoomed'] is False
    assert len(value['screenshots']) >= 5
    for name in value['screenshots']:
        assert re.fullmatch('[A-Za-z0-9._-]+\\.png', name)
        assert archive_bytes(evidence, name).startswith(b'\x89PNG\r\n\x1a\n')
    return value


def main():
    incoming, feature_path, identity_path = map(Path, sys.argv[1:])
    contract = load_json(incoming / 'r142-promotion-contract.json')
    assert contract['schemaVersion'] == 1 and contract['sequence'] == 142
    assert contract['tag'] == 'r142-ota'
    assert contract['repository'] == 'sanozhukov3737-oss/klipper-farm-updates'
    assert contract['patchSha256'] == FEATURE_SHA
    assert contract['releaseIdentitySha256'] == IDENTITY_SHA
    assert contract['baselineSourceSha256'] == BASE_SHA
    assert re.fullmatch('[a-f0-9]{40}', contract['buildHeadSha'])
    assert re.fullmatch('[1-9][0-9]*', str(contract['buildRunId']))
    assert file_digest(feature_path) == FEATURE_SHA and file_digest(identity_path) == IDENTITY_SHA
    feature, identity = load_json(feature_path), load_json(identity_path)
    assert feature['schemaVersion'] == 1 and feature['release'] == 'R142-GRAPHITE-DRAFT'
    assert feature['baseline'] == 'R141'
    assert feature['baseArchiveSha256'] == BASE_SHA and feature['baseArchiveSize'] == 582467387
    assert feature['archivePrefix'] == 'Klipper-Farm-R141/'
    assert len(identity['baselineFiles']) == 1856 and len(feature['files']) == FEATURE_COUNT
    assert len({row['path'] for row in feature['files']}) == FEATURE_COUNT
    assert identity['release'] == 'R142' and identity['baseline'] == 'R141'
    assert identity['sequence'] == 142 and identity['buildId'] == BUILD_ID
    assert identity['baseArchiveSha256'] == BASE_SHA and identity['baseArchiveSize'] == 582467387
    assert identity['archivePrefix'] == 'Klipper-Farm-R141/'
    assert identity['featurePatchSha256'] == FEATURE_SHA and len(identity['files']) == 5
    assert {row['path'] for row in identity['files']} == IDENTITY_PATHS
    assert not IDENTITY_PATHS.intersection(row['path'] for row in feature['files'])
    provenance = load_json(incoming / 'provenance.json')
    for key, expected in {'release': 'R142', 'sequence': 142, 'baselineSequence': 141,
                          'buildId': BUILD_ID, 'headSha': contract['buildHeadSha'],
                          'patchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA}.items():
        assert provenance[key] == expected, key
    assert str(provenance['runId']) == str(contract['buildRunId'])
    assert provenance['assets'] == contract['assets']
    validation = load_json(incoming / 'exact-validation.json')
    for key, expected in {'release': 'R142', 'installedSequence': 142, 'upgradeFrom': 141,
                          'headSha': contract['buildHeadSha']}.items():
        assert validation[key] == expected, key
    assert str(validation['runId']) == str(contract['buildRunId'])
    if 'buildRunId' in validation:
        assert str(validation['buildRunId']) == str(contract['buildRunId'])
    for flag in ['passed', 'cleanInstallVerified', 'embeddedUpdateChannelVerified', 'exactInstallerPayloadVerified',
                 'installedBinaryHashesMatch', 'desktopWebViewLoaded', 'legacyDataPreserved',
                 'printerConfigurationPreserved', 'filamentInventoryPreserved', 'costSettingsPreserved', 'installedRestartVerified',
                 'actualFullscreenStateVerified', 'installedTvFullscreenVerified', 'actualWindowsWindowManagerVerified']:
        assert validation[flag] is True, flag
    assert type(validation['installedTvFullscreenCases']) is int and validation['installedTvFullscreenCases'] == 5
    assert set(contract['assets']) == {'Klipper-Farm-R142-setup.exe', 'KF-R142-FULL.zip'}
    for name, expected in contract['assets'].items():
        target = incoming / name
        assert target.stat().st_size == expected['sizeBytes'] and file_digest(target) == expected['sha256'], name
    baseline = incoming / 'KF-R141-FULL.zip'
    assert baseline.stat().st_size == 582467387 and file_digest(baseline) == BASE_SHA
    native, build_counts, build_delta = check_native_evidence(incoming / 'build-evidence.zip', contract, feature, identity)
    with zipfile.ZipFile(incoming / 'KF-R142-FULL.zip') as source, zipfile.ZipFile(baseline) as original:
        prefix = 'Klipper-Farm-R142/'
        current, before = inventory(source, prefix), inventory(original, 'Klipper-Farm-R141/')
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
            'publicKeyHex': PUBLIC_KEY, 'channel': 'stable', 'installedSequence': 142}
        assert source_bytes('RELEASE-BUILD-ID.txt').decode().strip() == BUILD_ID
        assert digest(source_bytes('src/lib/spool-viewer.mjs')) == identity['baselineFiles']['src/lib/spool-viewer.mjs']
        # Materialize only entries whose paths, bytes, complete manifest and
        # preservation against the published baseline were verified above.
        # The acceptance checker then validates source-bound execution ledgers
        # and all reports independently for both exact evidence archives.
        with tempfile.TemporaryDirectory(prefix='kf-r142-source-') as temporary:
            source_root = Path(temporary)
            extract_verified_entries(source, current, source_root)
            fresh_build = check_r142_acceptance(incoming / 'build-evidence.zip', source_root, feature_path, identity_path, contract)
            fresh_installed = check_r142_acceptance(incoming / 'R142-UI-proof.zip', source_root, feature_path, identity_path, contract)
            assert fresh_build == fresh_installed, 'Installed proof is not bound to the exact build acceptance'
    with zipfile.ZipFile(incoming / 'R142-UI-proof.zip') as evidence:
        counts, delta = check_build_reports(evidence, feature, identity)
        assert counts == build_counts and delta == build_delta
        for name, count in fresh_build['acceptanceCases'].items():
            assert name not in counts or counts[name] == count, name
            counts[name] = count
        installed_fullscreen = check_installed_fullscreen(evidence)
        installed_fullscreen_sha = digest(archive_bytes(evidence, 'installed-fullscreen-report.json'))
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
        assert payload['installedSequence'] == 142 and payload['embeddedUpdateChannelVerified'] is True
        assert set(payload['binaries']) == {'klipper-farm-client.exe', 'klipper-farmd.exe'}
        for binary in payload['binaries'].values():
            assert binary['expectedInstalledSha256'] == binary['installedSha256'] == binary['packagedSha256']
        assert installed_fullscreen['client']['sha256'] == payload['binaries']['klipper-farm-client.exe']['installedSha256']
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
    result = {'passed': True, 'release': 'R142', 'reviewedFileCount': FEATURE_COUNT, 'releaseIdentityFileCount': 5,
              'runId': str(contract['buildRunId']), 'headSha': contract['buildHeadSha'],
              'patchSha256': FEATURE_SHA, 'releaseIdentitySha256': IDENTITY_SHA,
              'exactPublishedSourceMatchesReviewedPatch': True,
              'unreviewedSourcePreservationVerifiedBeforeAndAfterBuild': True,
              'unchangedSourceFiles': unchanged, 'completeSourceManifestVerified': True,
              'installedSequence': 142, 'embeddedUpdateChannelVerified': True,
              'buildId': BUILD_ID, 'acceptanceCases': counts, 'nativeTests': native,
              'r142Acceptance': fresh_build,
              'actualFullscreenStateVerified': True, 'installedTvFullscreenVerified': True,
              'actualWindowsWindowManagerVerified': True, 'installedTvFullscreenCases': installed_fullscreen['passedCases'],
              'installedTvFullscreenReportSha256': installed_fullscreen_sha,
              'realSQLitePrinterConfigurations': 7, 'legacySpools': 2,
              'cleanInstallVerified': True, 'installedCostSettingsPreserved': True, 'installedUpgradeAndRestartDataPreserved': True, 'desktopWebViewMarkers': len(markers) + len(clean_markers),
              'nativeRuntimeEmulatorVerified': True, 'exactInstalledNsisPayloadVerified': True,
              'installedBinaries': payload['binaries'], 'physicalPrinterTested': False,
              'scope': 'Windows runner: actual installed WebView, native processes, clean installation, upgrade/restart and local printer emulators. Current R142 acceptance reports are pinned by the reviewed native and acceptance contract; physical printers were not tested.'}
    (incoming / 'source-inspection.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
