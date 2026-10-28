import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';
const compiled=await build({stdin:{contents:"export {VoiceAssistant} from './src/lib/voiceAssistant';export * from './src/lib/voiceCommands';export {emptyFilamentInventory} from './src/lib/filamentInventory';export {profileForPreset} from './src/lib/printerProfile';export {MoonrakerClient} from './src/lib/moonraker';export {offlineRussianVoice,speakOffline} from './src/lib/offlineSpeech';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
globalThis.window=new EventTarget();globalThis.document=new EventTarget();globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
const {VoiceAssistant,parseVoiceCommand,voicePrinterMatches,voiceFileMatches,voiceFileNearMatch,emptyFilamentInventory,profileForPreset,MoonrakerClient,offlineRussianVoice,speakOffline}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const report=[];const test=async(name,fn)=>{await fn();report.push({name,passed:true});console.log('PASS',name)};
const printer=(id='max',name='K1 Max',preset='creality-k1-max')=>({id,name,host:'192.168.1.10',profile:profileForPreset(preset),status:{state:'ready',connectionState:'online'},webcams:[]});
function fixture(){
 const data={printers:[printer()],role:true,clock:1_000_000,upload:0,start:0,checks:0,ready:0,list:0,client:{},audit:0,files:[{path:'корпус/Корпус.gcode',size:150}],inventory:emptyFilamentInventory()};
 const deps={printers:()=>data.printers,canOperate:()=>data.role,client:()=>data.client,now:()=>data.clock,list:async()=>{data.list++;return data.files},inventory:async()=>data.inventory,validate:async()=>({sha256:'a'.repeat(64),report:{ok:true,issues:[]}}),ready:async()=>{data.ready++},upload:async(p,proposal)=>{assert.equal(proposal.sha256,'a'.repeat(64));data.upload++;return proposal.candidate.entry.path},start:async()=>{data.start++},check:async()=>{data.checks++;return true},audit:async()=>{data.audit++}};
 return{data,deps,assistant:new VoiceAssistant(deps)};
}
await test('Russian print phrases and spoken printer aliases',()=>{
 for(const text of ['Напечатай корпус на кей один макс','Найди корпус и поставь на печать на K1 Max','Поставь на печать корпус на K1 Max'])assert.deepEqual(parseVoiceCommand(text),{kind:'print',query:'корпус',printerHint:'k1 max'});
 assert.deepEqual(parseVoiceCommand('найди корпус и поставь на печать'),{kind:'print',query:'корпус',printerHint:''});
 assert.equal(voicePrinterMatches([printer()], 'кей один макс').length,1);assert(voiceFileMatches('details/korpus.gcode','корпус'));
 assert.deepEqual(parseVoiceCommand('напечатать корпус на принтере макс'),{kind:'print',query:'корпус',printerHint:'max'});
 assert.deepEqual(parseVoiceCommand('напечатаю корпус на принтере макс'),{kind:'print',query:'корпус',printerHint:'max'});
 assert.equal(voicePrinterMatches([printer()],'макс').length,1);
 assert.equal(parseVoiceCommand('да').kind,'help');assert.equal(parseVoiceCommand('не подтверждаю печать').kind,'help');
});
await test('printer-first commands, spoken Max variants and conflicting targets',async()=>{
 for(const name of ['к1 макс','к1 мах','ка один макс','кей один макс','к1мах','к 1 макс','K1MAX']){
  const text='Принтер '+name+' поставь на печать корпус';
  assert.deepEqual(parseVoiceCommand(text),{kind:'print',query:'корпус',printerHint:'k1 max'});
  const f=fixture(),reply=await f.assistant.handle(text);assert(reply.proposal);assert.equal(f.data.start,0);
 }
 assert.deepEqual(parseVoiceCommand('На принтере K1 Max, напечатай файл корпус, пожалуйста'),{kind:'print',query:'корпус',printerHint:'k1 max'});
 for(const text of ['не напечатай корпус','принтер k1 max не поставь на печать корпус','принтер k1 max напечатай корпус на 5m'])assert.equal(parseVoiceCommand(text).kind,'help');
});
await test('misheard file names are suggested and never automatically prepared or launched',async()=>{
 assert.equal(voiceFileMatches('детали/кронштейн.gcode','конштейн'),false);
 assert.equal(voiceFileNearMatch('детали/кронштейн.gcode','конштейн'),true);
 assert.equal(voiceFileNearMatch('корпус A12.gcode','корпус A13'),false);
 assert.equal(voiceFileNearMatch('деталь.gcode','дел'),false);
 const f=fixture();f.data.files=[{path:'детали/кронштейн.gcode',size:150}];
 const r=await f.assistant.handle('Принтер К1 Макс поставь на печать конштейн');
 assert.equal(r.choices.length,1);assert(!r.proposal);assert.equal(f.data.upload,0);
 await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.start,0);
 const selected=await f.assistant.handle('Выбери первый');assert(selected.proposal);assert.equal(f.data.start,0);
 await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.start,1);
});
await test('find never uploads; confirmation requires an explicitly selected proposal',async()=>{const f=fixture();const r=await f.assistant.handle('Найди корпус');assert.equal(r.choices.length,1);await f.assistant.handle('подтверждаю печать');assert.equal(f.data.start,0)});
await test('one selected file, separately confirmed, transfers and starts exactly once',async()=>{const f=fixture();const r=await f.assistant.handle('Напечатай корпус на K1 Max');assert(r.proposal);assert.equal(f.data.start,0);const done=await f.assistant.handle('Подтверждаю печать');assert.match(done.text,/подтвердил запуск/);await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.start,1);assert.equal(f.data.upload,1);assert.equal(f.data.ready,2)});
await test('duplicate names and multiple model printers require explicit choice',async()=>{const f=fixture();f.data.printers.push(printer('max2','Второй Max'));const r=await f.assistant.handle('Напечатай корпус');assert.equal(r.choices.length,2);assert(!r.proposal);const chosen=await f.assistant.handle('Выбери второй');assert.equal(chosen.proposal.candidate.printerId,'max2');assert.equal(f.data.start,0)});
await test('different model libraries are searched once each without cross-model dispatch',async()=>{const f=fixture();f.data.printers.push(printer('5m','5M','flashforge-ad5m'));const r=await f.assistant.handle('Напечатай корпус на пять эм');assert.equal(r.proposal.candidate.printerId,'5m');assert.equal(r.proposal.candidate.scopeId,'model:flashforge-ad5m');assert.equal(f.data.list,1)});
for(const state of ['printing','paused','error','offline'])await test('blocked printer '+state,async()=>{const f=fixture();f.data.printers[0].status.state=state;assert(!(await f.assistant.handle('Напечатай корпус на K1 Max')).proposal);assert.equal(f.data.upload,0)});
await test('viewer cannot prepare or launch',async()=>{const f=fixture();f.data.role=false;assert(!(await f.assistant.handle('Напечатай корпус на K1 Max')).proposal);assert.equal(f.data.start,0)});
await test('expiry and cancellation invalidate confirmation',async()=>{for(const cancel of [false,true]){const f=fixture();await f.assistant.handle('Напечатай корпус на K1 Max');if(cancel)await f.assistant.handle('Отмена');else f.data.clock+=90_001;await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.start,0)}});
for(const mutation of ['host','profile','client','role'])await test('change before confirmation '+mutation,async()=>{const f=fixture();await f.assistant.handle('Напечатай корпус на K1 Max');if(mutation==='host')f.data.printers[0].host='192.168.1.11';if(mutation==='profile')f.data.printers[0].profile=profileForPreset('flashforge-ad5m');if(mutation==='client')f.data.client={};if(mutation==='role')f.data.role=false;await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.upload,0);assert.equal(f.data.start,0)});
await test('target changes during upload never launch on the changed printer',async()=>{const f=fixture();f.deps.upload=async()=>{f.data.printers[0].host='192.168.1.12';return 'корпус.gcode'};await f.assistant.handle('Напечатай корпус на K1 Max');await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.start,0)});
await test('fresh readiness failure stops before upload',async()=>{const f=fixture();f.deps.ready=async()=>{throw new Error('busy')};await f.assistant.handle('Напечатай корпус на K1 Max');await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.upload,0)});
await test('changed file hash cannot be uploaded and started',async()=>{const f=fixture();f.deps.upload=async()=>{throw new Error('SHA256 differs')};await f.assistant.handle('Напечатай корпус на K1 Max');const r=await f.assistant.handle('Подтверждаю печать');assert.match(r.text,/SHA256/);assert.equal(f.data.start,0)});
await test('G-code validation errors block confirmation',async()=>{const f=fixture();f.deps.validate=async()=>({sha256:'x',report:{ok:false,issues:[{level:'error',message:'За пределами стола'}]}});const r=await f.assistant.handle('Напечатай корпус на K1 Max');assert.match(r.text,/пределами/);await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.start,0)});
await test('lost start response permits read-only recovery and never repeats a launch',async()=>{const f=fixture();f.deps.start=async()=>{f.data.start++;throw new Error('PRINT_START_UNCONFIRMED')};await f.assistant.handle('Напечатай корпус на K1 Max');assert((await f.assistant.handle('Подтверждаю печать')).unconfirmed);await f.assistant.handle('Подтверждаю печать');await f.assistant.handle('Напечатай корпус на K1 Max');await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.start,1);const r=await f.assistant.handle('Проверь запуск');assert.match(r.text,/подтверждён/);assert.equal(f.data.checks,1);assert.equal(f.data.upload,1)});
await test('stock uses actual loose stock plus spool balance exactly once',async()=>{const f=fixture();f.data.inventory.materials.PLA.looseGrams=500;f.data.inventory.spools=[{id:'s1',name:'PLA',material:'PLA',remainingWeight:750,initialWeight:1000,price:0,currency:'RUB',createdAt:1}];f.data.inventory.printers.max={binding:{spoolId:'s1'}};assert.match((await f.assistant.handle('Сколько осталось пластика?')).text,/1.250/);assert.match((await f.assistant.handle('Сколько пластика на кей один макс?')).text,/750/)});
await test('stock read failure is never announced as zero stock',async()=>{const f=fixture();f.deps.inventory=async()=>{throw new Error('SQLITE_BUSY')};assert.match((await f.assistant.handle('Сколько осталось пластика?')).text,/SQLITE_BUSY/)});
await test('concurrent request cannot consume a second print command',async()=>{const f=fixture();let done;f.deps.upload=()=>new Promise(resolve=>{done=resolve});await f.assistant.handle('Напечатай корпус на K1 Max');const first=f.assistant.handle('Подтверждаю печать');await new Promise(resolve=>setTimeout(resolve,0));const second=await f.assistant.handle('Подтверждаю печать');assert.match(second.text,/Повторный запуск/);done('корпус.gcode');await first;assert.equal(f.data.start,1)});
await test('cancel during analysis cannot leave a printable proposal',async()=>{const f=fixture();let done;f.deps.validate=()=>new Promise(resolve=>{done=resolve});const first=f.assistant.handle('Напечатай корпус на K1 Max');await new Promise(resolve=>setTimeout(resolve,0));await f.assistant.handle('Отмена');done({sha256:'a'.repeat(64),report:{ok:true,issues:[]}});await first;await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.start,0)});
for(const state of ['standby','printing','error',''])await test('actual Moonraker read-only preflight '+(state||'missing-state'),async()=>{const methods=[];const fake={runControlRequest:run=>run(),rpc:async method=>{methods.push(method);return method==='printer.info'?{state:'ready'}:{status:{print_stats:{state},virtual_sdcard:{is_active:false}}}}};assert.equal(await MoonrakerClient.prototype.checkIdleReady.call(fake),state==='standby');assert.deepEqual(methods,['printer.info','printer.objects.query'])});
await test('spoken answers select only an installed local Russian voice',()=>{
 let voices=[{lang:'ru-RU',localService:false,name:'Cloud Russian'},{lang:'en-US',localService:true,name:'Local English'}],spoken=[];
 globalThis.speechSynthesis=window.speechSynthesis={getVoices:()=>voices,cancel:()=>{},speak:u=>spoken.push(u)};
 globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text}};
 assert.equal(offlineRussianVoice(),undefined);assert.equal(speakOffline('Привет'),false);assert.equal(spoken.length,0);
 voices.push({lang:'ru-RU',localService:true,name:'Installed Russian'});assert.equal(speakOffline('Осталось 500 грамм'),true);assert.equal(spoken.length,1);assert.equal(spoken[0].voice.name,'Installed Russian');
});
if(process.env.KF_VOICE_PROOF)fs.writeFileSync(process.env.KF_VOICE_PROOF,JSON.stringify({passed:true,cases:report.length,report},null,2)+'\n');
console.log('Voice assistant:',report.length,'cases passed');
