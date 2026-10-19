#!/usr/bin/env python3
"""Inspect exact published R126 source and Windows acceptance evidence."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

incoming = Path(sys.argv[1])
patch = Path(sys.argv[2])
digest = lambda b: hashlib.sha256(b).hexdigest()
assert digest(patch.read_bytes()) == '20d20017dfa46ccbb53ffca6b243aeb4691a88e4f4c8c670f3fda83512ddfeae'
rows = json.loads(patch.read_text(encoding='utf-8'))
assert len(rows) == 30 and len({r['path'] for r in rows}) == 30
with zipfile.ZipFile(incoming / 'KF-R126-FULL.zip') as source:
    prefix = 'Klipper-Farm-R126/'
    def source_bytes(name):
        return source.read(prefix + name)
    for row in rows:
        assert digest(source_bytes(row['path'])) == row['afterSha256'], row['path']
    channel = json.loads(source_bytes('UPDATE-CHANNEL.json'))
    assert channel['installedSequence'] == 126 and channel['channel'] == 'stable'
    assert channel['publicKeyHex'] == '28e0124c33f42704483d1aac89af829c44a00ef5dbc2e93dff630befddd495eb'
    assert channel['endpoint'] == 'https://github.com/sanozhukov3737-oss/klipper-farm-updates/releases/latest/download/update-v20.json'
    build_id = source_bytes('RELEASE-BUILD-ID.txt').decode().strip()
    assert build_id == 'V20.6-R12.6-FLASHFORGE-FILES-2026-10-19'
    with zipfile.ZipFile(incoming / 'R126-UI-proof.zip') as evidence:
        names = evidence.namelist()
        def report(name):
            matches = [p for p in names if p.replace('\\', '/').endswith('/' + name) or p == name]
            assert len(matches) == 1, (name, matches)
            return json.loads(evidence.read(matches[0]).decode('utf-8-sig'))
        delta = report('source-delta.json')
        assert delta['allUnreviewedSourceBytesPreserved'] is True
        assert {r['path']: r['afterSha256'] for r in delta['modifiedFiles']} == {r['path']: r['afterSha256'] for r in rows}
        counts = {}
        for name, minimum in [('r126-files-profile.json', 13), ('r126-file-sync.json', 53), ('r126-profile-app.json', 11), ('r126-file-ui.json', 36), ('r126-ui-artwork.json', 10)]:
            result = report(name)
            assert result['passed'] is True and result['caseCount'] >= minimum, name
            assert len(result['cases']) == result['caseCount'], name
            assert all(case.get('passed') is True for case in result['cases']), name
            for path, sha in result.get('productionSources', {}).items():
                assert digest(source_bytes(path)) == sha, (name, path)
            counts[name] = result['caseCount']
        discovery = report('r126-discovery.json')
        assert discovery['passed'] >= 13 and len(discovery['report']) == discovery['passed']
        assert all(case['status'] == 'passed' for case in discovery['report'])
        for path, sha in discovery['productionSources'].items():
            assert digest(source_bytes(path)) == sha, path
        counts['r126-discovery.json'] = discovery['passed']
        seed = report('upgrade-data-seed.json')
        for name in ['upgrade-data-preserved.json', 'upgrade-data-after-restart.json']:
            result = report(name)
            assert result['passed'] is True and result['mode'] == 'verify'
            assert result['printerCount'] == 7 and result['spoolCount'] == 2
            assert result['sqliteIntegrity'] == 'ok' and result['rows'] == seed['rows']
            for flag in ['printerConfigurationBytesPreserved', 'legacySpoolBytesPreserved', 'filamentInventoryBytesPreserved', 'materialReserveAndUsagePreserved']:
                assert result[flag] is True, flag
        runtime = report('headless-runtime.json')
        assert runtime['passed'] is True and runtime['registeredPrinters'] == 7
        for flag in ['staleCommandRejected', 'offlineMemberIsolation', 'freshTelemetryAllHealthy']:
            assert runtime[flag] is True, flag
        payload = report('installed-payload.json')
        payload_after_restart = report('installed-payload-after-restart.json')
        assert payload == payload_after_restart
        assert payload['passed'] is True and payload['comparison'] == 'nsis-extracted-exact-v1'
        for name, binary in payload['binaries'].items():
            assert name in ['klipper-farm-client.exe', 'klipper-farmd.exe']
            assert binary['expectedInstalledSha256'] == binary['installedSha256'] == binary['packagedSha256']
        markers = [p for p in names if '/smoke/' in '/' + p.replace('\\', '/') and Path(p).name.startswith('desktop-startup-smoke-client-') and p.endswith('.json')]
        assert len(markers) >= 3
        for name in markers:
            marker = json.loads(evidence.read(name).decode('utf-8-sig'))
            assert marker['schemaVersion'] == 1 and marker['binary'] == 'klipper-farm-client'
            assert marker['windowLabel'] == 'main' and marker['pageLoad'] == 'finished'
            assert marker['executableFile'].lower() == 'klipper-farm-client.exe'
            assert marker['pid'] > 0 and marker['createdAtMs'] > 0

result = {'passed': True, 'release': 'R126', 'reviewedFileCount': 30,
          'exactPublishedSourceMatchesReviewedPatch': True,
          'unreviewedSourcePreservationVerifiedBeforeBuild': True,
          'installedSequence': 126, 'buildId': build_id, 'acceptanceCases': counts,
          'realSQLitePrinterConfigurations': 7, 'legacySpools': 2,
          'installedUpgradeAndRestartDataPreserved': True,
          'desktopWebViewMarkers': len(markers), 'nativeRuntimeEmulatorVerified': True,
          'exactInstalledNsisPayloadVerified': True, 'installedBinaries': payload['binaries'],
          'physicalPrinterTested': False,
          'scope': 'Windows hosted runner; production Edge UI, native processes and local printer emulator. Physical printer and actual Windows system DPI not tested.'}
(incoming / 'source-inspection.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result))
