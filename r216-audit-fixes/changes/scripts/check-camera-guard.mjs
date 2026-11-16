import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from './typescript-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
const source=fs.readFileSync(path.join(root,'src/lib/cameraGuard.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},fileName:'cameraGuard.ts',reportDiagnostics:true});
assert.equal(compiled.diagnostics?.length??0,0);
const g=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
let checks=0;
const check=(name,run)=>{run();checks++;console.log(`PASS ${name}`)};
const start=1_000_000;
const printer=(at,extra={},id='p1')=>({id,name:id,host:'192.168.1.5:7125',webcams:[],status:{state:'printing',connectionState:'online',filename:'part.gcode',printDuration:100+(at-start)/1000,jobUpdatedAt:at,progress:.1,nozzle:200,nozzleTarget:200,bed:60,bedTarget:60,...extra}});
const create=(mode='pause')=>{const machine=new g.CameraGuardMachine();machine.setSettings({version:1,printers:{p1:{mode}}});machine.observe([printer(start)],start);return machine};
const frame=(machine,at,{score=.7,token=`frame-${at}`,sourceEpoch='source-1',jobToken=machine.jobToken('p1',at),status={}}={})=>{
  machine.observe([printer(at,status)],at);
  const ticket=machine.beginFrame('p1',{capturedAt:at,frameToken:token,sourceEpoch,jobToken},at);
  return ticket?machine.completeFrame(ticket,score,at):undefined;
};
const trigger=(machine=create())=>{let result;for(const offset of [0,8_000,16_000,24_000])result=frame(machine,start+offset);assert(result);return result};
check('default off; invalid persisted settings fail closed',()=>{
  const machine=new g.CameraGuardMachine();machine.observe([printer(start)],start);
  assert.equal(machine.mode('p1'),'off');assert.deepEqual(machine.activePrinterIds(start),[]);
  for(const invalid of [{},[],{version:2,printers:{}},{version:1,printers:{p1:{mode:'automatic'}}}])assert.throws(()=>g.restoreCameraGuardSettings(invalid));
  assert.deepEqual(g.restoreCameraGuardSettings(null),{version:1,printers:{}});
});
check('four different high-score frames over 24 seconds; ACK is not a confirmed pause',()=>{
  const machine=create();
  for(const offset of [0,8_000,16_000])assert.equal(frame(machine,start+offset),undefined);
  const found=frame(machine,start+24_000);assert(found);assert.equal(machine.status('p1',start+24_000).phase,'pausing');
  assert(machine.markPauseSent(found,start+24_000));assert.equal(machine.status('p1',start+24_001).phase,'pausing');assert.deepEqual(machine.drainEvents(),[]);
  machine.observe([printer(start+25_000,{state:'paused'})],start+25_000);
  assert.equal(machine.status('p1',start+25_000).phase,'paused');assert.equal(machine.drainEvents().filter(event=>event.kind==='paused').length,1);
  machine.observe([printer(start+26_000,{state:'paused'})],start+26_000);assert.deepEqual(machine.drainEvents(),[]);
});
check('normal/intermittent/too-fast results do not pause',()=>{
  const machine=create();
  for(const [offset,score] of [[0,.8],[8_000,.1],[16_000,.8],[24_000,.8],[32_000,.1],[40_000,.8]])assert.equal(frame(machine,start+offset,{score}),undefined);
  const fast=create();for(const offset of [0,100,200,300])assert.equal(frame(fast,start+offset),undefined);
});
check('duplicate frame identity, stale frame, bad score and analysis error cannot trigger',()=>{
  const machine=create();frame(machine,start,{token:'same'});
  for(const offset of [8_000,16_000,24_000])assert.equal(frame(machine,start+offset,{token:'same'}),undefined);
  machine.observe([printer(start+30_000)],start+30_000);
  assert.equal(machine.beginFrame('p1',{capturedAt:start,frameToken:'old',sourceEpoch:'source-1',jobToken:machine.jobToken('p1',start+30_000)},start+30_000),undefined);
  frame(machine,start+32_000,{score:Number.NaN});assert.equal(machine.status('p1',start+32_000).phase,'unavailable');
  const clean=create();frame(clean,start);frame(clean,start+8_000);clean.unavailable('p1','Камера недоступна');
  for(const offset of [16_000,24_000,32_000])assert.equal(frame(clean,start+offset),undefined);
});
check('offline, stale telemetry, warmup, paused and unsupported pause prevent control',()=>{
  for(const status of [{state:'offline',connectionState:'offline'},{jobUpdatedAt:start-21_000},{printDuration:59},{state:'paused'},{remoteControlSuspended:true}]){
    const machine=create();machine.observe([printer(start,status)],start);
    assert.equal(machine.beginFrame('p1',{capturedAt:start,frameToken:'x',sourceEpoch:'s',jobToken:machine.jobToken('p1',start)},start),undefined);
  }
  const machine=create(),found=trigger(machine);const p=printer(start+24_000);p.capabilities={canPause:false};machine.observe([p],start+24_000);assert.equal(machine.canPause(found,start+24_000),false);
});
check('camera reconnect and long evidence gaps start a new confirmation series',()=>{
  const machine=create();frame(machine,start);frame(machine,start+8_000);
  for(const offset of [16_000,24_000,32_000])assert.equal(frame(machine,start+offset,{sourceEpoch:'source-2'}),undefined);
  assert(frame(machine,start+40_000,{sourceEpoch:'source-2'}));
  const gap=create();frame(gap,start);frame(gap,start+8_000);
  for(const offset of [40_000,48_000,56_000])assert.equal(frame(gap,start+offset),undefined);
});
check('changing file or restarting same filename invalidates delayed inference',()=>{
  for(const change of [{filename:'next.gcode'},{printDuration:1}]){
    const machine=create(),context={capturedAt:start,frameToken:'late',sourceEpoch:'s',jobToken:machine.jobToken('p1',start)};
    const ticket=machine.beginFrame('p1',context,start);assert(ticket);
    machine.observe([printer(start+1_000,change)],start+1_000);
    assert.equal(machine.completeFrame(ticket,.99,start+1_000),undefined);
    assert.notEqual(machine.jobToken('p1',start+1_000),context.jobToken);
  }
});
check('disable/host switch/new client generation invalidates a queued pause',()=>{
  const machine=create(),found=trigger(machine);machine.setSettings({version:1,printers:{p1:{mode:'off'}}});assert.equal(machine.markPauseSent(found,start+24_000),false);
  const changed=create(),old=trigger(changed),p=printer(start+24_000);p.host='192.168.1.99:7125';changed.observe([p],start+24_000);assert.equal(changed.markPauseSent(old,start+24_000),false);
});
check('one pause per job across reconnect and manual resume; new job can trigger again',()=>{
  const machine=create(),found=trigger(machine);assert(machine.markPauseSent(found,start+24_000));assert.equal(machine.markPauseSent(found,start+24_001),false);
  machine.observe([printer(start+25_000,{state:'paused'})],start+25_000);machine.drainEvents();
  machine.observe([printer(start+26_000,{state:'offline',connectionState:'offline'})],start+26_000);
  for(const offset of [32_000,40_000,48_000,56_000])assert.equal(frame(machine,start+offset),undefined);
  machine.observe([printer(start+60_000,{state:'ready'})],start+60_000);
  machine.observe([printer(start+61_000,{printDuration:0})],start+61_000);
  assert.notEqual(machine.jobToken('p1',start+61_000),found.jobToken);
});
check('notify mode produces an incident without control; pause confirmation expires once',()=>{
  const notify=create('notify'),found=trigger(notify);assert.equal(found.mode,'notify');assert.equal(notify.canPause(found,start+24_000),false);assert.equal(notify.status('p1',start+24_000).phase,'warning');
  const machine=create(),pending=trigger(machine);machine.markPauseSent(pending,start+24_000);
  machine.observe([printer(start+45_000)],start+45_000);assert.equal(machine.status('p1',start+45_000).phase,'failed');assert.equal(machine.drainEvents().filter(event=>event.kind==='pause_failed').length,1);
  machine.observe([printer(start+46_000)],start+46_000);assert.deepEqual(machine.drainEvents(),[]);assert.equal(machine.markPauseSent(pending,start+46_000),false);
});
check('durable incident suppresses restart duplicate conservatively until a new observed job',()=>{
  const machine=create();trigger(machine);const saved=JSON.parse(JSON.stringify(machine.storedLatches()));
  const restarted=create();restarted.restoreLatches(g.restoreCameraGuardLatches(saved));
  // Startup uses a fresh tracker, matching the hook's load sequence.
  const restored=new g.CameraGuardMachine();restored.setSettings({version:1,printers:{p1:{mode:'pause'}}});restored.restoreLatches(saved);restored.observe([printer(start+30_000)],start+30_000);
  assert.equal(restored.status('p1',start+30_000).phase,'latched');assert.deepEqual(restored.activePrinterIds(start+30_000),[]);
  restored.observe([printer(start+31_000,{printDuration:0})],start+31_000);assert.deepEqual(restored.storedLatches(),{});
  assert.throws(()=>g.restoreCameraGuardLatches({p1:{mode:'pause'}}));
});
check('seven printers all receive independent analysis tickets and cannot share incident evidence',()=>{
  const machine=new g.CameraGuardMachine();machine.setSettings({version:1,printers:Object.fromEntries(Array.from({length:7},(_,i)=>[`p${i}`,{mode:'pause'}]))});
  for(const offset of [0,8_000,16_000,24_000]){
    const at=start+offset;machine.observe(Array.from({length:7},(_,i)=>printer(at,{},`p${i}`)),at);
    let accepted=0;
    for(let i=0;i<7;i++){
      const id=`p${i}`,ticket=machine.beginFrame(id,{capturedAt:at,frameToken:`${id}-${at}`,sourceEpoch:id,jobToken:machine.jobToken(id,at)},at);assert(ticket);accepted++;
      const result=machine.completeFrame(ticket,i===6?.7:.01,at);assert.equal(!!result,i===6&&offset===24_000);
    }
    assert.equal(accepted,7);
  }
});
check('successful observation expires and does not claim protection without fresh frames',()=>{
  const machine=create();frame(machine,start,{score:.01});assert.equal(machine.status('p1',start).tone,'success');
  machine.observe([printer(start+26_000)],start+26_000);assert.equal(machine.status('p1',start+26_000).phase,'unavailable');
});

// The inference promise may settle after a user changes mode or a different job starts.
for(const changed of ['off','job','host','stale','camera']){
  const machine=create();for(const offset of [0,8_000,16_000])assert.equal(frame(machine,start+offset),undefined);
  const capturedAt=start+24_000;machine.observe([printer(capturedAt)],capturedAt);
  const ticket=machine.beginFrame('p1',{capturedAt,frameToken:'async',sourceEpoch:'source-1',jobToken:machine.jobToken('p1',capturedAt)},capturedAt);assert(ticket);
  let finish;const inference=new Promise(resolve=>{finish=resolve});
  const completedAt=changed==='stale'?capturedAt+16_000:capturedAt+1_000;
  const decision=inference.then(score=>machine.completeFrame(ticket,score,completedAt));
  if(changed==='off')machine.setSettings({version:1,printers:{p1:{mode:'off'}}});
  if(changed==='job')machine.observe([printer(completedAt,{filename:'next.gcode'})],completedAt);
  if(changed==='host'){const p=printer(completedAt);p.host='192.168.1.55:7125';machine.observe([p],completedAt)}
  if(changed==='stale')machine.observe([printer(completedAt)],completedAt);
  if(changed==='camera')machine.unavailable('p1','Камера отключена');
  finish(.99);assert.equal(await decision,undefined,`delayed inference after ${changed} must not control the printer`);checks++;
}
for(const changed of ['off','notify','stale','paused']){
  const machine=create(),found=trigger(machine);let finish;
  const durableWrite=new Promise(resolve=>{finish=resolve});
  const afterPersistence=durableWrite.then(()=>{
    if(machine.mode('p1')!==found.mode||machine.jobToken('p1',start+25_000)!==found.jobToken||!machine.canPause(found,start+25_000))machine.cancelQueued(found,'режим или свежее состояние изменились');
  });
  if(changed==='off'||changed==='notify')machine.setSettings({version:1,printers:{p1:{mode:changed}}});
  if(changed==='stale')machine.observe([printer(start+25_000,{jobUpdatedAt:start})],start+25_000);
  if(changed==='paused')machine.observe([printer(start+25_000,{state:'paused'})],start+25_000);
  finish();await afterPersistence;
  assert.notEqual(machine.status('p1',start+25_000).phase,'pausing',`delayed persistence after ${changed} must not leave a queued incident forever`);
  assert.equal(machine.canPause(found,start+25_000),false);
  assert(machine.storedLatches().p1,'abandoned queued command retains the durable incident latch');
  assert.deepEqual(machine.drainEvents(),[],'intentionally skipped command must not claim pause failure');checks++;
}

const actor=fs.readFileSync(path.join(root,'src-tauri/src/transactional_core/actor.rs'),'utf8');
check('native opt-in pause preflight, metadata stripping and no-replay regressions are present',()=>{
  for(const text of ['camera_pause_guard(request, now_ms())?','"camera_pause_preflight"','if camera_guard.is_some() { None } else { request.params.as_ref() }','if camera_guard.is_some() { None } else { request.params.clone() }','let may_retry = !camera_guarded_pause(request) && match request.repeat_policy','camera_guard_pause_queries_live_job_and_strips_local_metadata','camera_guard_refuses_other_restarted_stale_or_unavailable_jobs_without_pause','camera_guard_does_not_replay_an_ambiguous_pause_and_manual_pause_is_unchanged'])assert(actor.includes(text),text);
  const client=fs.readFileSync(path.join(root,'src/lib/moonraker.ts'),'utf8');
  // Пауза получила предварительную проверку применимости: она выполняется до
  // отправки команды, внутри той же control-очереди.
  assert(client.includes("pause(assertApplicable?:()=>void){ return this.runControlRequest(()=>{assertApplicable?.();return this.rpc('printer.print.pause')},'control.pause'); }"));
  assert(client.includes('if(!this.actorActive||this.closedByUser||this.connectionEpoch!==epoch||this.config.host!==host||!stillApplicable())'));
});
if(process.env.KF_CAMERA_ACTOR_BASELINE){
  let reverted=actor.replace(/fn camera_guarded_pause\([\s\S]*?(?=fn operation_observed\()/,'');
  reverted=reverted.replace(/        let camera_guard = camera_pause_guard\(request, now_ms\(\)\)\?;\n[\s\S]*?(?=        \/\/ A single actor serializes)/,'');
  reverted=reverted.replace(`.is_some_and(|status| operation_observed(request, status)
                        && (!camera_guarded_pause(request) || camera_pause_guard(request, now_ms())
                            .is_ok_and(|guard| guard.is_some_and(|guard| guard.matches(status, now_ms(), true)))))`,'.is_some_and(|status| operation_observed(request, status))');
  reverted=reverted.replace('let may_retry = !camera_guarded_pause(request) && match request.repeat_policy','let may_retry = match request.repeat_policy');
  reverted=reverted.replace(/        let wire_remaining_ms = if camera_guard\.is_some\(\) \{[\s\S]*?        \} else \{ remaining_ms \};\n/,'').replace('.min(wire_remaining_ms)','.min(remaining_ms)');
  reverted=reverted.replace('if camera_guard.is_some() { None } else { request.params.as_ref() }','request.params.as_ref()').replace('if camera_guard.is_some() { None } else { request.params.clone() }','request.params.clone()');
  reverted=reverted.replace(/    struct CameraPauseTransport \{[\s\S]*?(?=    #\[test\]\n    fn arbitrary_gcode_is_never_inferred)/,'');
  assert.equal(reverted.replaceAll('\r\n','\n'),fs.readFileSync(process.env.KF_CAMERA_ACTOR_BASELINE,'utf8').replaceAll('\r\n','\n'),'native actor must return exactly to the published baseline after reversing only the isolated camera changes');
  console.log('PASS exact native actor scope against published baseline');checks++;
}
console.log(`Camera guard: ${checks} checks passed`);
