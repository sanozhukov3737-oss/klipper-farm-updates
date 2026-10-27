"""Run the unchanged functional suites with fresh source-bound execution ledgers.

The underlying test runner and case definitions are the pinned R142 versions.
No R142 release/source-delta claims are reused for this maintenance candidate.
"""
import argparse
import json
import runpy
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--proof', type=Path, required=True)
parser.add_argument('--kind', choices=['node', 'browser', 'native', 'verify'], required=True)
parser.add_argument('--native-log', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent
helper = runpy.run_path(str(root / 'r142-build' / 'check-r142-acceptance.py'))
build_id = (args.source / 'RELEASE-BUILD-ID.txt').read_text().strip()
assert build_id == 'V20.6-R14.3-PERFORMANCE-MAINTENANCE-2026-10-27'
helper['run_checks'].__globals__['BUILD_ID'] = build_id
contract = root / 'r142-required-tests.json'
value = json.loads(contract.read_text(encoding='utf-8-sig'))
snapshot = helper['source_snapshot'](args.source)
args.proof.mkdir(parents=True, exist_ok=True)
if args.kind in ['node', 'browser']:
    result = helper['run_checks'](value, args.kind, args.source, args.proof, snapshot, contract)
    ledger_path = Path(result['ledger'])
    ledger = json.loads(ledger_path.read_text())
    ledger['release'] = 'R143-maintenance'
    ledger_path.write_text(json.dumps(ledger, indent=2) + '\n', encoding='utf-8')
    result['ledgerSha256'] = helper['sha'](ledger_path)
elif args.kind == 'native':
    assert args.native_log
    result = helper['verify_native'](value, args.native_log)
else:
    result = helper['verify_reports'](value, args.proof, args.source)
record = {'stage': args.kind, 'candidate': 'R143-code-maintenance', 'inheritedSuite': 'R142', 'sourceFiles': len(snapshot), 'result': result}
(args.proof / ('maintenance-' + args.kind + '-acceptance.json')).write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
print(json.dumps(record))
