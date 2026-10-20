#!/usr/bin/env python3
"""Bind R130 stable publication to exact source and installed Windows proof."""
import base64
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

incoming, patch_file = map(Path, sys.argv[1:])
digest = lambda data: hashlib.sha256(data).hexdigest()
patch_sha = 'e249507230410fe0655870cc31ef06f1265793aef0fa9ed1e4e132770c7b8466'
assert digest(patch_file.read_bytes()) == patch_sha
patch = json.loads(patch_file.read_text(encoding='utf-8'))
rows = patch['files']
assert len(rows) == 19 and len({r['path'] for r in rows}) == 19
baseline_path = incoming / 'KF-R129-FULL.zip'
assert digest(baseline_path.read_bytes()) == patch['baseArchiveSha256']

with zipfile.ZipFile(incoming / 'KF-R130-FULL.zip') as source, zipfile.ZipFile(baseline_path) as baseline:
    prefix = 'Klipper-Farm-R130/'
    def source_bytes(name):
        return source.read(prefix + name)

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

    current = inventory(source, prefix)
    original = inventory(baseline, 'Klipper-Farm-R129/')
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
    manifest = {}
    for line in source_bytes('MANIFEST-SHA256.txt').decode().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        expected, name = line.split(' *', 1)
        assert name not in manifest and name in current
        assert digest(source_bytes(name)) == expected, name
        manifest[name] = expected
    assert set(manifest) == set(current) - {'MANIFEST-SHA256.txt'}
    channel = json.loads(source_bytes('UPDATE-CHANNEL.json'))
    expected_channel = {
        'endpoint': 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json',
        'publicKeyHex': '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb',
        'channel': 'stable', 'installedSequence': 130,
    }
    assert channel == expected_channel
    build_id = source_bytes('RELEASE-BUILD-ID.txt').decode().strip()
    assert build_id == 'V20.6-R13.0-UNIFIED-PRINTERS-2026-10-20'

    with zipfile.ZipFile(incoming / 'R130-UI-proof.zip') as evidence:
        names = evidence.namelist()
        def report(name):
            matches = [p for p in names if p.replace('\\', '/').endswith('/' + name) or p == name]
            assert len(matches) == 1, (name, matches)
            return json.loads(evidence.read(matches[0]).decode('utf-8-sig'))

        delta = report('source-delta.json')
        assert delta['passed'] is True and delta['allUnreviewedSourceBytesPreserved'] is True
        assert delta['patchSha256'] == patch_sha
        assert {r['path']: r['sha256'] for r in delta['modifiedFiles']} == {r['path']: r['sha256'] for r in rows}
        counts = {}
        for name, minimum in [('r130-print-start.json', 12), ('r130-sound-core.json', 12),
                              ('printers-r130-report.json', 24), ('filament-replace-r129-report.json', 11), ('warehouse-r128-report.json', 7), ('fleet-r128-report.json', 7),
                              ('filament-inventory-r123-report.json', 17), ('sound-settings-ui.json', 4)]:
            result = report(name)
            assert isinstance(result['passed'], int) and result['passed'] >= minimum, name
            cases = result.get('report', result.get('cases'))
            assert isinstance(cases, list) and len(cases) == result['passed'], name
            assert all(case.get('passed', True) is True for case in cases), name
            assert not result.get('runtimeErrors'), name
            counts[name] = result['passed']
        finish = report('r130-finish-core.json')
        assert len(finish['cases']) == 8 and all(case['passed'] is True for case in finish['cases'])
        counts['r130-finish-core.json'] = 8
        seed = report('upgrade-data-seed.json')
        for name in ['upgrade-data-preserved.json', 'upgrade-data-after-restart.json']:
            result = report(name)
            assert result['passed'] is True and result['mode'] == 'verify'
            assert result['printerCount'] == 7 and result['spoolCount'] == 2
            assert result['sqliteIntegrity'] == 'ok' and result['rows'] == seed['rows']
            for flag in ['printerConfigurationBytesPreserved', 'legacySpoolBytesPreserved',
                         'filamentInventoryBytesPreserved', 'materialReserveAndUsagePreserved']:
                assert result[flag] is True, flag
        runtime = report('headless-runtime.json')
        assert runtime['passed'] is True and runtime['registeredPrinters'] == 7
        for flag in ['staleCommandRejected', 'offlineMemberIsolation', 'freshTelemetryAllHealthy']:
            assert runtime[flag] is True, flag
        payload = report('installed-payload.json')
        assert payload == report('installed-payload-after-restart.json')
        assert payload['passed'] is True and payload['comparison'] == 'nsis-extracted-exact-v1'
        assert payload['installedSequence'] == 130 and payload['embeddedUpdateChannelVerified'] is True
        assert set(payload['binaries']) == {'klipper-farm-client.exe', 'klipper-farmd.exe'}
        for binary in payload['binaries'].values():
            assert binary['expectedInstalledSha256'] == binary['installedSha256'] == binary['packagedSha256']
        markers = [p for p in names if '/smoke/' in '/' + p.replace('\\', '/')
                   and Path(p).name.startswith('desktop-startup-smoke-client-') and p.endswith('.json')]
        assert len(markers) >= 3
        for name in markers:
            marker = json.loads(evidence.read(name).decode('utf-8-sig'))
            assert marker['schemaVersion'] == 1 and marker['binary'] == 'klipper-farm-client'
            assert marker['windowLabel'] == 'main' and marker['pageLoad'] == 'finished'
            assert marker['executableFile'].lower() == 'klipper-farm-client.exe'
            assert marker['pid'] > 0 and marker['createdAtMs'] > 0

result = {
    'passed': True, 'release': 'R130', 'reviewedFileCount': 19,
    'exactPublishedSourceMatchesReviewedPatch': True,
    'unreviewedSourcePreservationVerifiedBeforeAndAfterBuild': True,
    'unchangedSourceFiles': unchanged, 'completeSourceManifestVerified': True,
    'installedSequence': 130, 'embeddedUpdateChannelVerified': True,
    'buildId': build_id, 'acceptanceCases': counts,
    'realSQLitePrinterConfigurations': 7, 'legacySpools': 2,
    'installedUpgradeAndRestartDataPreserved': True,
    'desktopWebViewMarkers': len(markers), 'nativeRuntimeEmulatorVerified': True,
    'exactInstalledNsisPayloadVerified': True, 'installedBinaries': payload['binaries'],
    'physicalPrinterTested': False,
    'scope': 'Windows runner; production Edge UI, native processes and local printer emulators. Physical printer and user Windows mixer not tested.',
}
(incoming / 'source-inspection.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result))
