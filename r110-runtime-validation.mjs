#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const argument=name=>{
  const prefix=`--${name}=`;
  const inline=process.argv.find(value=>value.startsWith(prefix));
  if(inline)return inline.slice(prefix.length);
  const index=process.argv.indexOf(`--${name}`);
  return index>=0?process.argv[index+1]:undefined;
};
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const PROBE_OUTPUT_LIMIT=2*1024*1024;
const parseProbeResponse=buffer=>{
  if(!buffer.length||buffer.length>PROBE_OUTPUT_LIMIT)throw new Error(`invalid IPC probe output size ${buffer.length}`);
  const response=JSON.parse(buffer.toString('utf8'));
  if(!response||typeof response!=='object'||typeof response.requestId!=='string'||typeof response.ok!=='boolean'){
    throw new Error('invalid IPC probe response schema');
  }
  return response;
};

if(process.argv.includes('--self-test')){
  const value={protocolVersion:4,requestId:'self-test',ok:true,data:{status:'ok'}};
  assert.deepEqual(parseProbeResponse(Buffer.from(JSON.stringify(value))),value);
  assert.throws(()=>parseProbeResponse(Buffer.alloc(0)),/output size/);
  assert.throws(()=>parseProbeResponse(Buffer.from('{}')),/response schema/);
  console.log('headless telemetry runtime harness self-test OK: native IPC probe response contract');
  process.exit(0);
}

const daemonPath=path.resolve(argument('daemon')??'');
assert.ok(daemonPath&&fs.statSync(daemonPath).isFile(),`--daemon must name a built klipper-farmd binary: ${daemonPath}`);
const probePath=path.resolve(argument('probe')??'');
assert.ok(probePath&&fs.statSync(probePath).isFile(),`--probe must name a built klipper-farm-ipc-probe binary: ${probePath}`);
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'klipper-farm-v205-telemetry-'));
const children=new Set();
const output=new Map();
const launch=(command,args,options={})=>{
  const child=spawn(command,args,{cwd:root,stdio:['ignore','pipe','pipe'],...options});
  children.add(child);
  output.set(child,[]);
  const remember=chunk=>{
    const lines=output.get(child);
    if(lines){lines.push(String(chunk));if(lines.length>80)lines.shift()}
  };
  child.stdout?.on('data',remember);
  child.stderr?.on('data',remember);
  child.once('exit',()=>children.delete(child));
  return child;
};
const childOutput=child=>(output.get(child)??[]).join('').slice(-8_000);
const waitFor=async(test,description,timeoutMs=30_000)=>{
  const deadline=Date.now()+timeoutMs;
  let lastError;
  while(Date.now()<deadline){
    try{const value=await test();if(value)return value}catch(error){if(error?.nonRetryable)throw error;lastError=error}
    await delay(100);
  }
  throw new Error(`${description} timed out${lastError?`: ${String(lastError)}`:''}`);
};
const requireChildRunning=(child,description)=>{
  if(child.exitCode===null&&child.signalCode===null)return;
  const error=new Error(`${description} exited before daemon recovery: ${child.exitCode??child.signalCode??'unknown'}${childOutput(child)?`\n${childOutput(child)}`:''}`);
  error.nonRetryable=true;
  throw error;
};
const childExited=child=>child.exitCode!==null||child.signalCode!==null;
const waitForChildExit=(child,timeoutMs)=>new Promise(resolve=>{
  if(childExited(child)){resolve(true);return}
  let settled=false;
  const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);child.off('exit',onExit);resolve(value)};
  const onExit=()=>finish(true);
  const timer=setTimeout(()=>finish(childExited(child)),timeoutMs);
  child.once('exit',onExit);
});
const endpointPath=path.join(temporary,'klipper-farmd.endpoint.json');
const ipc=async(command,payload=null)=>{
  const requestId=crypto.randomBytes(16).toString('hex');
  const request={requestId,command,payload};
  const response=await new Promise((resolve,reject)=>{
    const child=spawn(probePath,['--data-dir',temporary],{
      cwd:root,
      windowsHide:true,
      stdio:['pipe','pipe','pipe'],
    });
    children.add(child);
    child.once('exit',()=>children.delete(child));
    let stdout=Buffer.alloc(0),stderr='',settled=false;
    const timeout=setTimeout(()=>finish(new Error(`IPC probe timeout for ${command}`)),command==='upload_finish'?90_000:12_000);
    const finish=(error,value)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timeout);
      if(error&&child.exitCode===null)child.kill('SIGKILL');
      if(error)reject(error);else resolve(value);
    };
    child.once('error',error=>finish(new Error(`IPC probe failed to start: ${error}`)));
    child.stdout.on('data',chunk=>{
      stdout=Buffer.concat([stdout,chunk]);
      if(stdout.length>PROBE_OUTPUT_LIMIT)finish(new Error(`IPC probe output too large for ${command}`));
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-8_000)});
    child.stdin.once('error',error=>finish(new Error(`IPC probe stdin failed: ${error}`)));
    child.once('close',(code,signal)=>{
      if(settled)return;
      if(code!==0){
        finish(new Error(`IPC probe exited ${code??signal??'unknown'} for ${command}${stderr?`: ${stderr.trim()}`:''}`));
        return;
      }
      try{finish(undefined,parseProbeResponse(stdout))}catch(error){finish(error)}
    });
    child.stdin.end(JSON.stringify(request));
  });
  assert.equal(response.requestId,requestId,`${command}: mismatched request ID`);
  if(!response.ok)throw new Error(`${response.errorDetail?.code??'IPC_REMOTE_ERROR'}: ${response.error??'unknown error'}`);
  return response.data;
};
const actorConfig=(printerId,host,modelId)=>({
  stableId:`runtime-${printerId}`,
  printerId,
  modelId,
  host,
  defaultPort:7125,
  firmwareSignature:null,
  capabilitiesHint:null,
});
const actorList=()=>ipc('actor_list');
const actorById=async printerId=>(await actorList()).find(actor=>actor.printerId===printerId);

