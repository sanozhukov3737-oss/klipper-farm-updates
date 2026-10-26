#!/usr/bin/env python3
"""Verify current R140 TV reports against the approved feature bytes."""
import argparse
import hashlib
import json
from pathlib import Path

FEATURE_SHA256 = 'f0bedbb970a385d8da1772277a8fbf915feb581b1f932f52fa558ccdf3350a03'


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def check_cases(report, count, field='cases', status=False):
    assert type(report['passed']) is int and report['passed'] == count
    cases = report[field]
    assert isinstance(cases, list) and len(cases) == count
    assert all(isinstance(case, dict) and (case.get('status') == 'passed' if status else case.get('passed') is True) for case in cases)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--proof-directory', type=Path, required=True)
    parser.add_argument('--patch', type=Path, required=True)
    args = parser.parse_args()
    patch_bytes = args.patch.read_bytes()
    assert hashlib.sha256(patch_bytes).hexdigest() == FEATURE_SHA256, 'Approved TV patch differs'
    patch = json.loads(patch_bytes)
    expected = {row['path']: row['sha256'] for row in patch['files']}
    assert len(expected) == 8
    for name, digest in expected.items():
        assert hashlib.sha256((args.source_root / name).read_bytes()).hexdigest() == digest, name
    data = load(args.proof_directory / 'tv-spotlight-data.json')
    check_cases(data, 32)
    ui = load(args.proof_directory / 'tv-spotlight-r140-report.json')
    check_cases(ui, 20)
    assert ui['runtimeErrors'] == [] and ui['externalRequests'] == []
    assert ui['actualReactComponent'] is True and ui['physicalPrintersTested'] is False
    production = {name: expected[name] for name in ('src/components/TvDashboard.tsx', 'src/components/TvDashboard.css', 'src/lib/tvSpotlight.ts')}
    assert ui['productionSources'] == production, 'UI proof is not from these exact production sources'
    legacy = load(args.proof_directory / 'tv-camera-report.json')
    check_cases(legacy, 20, 'report', status=True)
    report = {'schemaVersion': 1, 'release': 'R140', 'passed': True,
              'featurePatchSha256': FEATURE_SHA256, 'exactFeatureFilesVerified': len(expected),
              'filamentProjectionCases': 32, 'spotlightBrowserCases': 20,
              'existingCameraBrowserCases': 20, 'totalCases': 72,
              'productionSources': production, 'physicalPrintersTested': False,
              'scope': 'Actual React UI and existing camera guard with synthetic native telemetry and local camera frames; physical printers not tested.'}
    target = args.proof_directory / 'r140-tv-acceptance.json'
    target.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
