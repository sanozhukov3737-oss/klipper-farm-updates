#!/usr/bin/env python3
"""Run and verify exact-source R141 acceptance, retaining Linux performance evidence.

Run --run-checks node and browser before the build, then verify without that
option after the complete Windows native suite. Generated dist/manifests and
Tauri schemas are excluded from the handwritten input snapshot.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

CONTRACT_SHA256 = '693bf9e35b2b9a68a9c5259eed7d87a0f54a3da6f8ae80c76a10d8b4e5c56926'
FEATURE_SHA256 = '1892b42dd303170cb705d740110508d9335ad448d78971c727528d898216417c'
IDENTITY_SHA256 = '2abaffec709fcdcdb811726eb835a9fd1f6ea05bb0effe95165a13ae8a417ec8'
BUILD_ID = 'V20.6-R14.1-PERFORMANCE-TELEMETRY-2026-10-26'
TREE_ROOTS = ('src', 'public', 'scripts', 'ui-tests', 'src-tauri/src',
              'src-tauri/crates', 'src-tauri/capabilities', 'src-tauri/windows',
              'src-tauri/icons')
ROOT_INPUTS = ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json',
               'vite.config.ts', '.cargo/config.toml', 'RELEASE-BUILD-ID.txt',
               'UPDATE-CHANNEL.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
               'src-tauri/build.rs', 'src-tauri/tauri.conf.json',
               'src-tauri/tauri.offline.conf.json', 'src-tauri/tauri.release.conf.json')
EXCLUDED_PARTS = {'node_modules', 'target', '__pycache__', '.git'}


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def object_sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def safe_name(name):
    assert isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_./-]+', name), name
    parts = PurePosixPath(name).parts
    assert parts and not PurePosixPath(name).is_absolute() and '..' not in parts, name
    return name


def dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.partial')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def requirements(path):
    assert sha(path) == CONTRACT_SHA256, 'Pinned R141 acceptance contract differs'
    value = load(path)
    assert (value['schemaVersion'], value['release'], value['baseline'], value['sequence']) == (1, 'R141', 'R140', 141)
    assert value['buildId'] == BUILD_ID
    assert value['featurePatchSha256'] == FEATURE_SHA256
    assert value['releaseIdentitySha256'] == IDENTITY_SHA256
    assert (value['expectedRootPassed'], value['expectedRootIgnored'], value['baselineRootPassed']) == (232, 2, 223)
    assert len(value['newTests']) == 9 and len(value['tests']) == 33
    assert len(value['tests']) == len(set(value['tests']))
    assert set(value['newTests']) <= set(value['tests'])
    assert set(value['extendedExistingTests']) <= set(value['tests'])
    assert all(re.fullmatch(r'[A-Za-z0-9_:]+', name) for name in value['tests'])
    reports = {spec['filename']: spec for spec in value['acceptanceReports']}
    assert len(reports) == 12 and sum(spec['count'] for spec in reports.values()) == 220
    targets = []
    for kind, prefix in [('node', 'scripts/'), ('browser', 'ui-tests/')]:
        checks = value[kind + 'Checks']
        assert len(checks) == 6
        for check in checks:
            assert safe_name(check['script']).startswith(prefix) and check['script'].endswith('.mjs')
            assert re.fullmatch(r'KF_[A-Z0-9_]+', check['proofEnv'])
            assert check.get('proofTarget', 'file') in ('file', 'directory')
            assert check['report'] in reports
            targets.append(check['report'])
    assert len(targets) == len(set(targets)) and set(targets) == set(reports)
    assert value['freshAcceptanceCases'] == 220 and value['totalAcceptanceCases'] == 233
    return value


def selected(name):
    parts = PurePosixPath(name).parts
    return not EXCLUDED_PARTS.intersection(parts) and (
        name in ROOT_INPUTS or any(name.startswith(root + '/') for root in TREE_ROOTS))


def source_snapshot(source):
    source = Path(source)
    files = set()
    for root in TREE_ROOTS:
        directory = source / root
        assert directory.is_dir(), root
        for path in directory.rglob('*'):
            name = path.relative_to(source).as_posix()
            if selected(name):
                assert not path.is_symlink(), 'Symlink in acceptance inputs: ' + name
                if path.is_file():
                    files.add(name)
    for name in ROOT_INPUTS:
        path = source / name
        assert path.is_file() and not path.is_symlink(), name
        files.add(name)
    return {name: sha(source / name) for name in sorted(files)}


def verify_source(value, source, patch_path, identity_path):
    assert sha(patch_path) == FEATURE_SHA256, 'Approved feature patch differs'
    assert sha(identity_path) == IDENTITY_SHA256, 'Approved release identity differs'
    patch, identity = load(patch_path), load(identity_path)
    assert len(patch['files']) == 32 and len(identity['files']) == 5
    assert identity['buildId'] == BUILD_ID and identity['sequence'] == 141
    assert identity['featurePatchSha256'] == FEATURE_SHA256
    assert patch['baselineFiles'] == identity['baselineFiles']
    expected = dict(patch['baselineFiles'])
    for spec in patch['files'] + identity['files']:
        expected[safe_name(spec['path'])] = spec['sha256']
        assert sha(Path(source) / spec['path']) == spec['sha256'], spec['path']
    expected = {name: digest for name, digest in expected.items() if selected(name)}
    actual = source_snapshot(source)
    assert actual == expected, 'Handwritten source/assets/config differ from pinned R140 + feature32 + identity5: ' + str(sorted(name for name in set(actual) | set(expected) if actual.get(name) != expected.get(name)))
    assert (Path(source) / 'RELEASE-BUILD-ID.txt').read_text().strip() == value['buildId']
    return actual


def verify_cases(report, spec):
    count = spec['count']
    assert type(report[spec['passedField']]) is int and report[spec['passedField']] == count, spec['filename']
    cases = report[spec['casesField']]
    assert isinstance(cases, list) and len(cases) == count, spec['filename']
    for case in cases:
        if 'caseStatusField' in spec:
            assert isinstance(case, dict) and case.get(spec['caseStatusField']) == spec['caseStatusValue'], spec['filename']
        else:
            assert (case.get('passed') is True if isinstance(case, dict)
                    else isinstance(case, str) and bool(case.strip())), spec['filename']
    for key in spec.get('errorFields', []):
        assert key in report and report[key] in ([], 0), (spec['filename'], key)


def verify_report_sources(report, source):
    for key in ('productionSources', 'sourceSha256', 'sources'):
        if key not in report:
            continue
        mapping = report[key]
        assert isinstance(mapping, dict) and mapping, key
        for name, digest in mapping.items():
            assert sha(Path(source) / safe_name(name)) == digest, (key, name)
    if 'source' in report:
        spec = report['source']
        assert sha(Path(source) / safe_name(spec['file'])) == spec['sha256'], spec


def verify_reports(value, directory, source):
    counts = {}
    for spec in value['acceptanceReports']:
        report = load(Path(directory) / spec['filename'])
        verify_cases(report, spec)
        verify_report_sources(report, source)
        counts[spec['filename']] = spec['count']
    ui = load(Path(directory) / 'tv-spotlight-r140-report.json')
    assert ui['actualReactComponent'] is True and ui['physicalPrintersTested'] is False
    assert set(ui['productionSources']) == {'src/components/TvDashboard.tsx', 'src/components/TvDashboard.css', 'src/lib/tvSpotlight.ts'}
    temperature = load(Path(directory) / 'r141-temperature-merge.json')
    assert set(temperature['sourceSha256']) == {'src/lib/moonraker.ts', 'src/types.ts', 'src/lib/printerTelemetry.ts', 'scripts/check-r141-temperature-merge.mjs'}
    helper = load(Path(directory) / 'r141-fullscreen-helper.json')
    assert helper['source']['file'] == 'src/lib/tvFullscreen.ts'
    fullscreen = load(Path(directory) / 'tv-fullscreen-r141-report.json')
    assert set(fullscreen['sources']) == {'src/lib/tvFullscreen.ts', 'src/components/TvDashboard.tsx', 'src/components/TvDashboard.css', 'src/lib/tvSpotlight.ts'}
    return counts


def run_checks(value, kind, source, directory, snapshot, contract_path):
    source, directory = Path(source).resolve(), Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    ledger_path = directory / value['executionLedgers'][kind]
    ledger_path.unlink(missing_ok=True)
    node = shutil.which('node')
    assert node, 'Node.js is required'
    env = dict(os.environ)
    for name in ('KF_UI_SCREENSHOTS', 'KF_R139_UI_PROOF_DIR', 'KF_R140_TV_PROOF_DIR', 'KF_R141_FULLSCREEN_UI_PROOF_DIR'):
        env[name] = str(directory)
    results = []
    started_at = datetime.now(timezone.utc).isoformat()
    for check in value[kind + 'Checks']:
        report_path = directory / check['report']
        report_path.unlink(missing_ok=True)
        env[check['proofEnv']] = str(directory if check.get('proofTarget') == 'directory' else report_path)
        log_path = directory / (Path(check['script']).stem + '.execution.log')
        command = [node, check['script']]
        print('RUN ' + ' '.join(command), flush=True)
        with log_path.open('wb') as log:
            process = subprocess.Popen(command, cwd=source, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                for chunk in iter(lambda: process.stdout.read1(65536), b''):
                    log.write(chunk)
                    if hasattr(sys.stdout, 'buffer'):
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                    else:
                        sys.stdout.write(chunk.decode('utf-8', errors='replace'))
                exit_code = process.wait()
            except BaseException:
                process.kill()
                process.wait()
                raise
        assert exit_code == 0, 'Acceptance command failed: ' + check['script']
        assert report_path.is_file(), 'Check did not produce its report: ' + check['report']
        spec = next(row for row in value['acceptanceReports'] if row['filename'] == check['report'])
        verify_cases(load(report_path), spec)
        verify_report_sources(load(report_path), source)
        results.append({'script': check['script'], 'scriptSha256': snapshot[check['script']],
                        'proofEnv': check['proofEnv'], 'report': check['report'],
                        'reportSha256': sha(report_path), 'log': log_path.name,
                        'logSha256': sha(log_path), 'exitCode': 0, 'passed': True})
    after = source_snapshot(source)
    assert after == snapshot, 'Source changed during acceptance; no execution ledger published'
    ledger = {'schemaVersion': 1, 'release': 'R141', 'kind': kind, 'passed': True,
              'contractSha256': sha(contract_path), 'buildId': BUILD_ID,
              'platform': sys.platform, 'githubRunId': env.get('GITHUB_RUN_ID'),
              'githubHeadSha': env.get('GITHUB_SHA'), 'startedAt': started_at,
              'completedAt': datetime.now(timezone.utc).isoformat(),
              'sourceSnapshot': snapshot, 'sourceSnapshotSha256': object_sha(snapshot),
              'sourceUnchangedDuringRun': True, 'checks': results}
    dump(ledger_path, ledger)
    return {'passed': True, 'kind': kind, 'checks': len(results), 'ledger': str(ledger_path), 'ledgerSha256': sha(ledger_path)}


def verify_ledgers(value, directory, snapshot, contract_path, expected_run_id=None, expected_head_sha=None):
    digests = {}
    run_identity = None
    for kind in ('node', 'browser'):
        path = Path(directory) / value['executionLedgers'][kind]
        ledger = load(path)
        assert ledger['schemaVersion'] == 1 and ledger['release'] == 'R141' and ledger['kind'] == kind
        assert ledger['passed'] is True and ledger['sourceUnchangedDuringRun'] is True
        assert ledger['contractSha256'] == sha(contract_path) and ledger['buildId'] == BUILD_ID
        assert ledger['sourceSnapshot'] == snapshot and ledger['sourceSnapshotSha256'] == object_sha(snapshot)
        identity = (ledger.get('githubRunId'), ledger.get('githubHeadSha'))
        if run_identity is None:
            run_identity = identity
        assert identity == run_identity, 'Node/browser ledgers must belong to one build'
        # A promotion job passes the candidate build identity, rather than its
        # own different workflow run. The CLI defaults to the current build.
        for expected, key in [(expected_run_id, 'githubRunId'), (expected_head_sha, 'githubHeadSha')]:
            if expected is not None:
                assert ledger.get(key) == str(expected), (kind, key)
        assert len(ledger['checks']) == len(value[kind + 'Checks'])
        for spec, actual in zip(value[kind + 'Checks'], ledger['checks']):
            assert actual['script'] == spec['script'] and actual['proofEnv'] == spec['proofEnv']
            assert actual['scriptSha256'] == snapshot[spec['script']]
            assert actual['exitCode'] == 0 and actual['passed'] is True
            assert actual['report'] == spec['report']
            assert actual['reportSha256'] == sha(Path(directory) / spec['report'])
            assert actual['logSha256'] == sha(Path(directory) / safe_name(actual['log']))
        digests[path.name] = sha(path)
    return digests


def verify_native(value, log_path):
    log = Path(log_path).read_text(encoding='utf-8-sig').replace('\r', '')
    summaries = re.findall(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;', log)
    assert summaries and all(row[0] == 'ok' and row[2] == '0' for row in summaries), 'Incomplete or failed native suite'
    expected = ('ok', str(value['expectedRootPassed']), '0', str(value['expectedRootIgnored']))
    assert summaries.count(expected) == 1, 'Expected exactly one complete Windows root suite: 232 passed / 2 ignored'
    assert sum(int(row[3]) for row in summaries) == 2, 'Unexpected additional ignored native tests'
    assert not re.search(r'^test .* \.\.\. FAILED\s*$', log, re.MULTILINE), 'Failed native test'
    for name in value['tests']:
        assert re.search(r'^test ' + re.escape(name) + r' \.\.\. ok\s*$', log, re.MULTILINE), 'Required native test was not executed: ' + name
    return {'rootPassed': 232, 'rootFailed': 0, 'rootIgnored': 2,
            'requiredNativeTests': len(value['tests']), 'newNativeTests': len(value['newTests']),
            'nativeLogSha256': sha(log_path), 'workspaceSummaries': len(summaries)}


def verify_performance(value, directory, source):
    spec = value['retainedPerformance']
    path = Path(directory) / spec['filename']
    assert sha(path) == spec['sha256'], 'Retained Linux measurement reference differs'
    report = load(path)
    verify_cases(report, {'filename': spec['filename'], 'count': 13, 'passedField': 'passed', 'casesField': 'cases', 'errorFields': ['runtimeErrors', 'unexpectedRequests']})
    assert report['platform'] == 'linux' and report['mode'] == 'matched-comparison'
    assert report['samplesPerMode'] >= 3
    assert report['physicalPrintersTested'] is False and report['installedWindowsTested'] is False
    for key in ('approvedSpoolRendererUnchanged', 'approvedMiddleFrameCssDelta', 'tvColumnGeometryUnchanged'):
        assert report[key] is True, key
    actual_src = {name: digest for name, digest in source_snapshot(source).items() if name.startswith('src/')}
    assert report['productionSourceTree'] == actual_src, 'Linux reference does not match this complete src tree'
    verify_report_sources(report, source)
    # All timings remain measurements from the pinned Linux reference. No CPU,
    # elapsed-time, heap or speed-up threshold is used as a Windows release gate.
    return {spec['filename']: 13}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('contract', type=Path)
    parser.add_argument('--source-root', type=Path)
    parser.add_argument('--proof-directory', type=Path)
    parser.add_argument('--patch', type=Path)
    parser.add_argument('--identity', type=Path)
    parser.add_argument('--run-checks', choices=('node', 'browser'))
    parser.add_argument('--native-log', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--build-run-id', default=os.environ.get('GITHUB_RUN_ID'))
    parser.add_argument('--build-head-sha', default=os.environ.get('GITHUB_SHA'))
    args = parser.parse_args()
    value = requirements(args.contract)
    if args.source_root is None:
        assert not any((args.proof_directory, args.run_checks, args.native_log, args.output)), 'A source root is required'
        print(json.dumps({'passed': True, 'contractSha256': sha(args.contract), 'expectedRootPassed': 232, 'expectedRootIgnored': 2, 'newNativeTests': 9, 'freshAcceptanceCases': 220, 'totalAcceptanceCases': 233}))
        return
    patch = args.patch or args.contract.parent / 'r141-performance-patch.json'
    identity = args.identity or args.contract.parent / 'r141-release-identity.json'
    snapshot = verify_source(value, args.source_root, patch, identity)
    if args.proof_directory is None:
        assert not args.run_checks and not args.native_log and not args.output
        print(json.dumps({'passed': True, 'exactFeatureFilesVerified': 32, 'releaseIdentityFilesVerified': 5, 'sourceInputsVerified': len(snapshot), 'sourceSnapshotSha256': object_sha(snapshot)}))
        return
    if args.run_checks:
        assert args.native_log is None and args.output is None
        print(json.dumps(run_checks(value, args.run_checks, args.source_root, args.proof_directory, snapshot, args.contract)))
        return
    assert args.native_log is not None, 'Full Windows native log is required for final acceptance'
    ledgers = verify_ledgers(value, args.proof_directory, snapshot, args.contract,
                             args.build_run_id, args.build_head_sha)
    counts = verify_reports(value, args.proof_directory, args.source_root)
    counts.update(verify_performance(value, args.proof_directory, args.source_root))
    native = verify_native(value, args.native_log)
    report = {'schemaVersion': 1, 'release': 'R141', 'baseline': 'R140', 'sequence': 141,
              'passed': True, 'buildId': BUILD_ID, 'contractSha256': sha(args.contract),
              'featurePatchSha256': FEATURE_SHA256, 'releaseIdentitySha256': IDENTITY_SHA256,
              'exactFeatureFilesVerified': 32, 'releaseIdentityFilesVerified': 5,
              'sourceInputsVerified': len(snapshot), 'sourceSnapshotSha256': object_sha(snapshot),
              'acceptanceCases': counts, 'freshAcceptanceCases': 220, 'retainedPerformanceCases': 13,
              'totalAcceptanceCases': sum(counts.values()), 'executionLedgerSha256': ledgers,
              'reportSha256': {name: sha(args.proof_directory / name) for name in counts},
              'retainedLinuxPerformanceReference': True, 'timingThresholdUsed': False,
              'nativeLogVerified': True, 'installedWindowsValidatedByThisChecker': False,
              'buildRunId': args.build_run_id, 'buildHeadSha': args.build_head_sha,
              'physicalPrintersTested': False, **native}
    assert report['totalAcceptanceCases'] == 233
    target = args.output or args.proof_directory / 'r141-acceptance.json'
    dump(target, report)
    print(json.dumps(report))


if __name__ == '__main__':
    main()
