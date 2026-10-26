#!/usr/bin/env python3
"""Validate the pinned new R139 test contract and its produced acceptance reports."""
import argparse
import json
import re
from pathlib import Path


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def requirements(path, source=None):
    value = load(path)
    assert value['schemaVersion'] == 1 and value['release'] == 'R139' and value['baseline'] == 'R138'
    assert type(value['expectedRootPassed']) is int and value['expectedRootPassed'] > 214
    assert value['expectedRootIgnored'] == 2
    tests = value['tests']
    assert isinstance(tests, list) and tests and len(tests) == len(set(tests))
    assert all(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9_:]+', name) for name in tests)
    assert value['expectedRootPassed'] >= 214 + len(tests)
    specs = value['acceptanceReports']
    assert isinstance(specs, list) and specs
    reports = set()
    for spec in specs:
        assert set(spec).issubset({'filename', 'count', 'casesField', 'passedField', 'booleanPassed', 'errorFields'})
        assert re.fullmatch(r'r139-[A-Za-z0-9._-]+\.json', spec['filename'])
        assert spec['filename'] not in reports
        reports.add(spec['filename'])
        assert type(spec['count']) is int and spec['count'] > 0
        assert all(isinstance(spec[key], str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', spec[key]) for key in ['casesField', 'passedField'])
        assert type(spec.get('booleanPassed', False)) is bool
        assert isinstance(spec.get('errorFields', []), list)
        assert all(isinstance(key, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', key) for key in spec.get('errorFields', []))
    targets = set()
    for key, prefix in [('nodeChecks', 'scripts/'), ('browserChecks', 'ui-tests/')]:
        checks = value[key]
        assert isinstance(checks, list) and checks, key
        for check in checks:
            assert set(check) == {'script', 'proofEnv', 'report'}
            assert check['script'].startswith(prefix) and re.fullmatch(r'[A-Za-z0-9_./-]+\.mjs', check['script'])
            assert '..' not in Path(check['script']).parts
            assert re.fullmatch(r'KF_[A-Z0-9_]+', check['proofEnv'])
            assert check['report'] in reports and check['report'] not in targets
            targets.add(check['report'])
            if source is not None:
                assert (source / check['script']).is_file(), check['script']
    assert targets == reports, 'Every new report must be produced by one reviewed check'
    return value


def verify_reports(value, directory):
    counts = {}
    for spec in value['acceptanceReports']:
        name, count = spec['filename'], spec['count']
        report = load(directory / name)
        if spec.get('booleanPassed', False):
            assert report[spec['passedField']] is True, name
        else:
            assert type(report[spec['passedField']]) is int and report[spec['passedField']] == count, name
        cases = report[spec['casesField']]
        assert isinstance(cases, list) and len(cases) == count, name
        assert all(case.get('passed') is True if isinstance(case, dict)
                   else isinstance(case, str) and bool(case.strip()) for case in cases), name
        for key in spec.get('errorFields', []):
            assert key in report and report[key] in ([], 0), (name, key)
        counts[name] = count
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('contract', type=Path)
    parser.add_argument('--source-root', type=Path)
    parser.add_argument('--proof-directory', type=Path)
    args = parser.parse_args()
    value = requirements(args.contract, args.source_root)
    counts = verify_reports(value, args.proof_directory) if args.proof_directory is not None else {}
    print(json.dumps({'passed': True, 'newNativeTests': len(value['tests']), 'expectedRootPassed': value['expectedRootPassed'], 'acceptanceCases': counts}))


if __name__ == '__main__':
    main()
