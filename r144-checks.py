"""Execute unchanged inherited cases plus mandatory fault/return regressions."""
import argparse,copy,hashlib,json,os,pathlib,re,runpy,zipfile

root=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--source',type=pathlib.Path,required=True);parser.add_argument('--proof',type=pathlib.Path,required=True);parser.add_argument('--kind',choices=['node','browser','native','verify'],required=True);parser.add_argument('--native-log',type=pathlib.Path);args=parser.parse_args()
assert hashlib.sha256((root/'r142-build.zip').read_bytes()).hexdigest()=='5cd0ca3227de93b894cd2ce0bd0a8d3bcb9f1660b8415144c620ba2c5d815369'
if not (root/'r142-build').exists():
    with zipfile.ZipFile(root/'r142-build.zip') as z:
        assert all('/' not in name and '\\' not in name for name in z.namelist());z.extractall(root/'r142-build')
contract=root/'r142-required-tests.json'
assert hashlib.sha256(contract.read_bytes()).hexdigest()=='2fad3b15c11c24167f88c4bfd1d96b4938b5741a9a8b71218cd74bd2093d6623'
helper=runpy.run_path(str(root/'r142-build/check-r142-acceptance.py'))
build_id=(args.source/'RELEASE-BUILD-ID.txt').read_text().strip()
assert build_id=='V20.6-R14.4-PRINTER-FAULT-RECOVERY-2026-10-28'
helper['run_checks'].__globals__['BUILD_ID']=build_id
value=json.loads(contract.read_text());value['executionLedgers']={key:name.replace('r142','r144') for key,name in value['executionLedgers'].items()}
value['nodeChecks'].append({'script':'scripts/check-printer-fault-recovery.mjs','proofEnv':'KF_FAULT_PROOF','report':'r144-fault-behavior.json'})
value['browserChecks'].append({'script':'ui-tests/printer-return-r144.mjs','proofEnv':'KF_RETURN_PROOF','report':'r144-printer-return.json'})
value['acceptanceReports'] += [{'filename':'r144-fault-behavior.json','count':15,'casesField':'report','passedField':'passed','errorFields':[]},{'filename':'r144-printer-return.json','count':4,'casesField':'report','passedField':'passed','errorFields':[]}]
snapshot=helper['source_snapshot'](args.source);args.proof.mkdir(parents=True,exist_ok=True)
if args.kind in ('node','browser'):
    result=helper['run_checks'](value,args.kind,args.source,args.proof,snapshot,contract)
    path=pathlib.Path(result['ledger']);ledger=json.loads(path.read_text());ledger['release']='R144';ledger['extensionSourcePatchSha256']=hashlib.sha256((root/'r144-source-changes.json').read_bytes()).hexdigest();path.write_text(json.dumps(ledger,indent=2)+'\n');result['ledgerSha256']=helper['sha'](path)
elif args.kind=='native':
    log=args.native_log.read_text(encoding='utf-8-sig').replace('\r','')
    summaries=re.findall(r'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;',log)
    assert summaries and all(row[0]=='ok' and row[2]=='0' for row in summaries)
    assert summaries.count(('ok','238','0','2'))==1,'Require exact Windows root inventory: 238 passed and 2 preexisting ignored'
    assert sum(int(row[3]) for row in summaries)==2
    required=value['tests']+['transactional_core::actor::tests::'+name for name in ['klippy_shutdown_keeps_live_transport_and_actual_fault','klippy_ready_resets_clock_and_accepts_new_websocket_generation','klippy_full_query_clock_reset_allows_following_deltas','klippy_shutdown_reads_info_when_object_queries_are_unavailable','klippy_ready_is_recovered_without_ready_notification','klippy_restart_resubscribes_on_the_same_real_websocket']]
    for name in required:assert re.search(r'^test '+re.escape(name)+r' \.\.\. ok\s*$',log,re.MULTILINE),'Required native regression not executed: '+name
    result={'passed':True,'rootPassed':238,'rootIgnored':2,'rootFailed':0,'requiredCases':len(required),'newNativeCases':6,'nativeLogSha256':helper['sha'](args.native_log),'workspaceSummaries':len(summaries)}
else:
    ledgers={};identity=None
    for kind in ('node','browser'):
        path=args.proof/value['executionLedgers'][kind];ledger=json.loads(path.read_text())
        assert ledger['release']=='R144' and ledger['kind']==kind and ledger['passed'] is True
        assert ledger['sourceUnchangedDuringRun'] is True and ledger['buildId']==build_id
        assert ledger['contractSha256']==helper['sha'](contract)
        assert ledger['sourceSnapshot']==snapshot and ledger['sourceSnapshotSha256']==helper['object_sha'](snapshot)
        current_identity=(ledger['githubRunId'],ledger['githubHeadSha'])
        if identity is None:identity=current_identity
        assert current_identity==identity,'Node and browser ledgers belong to different builds'
        for expected,key in [(os.environ.get('GITHUB_RUN_ID'),'githubRunId'),(os.environ.get('GITHUB_SHA'),'githubHeadSha')]:
            if expected is not None:assert ledger[key]==str(expected)
        assert len(ledger['checks'])==len(value[kind+'Checks'])
        for spec,check in zip(value[kind+'Checks'],ledger['checks']):
            assert check['script']==spec['script'] and check['proofEnv']==spec['proofEnv']
            assert check['passed'] is True and check['exitCode']==0 and check['scriptSha256']==snapshot[spec['script']]
            assert check['report']==spec['report'] and check['reportSha256']==helper['sha'](args.proof/spec['report'])
            assert check['logSha256']==helper['sha'](args.proof/check['log'])
        ledgers[kind]=helper['sha'](path)
    result={'reports':helper['verify_reports'](value,args.proof,args.source),'ledgers':ledgers}
record={'stage':args.kind,'release':'R144','sourceFiles':len(snapshot),'sourcePatchSha256':hashlib.sha256((root/'r144-source-changes.json').read_bytes()).hexdigest(),'sourceSnapshotSha256':helper['object_sha'](snapshot),'result':result}
(args.proof/('r144-'+args.kind+'-acceptance.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record))
