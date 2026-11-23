import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from './typescript-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const source=relative=>fs.readFileSync(path.join(root,relative),'utf8');
const compile=(relative,replacements={})=>{
  const filename=path.join(root,relative),result=ts.transpileModule(source(relative),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},fileName:filename,reportDiagnostics:true});
  assert.equal(result.diagnostics?.length??0,0,`${relative}: transpile diagnostics`);
  let output=result.outputText;
  for(const [from,to] of Object.entries(replacements))output=output.replaceAll(`'${from}'`,`'${to}'`).replaceAll(`"${from}"`,`"${to}"`);
  return`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
};

const detectionUrl=compile('src/lib/printerDetection.ts');
const profileUrl=compile('src/lib/printerProfile.ts');
const identityUrl=compile('src/lib/deviceIdentity.ts');
const modelSelectionUrl=compile('src/lib/modelSelection.ts',{'./printerDetection':detectionUrl,'./printerProfile':profileUrl,'./deviceIdentity':identityUrl});
const schedulerUrl=compile('src/lib/requestScheduler.ts');
const reliabilityUrl=compile('src/lib/connectionReliability.ts');
const [{classifyPrinterModel,PRINTER_DETECTION_ENGINE_VERSION},{applyModelDetection},{PrinterRequestScheduler},{MoonrakerChannelHealth,ConnectionRecovery},{printerDeviceIdentity,samePhysicalPrinter}]=await Promise.all([
  import(detectionUrl),import(modelSelectionUrl),import(schedulerUrl),import(reliabilityUrl),import(identityUrl),
]);

assert.equal(PRINTER_DETECTION_ENGINE_VERSION,6);
const exact=classifyPrinterModel({identity:{manufacturer:'Creality',model:'K1C 2025'},kinematics:'corexy',geometry:{bedX:220,bedY:220,zMax:250}});
const probable=classifyPrinterModel({identity:{manufacturer:'Creality'},firmware:{distribution:'Creality OS'},kinematics:'corexy',macroNames:['CX_PRINT_START'],geometry:{bedX:300,bedY:300,zMax:300}});
const conflict=classifyPrinterModel({identity:{manufacturer:'Creality',model:'K1C 2025 / K1 Max'},kinematics:'corexy'});
const unknown=classifyPrinterModel({identity:{manufacturer:'Generic'}});
assert.equal(exact.decision,'confirmed');assert.equal(probable.decision,'probable');assert.equal(conflict.decision,'conflict');assert.equal(unknown.decision,'unknown');

const base={id:'p1',name:'Printer',host:'192.168.1.2:7125',icon:'ender',profile:{preset:'ender3-v3-ke',bedX:220,bedY:220,maxZ:240,nozzle:.4,materials:['PLA']},modelSelection:{mode:'automatic',selectedPreset:'ender3-v3-ke'}};
const complete=result=>({...result,facts:{identity:{machineId:'machine-001'}},deviceIdentity:printerDeviceIdentity({identity:{machineId:'machine-001'}}),probeCoverage:{successful:6,total:6,available:[],missing:[]}});
const pending=applyModelDetection(base,complete(probable));
assert.equal(pending.profile.preset,'ender3-v3-ke','probable result changed the active profile without confirmation');
assert.equal(pending.modelSelection.confirmationRequired,true);
assert.equal(pending.modelSelection.pendingPreset,probable.model);
const accepted=applyModelDetection(base,complete(probable),true);assert.equal(accepted.profile.preset,probable.model);
const blocked=applyModelDetection(base,complete(conflict));assert.equal(blocked.modelSelection.lastDetection.decision,'conflict');assert.equal(blocked.modelSelection.appliedFingerprint,undefined);
const universal=applyModelDetection(base,complete(unknown));assert.equal(universal.profile.preset,'custom');

const idA=printerDeviceIdentity({identity:{machineId:'BOARD-ABC-0001',hostname:'old-ip'}}),idB=printerDeviceIdentity({identity:{machineId:'BOARD-ABC-0001',hostname:'new-ip'}}),weak=printerDeviceIdentity({identity:{board:'generic-board',product:'generic-printer'}});
assert.ok(idA?.dedupeSafe&&idB?.dedupeSafe&&samePhysicalPrinter(idA,idB),'stable device ID did not survive hostname/IP change');
assert.equal(weak?.dedupeSafe,false,'weak board/product identity must not merge devices');
const enriched=printerDeviceIdentity({identity:{machineId:'BOARD-ABC-0001',uuid:'OPTIONAL-UUID-FOUND-LATER',serial:'OPTIONAL-SERIAL-FOUND-LATER'}});
assert.equal(enriched?.stableId,idA?.stableId,'optional lower-priority signals rotated an established hardware identity');

const scheduler=new PrinterRequestScheduler(),order=[];
let release;const gate=new Promise(resolve=>{release=resolve});
const first=scheduler.run('background','blocked',async signal=>{await gate;if(signal.aborted){const error=new Error('cancelled');error.name='AbortError';throw error}order.push('background')}).catch(error=>error.name);
const upload=scheduler.run('upload','upload',async()=>{order.push('upload')}).catch(error=>error.name);
const control=scheduler.run('control','control',async()=>{order.push('control')});
const emergency=scheduler.run('emergency','emergency',async()=>{order.push('emergency')});
release();await Promise.all([first,upload,control,emergency]);
assert.deepEqual(order,['emergency','control','upload'],'scheduler priority/preemption order is unsafe');
let coalescedRuns=0;const coalescedA=scheduler.run('background','poll',async()=>{coalescedRuns++;return 7},{coalesceKey:'poll'}),coalescedB=scheduler.run('background','poll duplicate',async()=>9,{coalesceKey:'poll'});assert.equal(await coalescedA,7);assert.equal(await coalescedB,7);assert.equal(coalescedRuns,1);

const channels=new MoonrakerChannelHealth({protocol:'websocket',port:80},()=>.5),primary={protocol:'websocket',port:80},alternative={protocol:'rest',port:7125};
channels.recordFailure(primary,'timeout',1);channels.recordFailure(primary,'timeout',2);assert.ok(!channels.ordered([primary,alternative],3).some(item=>item.port===80),'open circuit remained eligible');channels.recordSuccess(alternative,28,3);assert.equal(channels.active().port,7125,'confirmed fallback did not become sticky');
const recovery=new ConnectionRecovery(()=>.5);for(let index=0;index<5;index++)recovery.failure(index);assert.equal(recovery.snapshot(1_800,10).circuit,'open');recovery.success(20);assert.equal(recovery.snapshot(1_800,20).reconnects,1);

const allSource=fs.readdirSync(path.join(root,'src'),{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()&&/\.tsx?$/.test(entry.name)).map(entry=>source(path.relative(root,path.join(entry.parentPath,entry.name)))).join('\n');
assert.doesNotMatch(allSource,/\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/,'blocking browser dialog remains in source');
for(const marker of ['cancelUpload()','AbortController','appConfirm','diagnosticEntries','samePhysicalPrinter'])assert.ok(allSource.includes(marker),`missing V12 source marker: ${marker}`);
// The upload channel check lives in upload_commands since r241-r248; read its owner too.
const rust=`${source('src-tauri/src/lib.rs')}\n${source('src-tauri/src/upload_commands.rs')}\n${source('src-tauri/src/discovery_commands.rs')}\n${source('src-tauri/src/moonraker_protocol.rs')}\n${source('src-tauri/src/transactional_core/scheduler.rs')}`;
for(const marker of ['DISCOVERY_FAST_WORKERS: usize = 64','DISCOVERY_SLOW_WORKERS: usize = 64','DISCOVERY_DEADLINE: Duration = Duration::from_secs(9)','DISCOVERY_SLOW_PROBE_TIMEOUT','parse_manual_discovery_range','"retrying"','retried: usize'])assert.ok(rust.includes(marker),`missing discovery reliability marker: ${marker}`);
assert.ok(rust.includes('same_printer_channel')&&rust.includes('matches!(requested.socket.port(), 80 | 7125)'),'same-IP 80/7125 failover authorization is missing');
assert.ok(rust.includes('let fast_workers = DISCOVERY_FAST_WORKERS')&&rust.includes('let slow_workers = DISCOVERY_SLOW_WORKERS'),'desktop discovery worker count must stay independent from actor latency state');
const emulator=source('scripts/hardware-emulator.mjs');for(const mode of ['slow','401','404','rest-only','ws-only','corrupt','disk-full','disconnect'])assert.ok(emulator.includes(mode),`emulator mode missing: ${mode}`);
assert.ok(emulator.includes("modes.has('slow')?1_600"),'slow emulator mode must apply a deterministic delayed response');

console.log('hardware reliability checks OK: safe model decisions, stable identity, prioritized scheduler, sticky channels, circuit breaker, cancellation UI, two-pass discovery and emulator modes');