let daemon,normalEmulator,restEmulator;
try{
  await(async()=>{
  normalEmulator=launch(process.execPath,[path.join(root,'scripts','hardware-emulator.mjs'),'--host','127.0.0.1','--port','7125','--model','k1c','--mode','normal,nexusp,legacy-upload,keep-alive']);
  restEmulator=launch(process.execPath,[path.join(root,'scripts','hardware-emulator.mjs'),'--host','127.0.0.2','--port','7125','--model','flashforge','--mode','rest-only,keep-alive']);
  await waitFor(async()=>childOutput(normalEmulator).includes('hardware emulator:'),'normal emulator startup');
  await waitFor(async()=>childOutput(restEmulator).includes('hardware emulator:'),'REST-only emulator startup');

  daemon=launch(daemonPath,['--data-dir',temporary]);
  await waitFor(async()=>fs.existsSync(endpointPath)&&await ipc('health'),'headless engine startup');

  await ipc('actor_upsert',{config:actorConfig('printer-ws','127.0.0.1:7125','creality-k1c-2025'),apiKey:null});
  const websocketSnapshot=await waitFor(async()=>{
    const actor=await actorById('printer-ws');
    return actor?.connected&&actor.cachedStatus?.extruder?.temperature?actor:undefined;
  },'headless WebSocket telemetry snapshot',35_000);
  assert.equal(websocketSnapshot.activeProtocol,'websocket');
  assert.ok(websocketSnapshot.lastSeenAt>0,'headless snapshot has no lastSeenAt');
  assert.equal(Math.round(websocketSnapshot.cachedStatus.extruder.temperature),24);

  const neutralFile=Buffer.from('; Neutral regression data only\n'.repeat(1024)+'G90\n');
  const neutralHash=crypto.createHash('sha256').update(neutralFile).digest('hex');
  const filename='neutral-keepalive-test.gcode',ownerId='runtime-regression';
  const begun=await ipc('upload_begin',{ownerId,stableId:'runtime-printer-ws',printerId:'printer-ws',host:'127.0.0.1:7125',filename,fileSize:neutralFile.length,expectedSha256:neutralHash,defaultPort:7125});
  for(let offset=0;offset<neutralFile.length;offset+=64*1024){
    const data=neutralFile.subarray(offset,Math.min(neutralFile.length,offset+64*1024));
    const received=await ipc('upload_chunk',{ownerId,uploadId:begun.uploadId,offset,dataHex:data.toString('hex')});
    assert.equal(received,offset+data.length);
  }
  if(process.argv.includes('--expect-legacy-rejection')){
    await assert.rejects(ipc('upload_finish',{ownerId,uploadId:begun.uploadId}),/Upload HTTP 500.*upload file fail/);
    const rejected=await(await fetch('http://127.0.0.1:7125/emulator/state')).json();
    assert.equal(rejected.uploadAttemptCount,1,'baseline must fail without automatically retrying');
    assert.equal(rejected.uploadCount,0);assert.equal(rejected.moveCount,0);assert.equal(rejected.restMoveCount,0);
    assert.equal(rejected.downloadCount,0);assert.equal(rejected.printStartCount,0);
    assert.ok(rejected.uploadRequests[0].fields.includes('checksum'),'baseline did not exercise the incompatible transactional fields');
    console.log('R109 transactional baseline rejected by strict legacy upload server: HTTP500 upload file fail; one attempt, no move and no start');
    return;
  }
  const finished=await ipc('upload_finish',{ownerId,uploadId:begun.uploadId});
  assert.equal(finished.remoteVerified,true);assert.equal(finished.sha256,neutralHash);assert.equal(finished.path,filename);
  const downloaded=Buffer.from(await (await fetch('http://127.0.0.1:7125/server/files/gcodes/'+filename)).arrayBuffer());
  assert.deepEqual(downloaded,neutralFile,'published remote file differs from the staged source');
  const started=await ipc('actor_rpc',{printerId:'printer-ws',method:'printer.print.start',params:{filename},preferRest:false,timeoutMs:8000,expectedSessionEpoch:null,operationId:null});
  assert.equal(started.state,'confirmed','print start was not confirmed by actor reconciliation');
  await waitFor(async()=>{const actor=await actorById('printer-ws');return actor?.cachedStatus?.print_stats?.state==='printing'&&actor.cachedStatus.print_stats.filename===filename},'confirmed neutral job state');
  const remoteState=await (await fetch('http://127.0.0.1:7125/emulator/state')).json();
  assert.equal(remoteState.uploadCount,1,'upload was sent more than once');assert.equal(remoteState.printStartCount,1,'start was sent more than once');
  assert.equal(remoteState.moveCount,0,'upload must not require RPC rename');
  assert.equal(remoteState.restMoveCount,0,'upload must not require REST rename');
  assert.deepEqual(remoteState.uploadRequests[0].fields,['file','root']);
  assert.equal(remoteState.uploadRequests[0].filename,filename,'original filename was replaced with a temporary name');
  assert.match(remoteState.uploadRequests[0].boundary,/^KlipperFarm[0-9a-f]{32}$/,'upload must use the archived random boundary format');
  assert.equal(remoteState.jsonRpcHttpCount,0,'legacy upload and WebSocket start must not require HTTP JSON-RPC');
  console.log('Legacy end-to-end upload/start OK: exact file+root multipart and original name, no rename or HTTP JSON-RPC request, downloaded bytes verified, one confirmed WebSocket start');

  await fetch('http://127.0.0.1:7125/emulator/start-behavior?mode=ack-only',{method:'POST'});
  await assert.rejects(ipc('actor_rpc',{printerId:'printer-ws',method:'printer.print.start',params:{filename},preferRest:false,timeoutMs:8000,expectedSessionEpoch:null,operationId:null}),/PRINT_START_UNCONFIRMED/);
  const rejectedState=await (await fetch('http://127.0.0.1:7125/emulator/state')).json();
  assert.equal(rejectedState.printStartCount,2,'unconfirmed start was repeated automatically');
  const unconfirmed=await actorById('printer-ws');
  assert.equal(unconfirmed.cachedStatus.print_stats.state,'standby','accepted-only start produced false printing state');
  console.log('Accepted-only start correctly remains unconfirmed; fresh idle status wins over cached printing; exactly one command');
  await fetch('http://127.0.0.1:7125/emulator/start-behavior?mode=normal',{method:'POST'});

  const compatibilityFile=Buffer.from('; Neutral legacy direct upload regression!!\r\n'.repeat(568_181)+'; no final newline');
  const compatibilityHash=crypto.createHash('sha256').update(compatibilityFile).digest('hex');
  const emulatorState=async()=>await (await fetch('http://127.0.0.1:7125/emulator/state')).json();
  const stageFile=async(file,name,assertBegin=()=>{})=>{
    const hash=crypto.createHash('sha256').update(file).digest('hex');
    const staged=await ipc('upload_begin',{ownerId,stableId:'runtime-printer-ws',printerId:'printer-ws',host:'127.0.0.1:7125',filename:name,fileSize:file.length,expectedSha256:hash,defaultPort:7125});
    assertBegin(staged);
    for(let offset=0;offset<file.length;offset+=512*1024){
      const data=file.subarray(offset,Math.min(file.length,offset+512*1024));
      assert.equal(await ipc('upload_chunk',{ownerId,uploadId:staged.uploadId,offset,dataHex:data.toString('hex')}),offset+data.length);
    }
    return staged;
  };
  const assertLegacyUpload=(before,after,name,file)=>{
    assert.equal(after.uploadAttemptCount-before.uploadAttemptCount,1,'legacy upload must be sent exactly once');
    assert.equal(after.uploadCount-before.uploadCount,1);
    assert.equal(after.downloadCount-before.downloadCount,1,'uploaded bytes must be independently downloaded once');
    assert.equal(after.moveCount,before.moveCount,'legacy upload used RPC rename');
    assert.equal(after.restMoveCount,before.restMoveCount,'legacy upload used REST rename');
    const request=after.uploadRequests.at(-1);
    assert.deepEqual(request.fields,['file','root']);assert.equal(request.filename,name);assert.equal(request.size,file.length);
    assert.equal(request.sha256,crypto.createHash('sha256').update(file).digest('hex'));
    assert.match(request.boundary,/^KlipperFarm[0-9a-f]{32}$/);
    assert.notEqual(request.boundary,before.uploadRequests.at(-1)?.boundary,'multipart boundary was reused');
  };
  const compatibilityName='neutral original (legacy)-25MB.gcode';
  const beforeLarge=await emulatorState(),largeStaged=await stageFile(compatibilityFile,compatibilityName);
  const largeResult=await ipc('upload_finish',{ownerId,uploadId:largeStaged.uploadId});
  assert.equal(largeResult.path,compatibilityName);assert.equal(largeResult.sha256,compatibilityHash);assert.equal(largeResult.remoteVerified,true);
  assertLegacyUpload(beforeLarge,await emulatorState(),compatibilityName,compatibilityFile);
  const exactRemote=Buffer.from(await(await fetch('http://127.0.0.1:7125/server/files/gcodes/'+encodeURIComponent(compatibilityName))).arrayBuffer());
  assert.deepEqual(exactRemote,compatibilityFile,'large uploaded original-name file differs from the source');
  const largeStart=await ipc('actor_rpc',{printerId:'printer-ws',method:'printer.print.start',params:{filename:compatibilityName},preferRest:false,timeoutMs:8000,expectedSessionEpoch:null,operationId:null});
  assert.equal(largeStart.state,'confirmed');
  assert.equal((await emulatorState()).printStartCount-beforeLarge.printStartCount,1,'large file start was sent more than once');
  console.log(`Legacy ${compatibilityFile.length}-byte upload OK: only file+root, exact original filename and downloaded bytes, no rename, one confirmed start`);
  await fetch('http://127.0.0.1:7125/emulator/start-behavior?mode=normal',{method:'POST'});

  const replacementFile=Buffer.from('; Neutral same-name replacement, different source transaction\nG90\n');
  const beforeReplacement=await emulatorState(),replacement=await stageFile(replacementFile,compatibilityName);
  assert.notEqual(replacement.uploadId,largeStaged.uploadId,'different file content reused the previous transaction');
  const replacementResult=await ipc('upload_finish',{ownerId,uploadId:replacement.uploadId});
  assert.equal(replacementResult.path,compatibilityName);assert.equal(replacementResult.remoteVerified,true);
  assertLegacyUpload(beforeReplacement,await emulatorState(),compatibilityName,replacementFile);
  assert.deepEqual(Buffer.from(await(await fetch('http://127.0.0.1:7125/server/files/gcodes/'+encodeURIComponent(compatibilityName))).arrayBuffer()),replacementFile,'same-name upload did not overwrite the previous contents');
  assert.equal((await emulatorState()).files.filter(name=>name===compatibilityName).length,1);
  console.log('Same original filename accepted for a new transaction: previous contents overwritten and independently verified; no temporary remote name or move');

  const beforeRestore=await emulatorState();
  const restored=await stageFile(compatibilityFile,compatibilityName,begunAgain=>{
    assert.equal(begunAgain.uploadId,largeStaged.uploadId,'A/B/A regression must reuse the original deterministic transaction ID');
    assert.equal(begunAgain.completedPath,null,'completed transaction cache skipped a fresh A/B/A upload');
    assert.equal(begunAgain.receivedSize,0,'completed transaction reused stale local staging bytes');
  });
  const restoredResult=await ipc('upload_finish',{ownerId,uploadId:restored.uploadId});
  assert.equal(restoredResult.path,compatibilityName);assert.equal(restoredResult.remoteVerified,true);assert.equal(restoredResult.sha256,compatibilityHash);
  const afterRestore=await emulatorState();
  assertLegacyUpload(beforeRestore,afterRestore,compatibilityName,compatibilityFile);
  assert.equal(afterRestore.printStartCount,beforeRestore.printStartCount,'A/B/A upload automatically started printing');
  assert.deepEqual(Buffer.from(await(await fetch('http://127.0.0.1:7125/server/files/gcodes/'+encodeURIComponent(compatibilityName))).arrayBuffer()),compatibilityFile,'A/B/A upload retained replacement B instead of restoring original A');
  console.log('A/B/A same-name regression OK: completed A transaction restaged from zero, one fresh upload/download restores exact A bytes after B; no automatic start');

  await fetch('http://127.0.0.1:7125/emulator/upload-behavior?mode=corrupt-bytes',{method:'POST'});
  const beforeCorrupt=await emulatorState(),corruptName='neutral corrupt legacy.gcode',corruptStaged=await stageFile(compatibilityFile,corruptName);
  await assert.rejects(ipc('upload_finish',{ownerId,uploadId:corruptStaged.uploadId}),/SHA-256 удалённого файла не совпадает.*downloaded/);
  const afterCorrupt=await emulatorState();
  assertLegacyUpload(beforeCorrupt,afterCorrupt,corruptName,compatibilityFile);
  assert.equal(afterCorrupt.printStartCount,beforeCorrupt.printStartCount,'corrupt file was started');
  const corruptMetadata=await(await fetch('http://127.0.0.1:7125/server/files/metadata?filename='+encodeURIComponent(corruptName))).json();
  assert.equal(corruptMetadata.result.sha256,compatibilityHash,'corruption regression must advertise a falsely matching metadata hash');
  console.log(`Corrupt ${compatibilityFile.length}-byte legacy upload refused: actual downloaded SHA wins over matching metadata, one upload, no move and no start`);

  await fetch('http://127.0.0.1:7125/emulator/upload-behavior?mode=generic-500',{method:'POST'});
  const beforeFailure=await emulatorState(),failedName='neutral server failure.gcode',failedStaged=await stageFile(replacementFile,failedName);
  await assert.rejects(ipc('upload_finish',{ownerId,uploadId:failedStaged.uploadId}),/Upload HTTP 500.*simulated upload server failure/);
  const afterFailure=await emulatorState();
  assert.equal(afterFailure.uploadAttemptCount-beforeFailure.uploadAttemptCount,1,'generic500 caused an automatic upload retry');
  assert.equal(afterFailure.uploadCount,beforeFailure.uploadCount);assert.equal(afterFailure.downloadCount,beforeFailure.downloadCount);
  assert.equal(afterFailure.moveCount,beforeFailure.moveCount);assert.equal(afterFailure.restMoveCount,beforeFailure.restMoveCount);assert.equal(afterFailure.printStartCount,beforeFailure.printStartCount);
  assert.ok(!afterFailure.files.includes(failedName));
  console.log('Generic upload HTTP500 preserved: exactly one attempt, no automatic retry, no move and no start');
  await fetch('http://127.0.0.1:7125/emulator/upload-behavior?mode=normal',{method:'POST'});

  await ipc('actor_upsert',{config:actorConfig('printer-rest','127.0.0.2:7125','flashforge-ad5m'),apiKey:null});
  const restSnapshot=await waitFor(async()=>{
    const actor=await actorById('printer-rest');
    return actor&&!actor.connected&&actor.reconnectAttempt>0?actor:undefined;
  },'REST-only actor fallback readiness',20_000);
  const restInfo=await ipc('actor_rpc',{
    printerId:'printer-rest',method:'server.info',params:null,preferRest:true,timeoutMs:4_000,
    expectedSessionEpoch:null,operationId:null,
  });
  assert.equal(restInfo.result.klippy_state,'ready');
  const restStatus=await ipc('actor_rpc',{
    printerId:'printer-rest',method:'printer.objects.query',params:{objects:{print_stats:null,extruder:null,heater_bed:null}},preferRest:true,timeoutMs:4_000,
    expectedSessionEpoch:null,operationId:null,
  });
  assert.equal(Math.round(restStatus.result.status.extruder.temperature),24);
  assert.equal(restSnapshot.connected,false);

  const persistedEpoch=websocketSnapshot.sessionEpoch;
  const beforeRestart=await ipc('health');
  assert.equal(beforeRestart.actorsLive,2,'both actors must be live before the daemon restart');
  daemon.kill('SIGTERM');
  await waitFor(async()=>daemon.exitCode!==null||daemon.signalCode!==null,'headless engine shutdown',10_000);
  await delay(250);
  requireChildRunning(normalEmulator,'normal WebSocket emulator');
  requireChildRunning(restEmulator,'REST-only emulator');
  daemon=launch(daemonPath,['--data-dir',temporary]);
  const restartedHealth=await waitFor(
    async()=>fs.existsSync(endpointPath)&&await ipc('health'),
    'headless engine restart',
  );
  assert.equal(
    restartedHealth.actorsBootstrapped,
    2,
    `daemon did not restore both durable actor registrations: ${JSON.stringify(restartedHealth)}`,
  );
  const restoredActors=await actorList();
  assert.deepEqual(
    new Set(restoredActors.map(actor=>actor.printerId)),
    new Set(['printer-ws','printer-rest']),
    `restored actor registry is incomplete: ${JSON.stringify(restoredActors)}`,
  );
  const recovered=await waitFor(async()=>{
    requireChildRunning(normalEmulator,'normal WebSocket emulator');
    const actor=await actorById('printer-ws');
    if(actor?.connected&&actor.cachedStatus?.extruder?.temperature)return actor;
    throw new Error(`restored actor is not connected: ${JSON.stringify(actor??null)}`);
  },'persisted headless actor recovery',35_000);
  assert.ok(recovered.sessionEpoch>=persistedEpoch,'actor session epoch moved backwards after daemon restart');

  // Powered-off devices must not interrupt a healthy device's telemetry or
  // block the desktop snapshot API. These are loopback-only closed endpoints.
  for(let index=3;index<=6;index++){
    await ipc('actor_upsert',{config:actorConfig(`printer-offline-${index}`,`127.0.0.${index}:7125`,'custom'),apiKey:null});
  }
  for(let sample=0;sample<12;sample++){
    await delay(1000);
    const started=Date.now(),actors=await actorList(),healthy=actors.find(actor=>actor.printerId==='printer-ws');
    assert.ok(Date.now()-started<2500,'offline devices blocked the snapshot API');
    assert.ok(healthy?.connected,'offline devices disconnected the healthy actor');
    assert.ok(Date.now()-healthy.lastSeenAt<10_000,'healthy telemetry became stale while offline devices retried');
  }
  console.log('Mixed fleet runtime OK: four offline devices alongside fresh WebSocket telemetry and responsive snapshots');

  console.log('headless telemetry runtime OK: WebSocket snapshots, REST-only RPC fallback and daemon actor recovery are physical');
  })();
}catch(error){
  const diagnostics=[daemon,normalEmulator,restEmulator].filter(Boolean).map(child=>childOutput(child)).filter(Boolean).join('\n');
  if(diagnostics)process.stderr.write(`\nRuntime child diagnostics:\n${diagnostics}\n`);
  throw error;
}finally{
  const cleanupChildren=[...children];
  for(const child of cleanupChildren)if(!childExited(child))child.kill('SIGTERM');
  await Promise.all(cleanupChildren.map(child=>waitForChildExit(child,2_000)));
  for(const child of cleanupChildren)if(!childExited(child))child.kill('SIGKILL');
  const stopped=await Promise.all(cleanupChildren.map(child=>waitForChildExit(child,5_000)));
  assert.ok(stopped.every(Boolean),'runtime harness left a child process alive; installer launch is blocked');
  if(path.basename(temporary).startsWith('klipper-farm-v205-telemetry-'))fs.rmSync(temporary,{recursive:true,force:true});
}
