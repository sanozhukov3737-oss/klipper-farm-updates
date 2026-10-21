#!/usr/bin/env python3
"""Bind R134 publication to the reviewed source and exact Windows candidate."""
import base64
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

PATCH_SHA = '67f57cd6e77e53e1fef7b97ba09a302460a470956e31601abf78ab9395ab4d64'
BASE_SHA = 'edf5c8a4401eb2d2997827c5e3c2ce4b3d3ce3721f8bd2a097517519546621ff'
RUN_ID = '39639323011'
HEAD_SHA = '863555626a6563c5a11a4ea575031d8b3df2f291'
BUILD_ID = 'V20.6-R13.4-PRINT-TRANSFER-FIX-2026-10-21'
BUILD_EVIDENCE_SHA = '4513b0d1fef2a15c1e17f5132d804e52aae729938dffb6cfdf89b93cd151c3cb'
ASSETS = {
    'Klipper-Farm-R134-setup.exe': {'sizeBytes': 233754545, 'sha256': '670ff8218d7d8146e8565b3e3192150aed1430dc790388f8457736474adcbe82'},
    'KF-R134-FULL.zip': {'sizeBytes': 582861134, 'sha256': 'a70c218772e5b4a2e70419eca2fe76ebb657bcc5f268667d795c56c0f88b3f4a'},
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


def check_provenance(incoming):
    provenance = load_json(incoming / 'provenance.json')
    for key, expected in {'release': 'R134', 'sequence': 134, 'baselineSequence': 133,
                          'buildId': BUILD_ID, 'headSha': HEAD_SHA, 'patchSha256': PATCH_SHA}.items():
        assert provenance[key] == expected, key
    assert str(provenance['runId']) == RUN_ID
    assert provenance['assets'] == ASSETS
    validation = load_json(incoming / 'exact-validation.json')
    for key, expected in {'release': 'R134', 'installedSequence': 134, 'upgradeFrom': 133,
                          'headSha': HEAD_SHA}.items():
        assert validation[key] == expected, key
    assert str(validation['runId']) == RUN_ID
    for flag in ['passed', 'embeddedUpdateChannelVerified', 'exactInstallerPayloadVerified',
                 'installedBinaryHashesMatch', 'desktopWebViewLoaded', 'legacyDataPreserved',
                 'printerConfigurationPreserved', 'filamentInventoryPreserved', 'installedRestartVerified']:
        assert validation[flag] is True, flag
    return provenance, validation


def check_build_reports(evidence, rows):
    delta = report(evidence, 'source-delta.json')
    assert delta['passed'] is True and delta['allUnreviewedSourceBytesPreserved'] is True
    assert delta['release'] == 'R134' and delta['baseline'] == 'R133'
    assert delta['patchSha256'] == PATCH_SHA and delta['baseArchiveSha256'] == BASE_SHA
    assert len(delta['modifiedFiles']) == 17
    assert {r['path']: r['sha256'] for r in delta['modifiedFiles']} == {r['path']: r['sha256'] for r in rows}
    counts = {}
    for name, count in [('r134-print-start.json', 12), ('r134-sound-core.json', 12),
                        ('r134-auto-retry-core.json', 14), ('r134-native-history-policy.json', 7),
                        ('r134-approved-accounting.json', 7), ('auto-accounting-browser-report.json', 10),
                        ('single-spool-page-report.json', 7)]:
        value = report(evidence, name)
        assert type(value['passed']) is int and value['passed'] == count, name
        cases = value.get('report', value.get('cases'))
        assert isinstance(cases, list) and len(cases) == count, name
        assert all(case.get('passed', True) is True if isinstance(case, dict)
                   else isinstance(case, str) and bool(case) for case in cases), name
        assert not value.get('runtimeErrors'), name
        if name == 'single-spool-page-report.json':
            assert all(flag is True for case in cases for flag in case.values() if type(flag) is bool)
        counts[name] = count
    for name, count in [('r134-finish-core.json', 8), ('r134-filament-core.json', 9)]:
        value = report(evidence, name)
        assert len(value['cases']) == count and all(case['passed'] is True for case in value['cases']), name
        counts[name] = count
    return counts, delta


def check_native_evidence(evidence_path):
    assert evidence_path.stat().st_size == 1618924
    assert file_digest(evidence_path) == BUILD_EVIDENCE_SHA
    with zipfile.ZipFile(evidence_path) as evidence:
        native = archive_bytes(evidence, 'v20-rust-tests-last.log').decode('utf-8-sig')
        build = archive_bytes(evidence, 'BUILD-AND-INSTALL.log').decode('utf-8-sig')
        native = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', native)
        results = re.findall(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;', native)
        assert results and all(status == 'ok' and failed == '0' for status, _, failed, _ in results)
        assert results.count(('ok', '199', '0', '2')) == 1
        for marker in ['verification_http_lines_accept_the_actual_empty_header_line',
                       'verification_http_lines_reject_eof_before_the_header_terminator',
                       'original_unicode_names_and_spaces_are_preserved_exactly',
                       'unsafe_upload_names_are_rejected_instead_of_renamed',
                       'upload_name_character_and_extension_limits_are_preserved']:
            assert re.search(re.escape(marker) + r' \.\.\. ok', native), marker
        for marker in ['PASS actual legacy upload protocol: 24999986 exact bytes',
                       'PASS actual preserved local-library uploader: 25568163 exact bytes and SHA',
                       'exact Cyrillic/emoji/mixed filename', 'invalid multipart names blocked before network',
                       'changed source and unsafe multipart names rejected before network']:
            assert marker in build, marker
        assert 'test result: ok. 6 passed; 0 failed; 0 ignored;' in build
        assert 'test result: ok. 7 passed; 0 failed; 0 ignored;' in build
    return {'passed': 199, 'failed': 0, 'ignored': 2, 'standaloneUploadHarnessesVerified': True}


def inventory(archive, expected_prefix):
    files = {}
    for entry in archive.infolist():
        assert entry.filename.startswith(expected_prefix), entry.filename
        name = entry.filename.removeprefix(expected_prefix)
        if not name or entry.is_dir():
            continue
        parts = PurePosixPath(name).parts
        assert not PurePosixPath(name).is_absolute() and '..' not in parts
        assert '\\' not in name and ':' not in name and name not in files
        assert (entry.external_attr >> 16) & 0o170000 != 0o120000
        files[name] = entry
    return files


def main():
    incoming, patch_file = map(Path, sys.argv[1:])
    assert file_digest(patch_file) == PATCH_SHA
    patch = load_json(patch_file)
    assert patch['release'] == 'R134' and patch['baseline'] == 'R133'
    assert patch['baseArchiveSha256'] == BASE_SHA
    assert patch['approvedSourceCommit'] == '2e8ced47366095391bcd25697a6df67230210170'
    assert patch['approvedFeatureFiles'] == 12
    rows = patch['files']
    assert len(rows) == 17 and len({r['path'] for r in rows}) == 17
    check_provenance(incoming)
    for name, expected in ASSETS.items():
        path = incoming / name
        assert path.stat().st_size == expected['sizeBytes'] and file_digest(path) == expected['sha256'], name
    baseline_path = incoming / 'KF-R133-FULL.zip'
    assert file_digest(baseline_path) == BASE_SHA
    native = check_native_evidence(incoming / 'build-evidence.zip')
    with zipfile.ZipFile(incoming / 'build-evidence.zip') as evidence:
        build_counts, build_delta = check_build_reports(evidence, rows)

    with zipfile.ZipFile(incoming / 'KF-R134-FULL.zip') as source, zipfile.ZipFile(baseline_path) as baseline:
        prefix = 'Klipper-Farm-R134/'
        source_bytes = lambda name: source.read(prefix + name)
        current = inventory(source, prefix)
        original = inventory(baseline, 'Klipper-Farm-R133/')
        changed = {r['path'] for r in rows}
        for row in rows:
            after = base64.b64decode(row['contentBase64'], validate=True)
            assert digest(after) == row['sha256'] and source_bytes(row['path']) == after, row['path']
            before = baseline.read(original[row['path']]) if row['path'] in original else None
            assert (digest(before) if before is not None else None) == row['beforeSha256'], row['path']
        generated = {'DIST-V20-LOCK.json', 'MANIFEST-SHA256.txt', 'OFFLINE-PAYLOAD-SHA256.txt'}
        regenerated = lambda name: name.startswith('dist/') or name in generated
        assert {n for n in current if not regenerated(n)} == {n for n in set(original) | changed if not regenerated(n)}
        unchanged = 0
        for name in original:
            if name in changed or regenerated(name):
                continue
            assert source_bytes(name) == baseline.read(original[name]), name
            unchanged += 1
        # The pre-build parity report includes dist and generated manifests;
        # the post-build byte comparison intentionally permits regenerating them.
        assert build_delta['unchangedFiles'] == len(set(original) - changed)
        manifest = {}
        for line in source_bytes('MANIFEST-SHA256.txt').decode().splitlines():
            if not line.strip() or line.startswith('#'):
                continue
            expected, name = line.split(' *', 1)
            assert name not in manifest and name in current
            assert digest(source_bytes(name)) == expected, name
            manifest[name] = expected
        assert set(manifest) == set(current) - {'MANIFEST-SHA256.txt'}
        assert json.loads(source_bytes('UPDATE-CHANNEL.json')) == {
            'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json',
            'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb',
            'channel': 'stable', 'installedSequence': 134,
        }
        assert source_bytes('RELEASE-BUILD-ID.txt').decode().strip() == BUILD_ID
        assert digest(source_bytes('src/lib/spool-viewer.mjs')) == '6b3649ec27e6d1c54e124d9a4df8610d3e35283de40eebd633ff688b54b9f7f3'

    with zipfile.ZipFile(incoming / 'R134-UI-proof.zip') as evidence:
        counts, delta = check_build_reports(evidence, rows)
        assert counts == build_counts and delta == build_delta
        seed = report(evidence, 'upgrade-data-seed.json')
        assert seed['passed'] is True and seed['mode'] == 'seed'
        for name in ['upgrade-data-preserved.json', 'upgrade-data-after-restart.json']:
            value = report(evidence, name)
            assert value['passed'] is True and value['mode'] == 'verify'
            assert value['printerCount'] == 7 and value['spoolCount'] == 2
            assert value['sqliteIntegrity'] == 'ok' and value['rows'] == seed['rows']
            for flag in ['printerConfigurationBytesPreserved', 'legacySpoolBytesPreserved',
                         'filamentInventoryBytesPreserved', 'materialReserveAndUsagePreserved']:
                assert value[flag] is True, flag
        runtime = report(evidence, 'headless-runtime.json')
        assert runtime['passed'] is True and runtime['registeredPrinters'] == 7
        for flag in ['staleCommandRejected', 'offlineMemberIsolation', 'freshTelemetryAllHealthy']:
            assert runtime[flag] is True, flag
        payload = report(evidence, 'installed-payload.json')
        assert payload == report(evidence, 'installed-payload-after-restart.json')
        assert payload['passed'] is True and payload['comparison'] == 'nsis-extracted-exact-v1'
        assert payload['installedSequence'] == 134 and payload['embeddedUpdateChannelVerified'] is True
        assert set(payload['binaries']) == {'klipper-farm-client.exe', 'klipper-farmd.exe'}
        for binary in payload['binaries'].values():
            assert binary['expectedInstalledSha256'] == binary['installedSha256'] == binary['packagedSha256']
        markers = [p for p in evidence.namelist() if '/smoke/' in '/' + p.replace('\\', '/')
                   and PurePosixPath(p.replace('\\', '/')).name.startswith('desktop-startup-smoke-client-') and p.endswith('.json')]
        assert len(markers) >= 3
        for name in markers:
            marker = json.loads(evidence.read(name).decode('utf-8-sig'))
            assert marker['schemaVersion'] == 1 and marker['binary'] == 'klipper-farm-client'
            assert marker['windowLabel'] == 'main' and marker['pageLoad'] == 'finished'
            assert marker['executableFile'].lower() == 'klipper-farm-client.exe'
            assert marker['pid'] > 0 and marker['createdAtMs'] > 0

    result = {
        'passed': True, 'release': 'R134', 'reviewedFileCount': 17,
        'runId': RUN_ID, 'headSha': HEAD_SHA, 'patchSha256': PATCH_SHA,
        'exactPublishedSourceMatchesReviewedPatch': True,
        'unreviewedSourcePreservationVerifiedBeforeAndAfterBuild': True,
        'unchangedSourceFiles': unchanged, 'completeSourceManifestVerified': True,
        'installedSequence': 134, 'embeddedUpdateChannelVerified': True,
        'buildId': BUILD_ID, 'acceptanceCases': counts, 'nativeTests': native,
        'realSQLitePrinterConfigurations': 7, 'legacySpools': 2,
        'installedUpgradeAndRestartDataPreserved': True,
        'desktopWebViewMarkers': len(markers), 'nativeRuntimeEmulatorVerified': True,
        'exactInstalledNsisPayloadVerified': True, 'installedBinaries': payload['binaries'],
        'physicalPrinterTested': False,
        'scope': 'Windows runner; production Edge UI, native processes and local printer emulators. Physical printers were not tested.',
    }
    (incoming / 'source-inspection.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
