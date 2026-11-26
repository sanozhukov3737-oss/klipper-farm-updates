import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';

const compiled=await build({stdin:{contents:"export * from './src/lib/voiceSemantic';export {VoiceAssistant} from './src/lib/voiceAssistant';export {VoiceTaskQueue} from './src/lib/voiceTaskQueue';export {emptyFilamentInventory} from './src/lib/filamentInventory';export {profileForPreset} from './src/lib/printerProfile';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const {VoiceAssistant,VoiceTaskQueue,validateVoiceSemanticResult,semanticVoiceIntent,profileForPreset,emptyFilamentInventory}=api;
const results=[],test=async(name,run)=>{await run();results.push({name,passed:true});console.log('PASS',name)};
const printer=(id='max',name='K1 Max',state='ready')=>({id,name,host:'192.168.1.10',apiKey:'not-for-model',profile:profileForPreset(id==='busy'?'creality-k1c-2025':'creality-k1-max'),status:{state,connectionState:'online'},webcams:[]});
function fixture(interpret,options={}){
  const data={printers:[printer(),printer('busy','Занятый','printing')],calls:[],list:[],validate:[],upload:0,start:0,clock:1_000_000,client:{},files:[{path:'детали/держатель.gcode',size:100}],inventory:emptyFilamentInventory()};
  const deps={tasks:options.tasks,printers:()=>data.printers,canOperate:()=>true,client:()=>data.client,now:()=>data.clock,list:async scope=>{data.list.push(scope);return data.files},inventory:async()=>data.inventory,validate:async(p,c)=>{data.validate.push([p.id,c.entry.path]);return{sha256:'a'.repeat(64),report:{ok:true,issues:[],metadata:{filament_type:'PLA',filament_weight_total:25}}}},ready:async()=>{},upload:async()=>{data.upload++;return'держатель.gcode'},start:async()=>{data.start++},check:async()=>true,audit:async()=>{}};
  if(interpret)deps.interpret=async(input,signal)=>{data.calls.push(input);return interpret(input,signal)};
  return{data,assistant:new VoiceAssistant(deps)};
}
const input={text:'Ну кто там не занят?',context:{printers:[{id:'max',name:'K1 Max'}],fileChoices:[],printerChoices:[]}};
await test('file descriptions and custom named printers cannot be stolen by the free-status shortcut',async()=>{
  for(const text of ['Покажи готовый держатель','Покажи свободный куб','Какие готовые крепления у меня есть']){
    const f=fixture(()=>({kind:'find',query:'держатель'}));
    const reply=await f.assistant.handle(text);
    assert.equal(f.data.calls.length,1,text);assert(f.data.list.length>0,text);assert.doesNotMatch(reply.text,/^Сейчас свобод(?:ен|ны)/u,text);assert.equal(f.data.start,0);
  }
  const f=fixture(()=>({kind:'printers',filter:'all',printerId:'max'}));f.data.printers[0].name='Левый';
  assert.equal((await f.assistant.handle('Какие принтеры Левый сейчас свободны?')).text,'Левый: свободен.');
  assert.equal(f.data.calls.length,1);assert.equal(f.data.list.length,0);
});
await test('current stock questions do not inherit a forecast from a previously selected file',()=>{
  const context={...input.context,selectedFile:{name:'держатель'},selectedPrinterId:'max'};
  for(const text of ['Сколько осталось красного PETG?','Какой сейчас остаток пластика?','Покажи текущий запас PLA']){
    const result=validateVoiceSemanticResult({kind:'stock',query:'держатель',afterPrint:true},{text,context});
    assert.equal(result.afterPrint,false,text);assert.equal(result.query,text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim(),text);
  }
  for(const text of ['Сколько останется после печати?','Хватит мне пластика на эту деталь?','Сколько осталось и хватит ли на держатель?']){
    assert.equal(validateVoiceSemanticResult({kind:'stock',afterPrint:true},{text,context}).afterPrint,true,text);
  }
  assert.equal(validateVoiceSemanticResult({kind:'stock',afterPrint:true},{text:'Хватит пластика на эту деталь?',context:input.context}).afterPrint,true);
});

await test('model output is strict data and cannot invent execution or confirmation',()=>{
  for(const value of [null,[],42,'not json','```json\n{"kind":"printers","filter":"free"}\n```',{kind:'confirm'},{kind:'cancel'},{kind:'shell',command:'run'},{kind:'printers',filter:'free',start:true},{kind:'printers',filter:'idle'},{kind:'print',query:'держатель',printerId:'unknown'},{kind:'plan',query:'держатель',quantity:21},{kind:'plan',query:'держатель',quantity:1.5},{kind:'stock',query:'x\ncommand'},{kind:'find',query:'x',usePreviousFile:'true'},{kind:'find',query:'x',usePreviousFile:true},{kind:'find',query:'x',printerId:'max',otherPrinter:true},{kind:'choose',choice:1},{kind:'clarify',reason:'confirm'},{kind:'tasks',__proto__:{kind:'confirm'}}])assert.throws(()=>validateVoiceSemanticResult(value,input),undefined,JSON.stringify(value));
  assert.deepEqual(validateVoiceSemanticResult('{"kind":"printers","filter":"free"}',input),{kind:'printers',filter:'free'});
  assert.throws(()=>validateVoiceSemanticResult(' '.repeat(8193),input));
});
await test('displayed option numbers and bounded references are validated against current context',()=>{
  const choiceInput={...input,context:{...input.context,awaiting:'choice',fileChoices:[{number:2,name:'держатель',printerId:'max'}]}};
  assert.deepEqual(semanticVoiceIntent(validateVoiceSemanticResult({kind:'choose',choice:2},choiceInput),choiceInput.text),{kind:'choose',index:1});
  assert.throws(()=>validateVoiceSemanticResult({kind:'choose',choice:1},choiceInput));
  assert.throws(()=>validateVoiceSemanticResult({kind:'followup',query:'новое имя',correctPreviousQuery:true},input));
});
await test('previous-file and previous-printer references require actual current conversation evidence',()=>{
  const clarification={kind:'clarify',reason:'ambiguous'};
  for(const output of [{kind:'print',query:'',usePreviousFile:true},{kind:'followup',usePreviousFile:true},{kind:'stock',usePreviousPrinter:true},{kind:'find',query:'держатель',otherPrinter:true},{kind:'followup',query:'держатель'},{kind:'followup',printerId:'max'}])assert.deepEqual(validateVoiceSemanticResult(output,input),clarification,JSON.stringify(output));
  const fileRequest={...input,context:{...input.context,request:{query:'держатель',action:'find'}}};
  assert.deepEqual(validateVoiceSemanticResult({kind:'print',query:'',usePreviousFile:true},fileRequest),{kind:'print',query:'',usePreviousFile:true});
  const selected={...input,context:{...input.context,selectedFile:{name:'держатель'},selectedPrinterId:'max'}};
  assert.deepEqual(validateVoiceSemanticResult({kind:'print',query:'',usePreviousFile:true,usePreviousPrinter:true},selected),{kind:'print',query:'',usePreviousFile:true,usePreviousPrinter:true});
  assert.deepEqual(validateVoiceSemanticResult({kind:'find',query:'держатель',otherPrinter:true},{...input,context:{...input.context,selectedPrinterId:'removed'}}),clarification);
  const awaiting={...input,context:{...input.context,awaiting:'file'}};
  assert.deepEqual(validateVoiceSemanticResult({kind:'followup',query:'держатель'},awaiting),{kind:'followup',query:'держатель'});
  const status={...input,context:{...input.context,topic:'printers'}};
  assert.deepEqual(validateVoiceSemanticResult({kind:'followup',printerId:'max'},status),{kind:'followup',printerId:'max'});
  assert.deepEqual(validateVoiceSemanticResult({kind:'followup',query:'держатель'},status),clarification);
});
await test('a clear spoken known printer cannot silently become a different model target',()=>{
  const context={printers:[{id:'max',name:'K1 Max',preset:'creality-k1-max'},{id:'compact',name:'K1C',preset:'creality-k1c-2025'}],fileChoices:[],printerChoices:[]};
  const request={text:'Ксения закинь держатель на Макс',context};
  assert.deepEqual(validateVoiceSemanticResult({kind:'print',query:'держатель',printerId:'compact'},request),{kind:'clarify',reason:'ambiguous'});
  assert.deepEqual(validateVoiceSemanticResult({kind:'print',query:'держатель',printerId:'max'},request),{kind:'print',query:'держатель',printerId:'max'});
  assert.deepEqual(validateVoiceSemanticResult({kind:'printers',filter:'all',printerId:'max'},{text:'А K1C сейчас чем занят?',context}),{kind:'clarify',reason:'ambiguous'});
  assert.deepEqual(validateVoiceSemanticResult({kind:'print',query:'держатель',printerId:'max'},{text:'Закинь держатель на большой',context}),{kind:'print',query:'держатель',printerId:'max'});
  const previous={text:'Лучше теперь на Максе',context:{...context,selectedFile:{name:'держатель'},selectedPrinterId:'compact'}};
  assert.deepEqual(validateVoiceSemanticResult({kind:'followup',usePreviousPrinter:true},previous),{kind:'clarify',reason:'ambiguous'});
  // A mention of two known printers is not enough to override semantic scope (comparison, source or target).
  const two={text:'Макс пока занят, этот держатель давай на K1C',context};
  assert.deepEqual(validateVoiceSemanticResult({kind:'print',query:'держатель',printerId:'compact'},two),{kind:'print',query:'держатель',printerId:'compact'});
});
await test('already understood commands stay fast and do not invoke the model',async()=>{
  const f=fixture(()=>{throw Error('must not run')});
  assert.equal((await f.assistant.handle('Какие принтеры свободны?')).text,'Сейчас свободен один принтер: K1 Max.');
  assert.equal(f.data.calls.length,0);assert.equal(f.data.start,0);assert.equal(f.data.list.length,0);
});
await test('explicit missing file references clarify immediately without warming or calling the model',async()=>{
  for(const text of ['этот файл','тот же файл','предыдущий файл','этот файл на K1 Max']){
    const f=fixture(()=>{throw Error('missing references must not need inference')});
    const reply=await f.assistant.handle(text);
    assert.equal(reply.clarification,'file',text);assert.match(reply.text,/Какой файл/);assert(!reply.proposal);
    assert.equal(f.data.calls.length,0,text);assert.equal(f.data.list.length,0);assert.equal(f.data.validate.length,0);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
  }
  for(const expired of [false,true]){
    const f=fixture(()=>{throw Error('stale references must not need inference')});
    await f.assistant.handle('Напечатай держатель на K1 Max');
    if(expired)f.data.clock+=4*60_000+1;else await f.assistant.handle('Отмена');
    assert.equal((await f.assistant.handle('этот файл')).clarification,'file');
    assert.equal(f.data.calls.length,0);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
  }
});
await test('file references with real selected or unresolved context still use semantic interpretation',async()=>{
  const selected=fixture(()=>({kind:'followup',usePreviousFile:true}));
  await selected.assistant.handle('Напечатай держатель на K1 Max');
  const reply=await selected.assistant.handle('этот файл');
  assert.equal(selected.data.calls.length,1);assert.equal(reply.proposal.candidate.entry.path,'детали/держатель.gcode');assert.equal(selected.data.start,0);
  const unresolved=fixture(()=>({kind:'followup',usePreviousFile:true}));
  unresolved.data.files=[{path:'держатель_левый.gcode',size:100},{path:'держатель_правый.gcode',size:100}];
  const found=await unresolved.assistant.handle('Найди держатель');assert(found.choices.length>1);
  const choices=await unresolved.assistant.handle('этот файл');
  assert.equal(unresolved.data.calls.length,1);assert.equal(choices.choices.length,found.choices.length);assert(!choices.proposal);assert.equal(unresolved.data.start,0);
});
await test('the reported spoken variants stay immediate and use only live ready printers',async()=>{
  const f=fixture(()=>{throw Error('must not need inference')});
  f.data.printers.push({...printer('offline','Отключённый'),status:{state:'ready',connectionState:'offline'}});
  for(const text of ['Ксения, какие принтеры свободны?','Ну какие принтеры сейчас свободны-то?','Принтеры свободны?','Можешь сказать, какие принтеры свободны?','Какой принтер свободен?','Кто из принтеров не занят?','Подскажи, какие принтеры свободны для работы?']){
    assert.equal((await f.assistant.handle(text)).text,'Сейчас свободен один принтер: K1 Max.',text);
  }
  assert.equal(f.data.calls.length,0);assert.equal(f.data.list.length,0);assert.equal(f.data.start,0);
});
await test('ordinary open questions use the provider and answer only live free printers',async()=>{
  const f=fixture(()=>({kind:'printers',filter:'free'}));
  for(const text of ['У какого аппарата сейчас пустой стол?','Ксения, найди мне свободного работягу','У кого из наших можно сейчас занять стол?']){
    assert.equal((await f.assistant.handle(text)).text,'Сейчас свободен один принтер: K1 Max.');
  }
  assert.equal(f.data.calls.length,3);assert.equal(f.data.list.length,0);assert.equal(f.data.validate.length,0);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
  f.data.printers[0].status.state='printing';assert.equal((await f.assistant.handle('Ну кто там не занят?')).text,'Свободных принтеров сейчас нет.');
});
await test('semantic named status resolves an exact ID without inspecting or preparing files',async()=>{
  const f=fixture(()=>({kind:'printers',filter:'all',printerId:'busy'}));
  assert.equal((await f.assistant.handle('Вторая карточка чем сейчас занята?')).text,'Занятый: печатает.');assert.equal(f.data.list.length,0);assert.equal(f.data.start,0);
});
await test('a root utterance cannot inherit a model-invented previous file or wrong known target',async()=>{
  for(const output of [{kind:'followup',usePreviousFile:true},{kind:'followup',query:'держатель'},{kind:'print',query:'держатель',printerId:'busy'}]){
    const f=fixture(()=>output);
    const reply=await f.assistant.handle('Ксения закинь держатель на K1 Max');
    assert.match(reply.text,/Я услышала:/);assert.equal(reply.diagnosticOutcome,'needs-input');assert(!reply.proposal);
    assert.equal(f.data.list.length,0);assert.equal(f.data.validate.length,0);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
  }
});
await test('duplicate card names ask a real choice and resume the original read-only intent',async()=>{
  const f=fixture(()=>({kind:'printers',filter:'all',printerId:'max'}));f.data.printers[1].name='K1 Max';
  const reply=await f.assistant.handle('Большой сейчас работает?');assert.equal(reply.clarification,'printer');assert.deepEqual(reply.printerChoices.map(p=>p.id),['max','busy']);
  assert.equal((await f.assistant.choosePrinter('busy')).text,'K1 Max: печатает.');assert.equal(f.data.list.length,0);assert.equal(f.data.start,0);
});
await test('preparing or checking a queued task invalidates a different pending semantic printer choice',async()=>{
  for(const action of ['prepare','check','check-command']){
    const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
    const tasks=new VoiceTaskQueue(storage,'semantic-review',()=>1_000_000);
    const f=fixture(()=>({kind:'print',query:'first',printerId:'max'}),{tasks});f.data.printers[1].name='K1 Max';f.data.printers[1].status.state='ready';
    f.data.files=[{path:'first.gcode',size:100},{path:'second.gcode',size:100}];
    assert.equal((await f.assistant.handle('Ксения добавь первую штуку в печать')).clarification,'printer');
    const saved=tasks.addPlan([{query:'second',scopeId:'model:creality-k1-max',path:'second.gcode',printerId:'max',printerName:'K1 Max'}],'semantic-new-task');assert(saved.ok);
    if(action==='prepare')assert.equal((await f.assistant.prepareTask(saved.tasks[0].id)).proposal.candidate.entry.path,'second.gcode');
    else if(action==='check')await f.assistant.checkTask(saved.tasks[0].id);
    else await f.assistant.handle('Проверь запуск');
    const count=f.data.validate.length,reply=await f.assistant.handle('Выбери второй');
    assert(!reply.proposal,action);assert.equal(f.data.validate.length,count,action);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
    assert(!(await f.assistant.choosePrinter('busy')).proposal,action);
  }
});
await test('an explicit current file choice discards an unrelated pending semantic printer action',async()=>{
  const f=fixture(()=>({kind:'print',query:'second',printerId:'max'}));f.data.printers[1].name='K1 Max';f.data.printers[1].status.state='ready';f.data.files=[{path:'first.gcode',size:100},{path:'second.gcode',size:100}];
  const files=await f.assistant.handle('Найди first');assert(files.choices?.length);
  assert.equal((await f.assistant.handle('Ксения добавь вторую штуку в печать')).clarification,'printer');
  const chosen=await f.assistant.choose(files.choices[0]);assert.equal(chosen.proposal.candidate.entry.path,'first.gcode');
  const count=f.data.validate.length,stale=await f.assistant.choosePrinter('busy');assert(!stale.proposal);assert.equal(f.data.validate.length,count);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
});
await test('semantic preparation keeps validation and a separate exact confirmation boundary',async()=>{
  const f=fixture(()=>({kind:'print',query:'держатель',printerId:'max'}));
  const reply=await f.assistant.handle('Мне бы тот держатель на большого поставить');assert.equal(reply.proposal.candidate.printerId,'max');assert.equal(f.data.validate.length,1);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
  await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.upload,1);assert.equal(f.data.start,1);assert.equal(f.data.calls.length,1);
});
await test('unknown or unavailable understanding echoes what was heard without generic help or stale confirmation',async()=>{
  for(const output of [{kind:'clarify',reason:'unknown'}, {kind:'confirm'}, Error('missing runtime')]){
    const f=fixture(()=>{if(output instanceof Error)throw output;return output});
    await f.assistant.handle('Напечатай держатель на K1 Max');const result=await f.assistant.handle('Ну ты поняла, сделай как там');
    assert.match(result.text,/Я услышала: «Ну ты поняла, сделай как там»/);assert(!result.text.includes('Что сделать:'));assert(!result.proposal);
    await f.assistant.handle('Подтверждаю печать');assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
  }
});
await test('semantic clarification, malformed output and provider failures discard hidden old printer choices',async()=>{
  for(const outcome of [{kind:'clarify',reason:'unsupported'},{kind:'clarify',reason:'unknown'},{kind:'clarify',reason:'ambiguous'},{kind:'confirm'},Error('runtime unavailable')]){
    let call=0;const f=fixture(()=>{if(++call===1)return{kind:'print',query:'first',printerId:'max'};if(outcome instanceof Error)throw outcome;return outcome});
    f.data.printers[1].name='K1 Max';f.data.printers[1].status.state='ready';f.data.files=[{path:'first.gcode',size:100}];
    assert.equal((await f.assistant.handle('Ксения добавь первую штуку в печать')).clarification,'printer');
    const next=await f.assistant.handle('Теперь займись совсем другим');assert.match(next.text,/Я услышала:/);assert(!next.printerChoices?.length);assert(!next.proposal);
    const later=await f.assistant.handle('Выбери второй');assert(!later.proposal);assert(!(await f.assistant.choosePrinter('busy')).proposal);
    assert.equal(call,2);assert.equal(f.data.list.length,0);assert.equal(f.data.validate.length,0);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
  }
});
await test('cancelling a running interpretation invalidates its later result and signals the provider',async()=>{
  let release,receivedSignal;const f=fixture((_,signal)=>{receivedSignal=signal;return new Promise(resolve=>{release=resolve})});
  const pending=f.assistant.handle('Ну давай мне держатель куда-нибудь');await Promise.resolve();
  await f.assistant.handle('Отмена');assert.equal(receivedSignal.aborted,true);release({kind:'print',query:'держатель',printerId:'max'});await pending;
  assert.equal(f.data.list.length,0);assert.equal(f.data.validate.length,0);assert.equal(f.data.upload,0);assert.equal(f.data.start,0);
});
await test('model context is bounded conversation data and excludes connection credentials or clients',async()=>{
  const f=fixture(()=>({kind:'clarify',reason:'unknown'}));
  await f.assistant.handle('Напечатай держатель на K1 Max');await f.assistant.handle('Ну этот туда же');
  const request=f.data.calls[0],serialized=JSON.stringify(request);assert.equal(request.context.selectedPrinterId,'max');assert.equal(request.context.selectedFile.name,'держатель');assert.equal(request.context.request.action,'print');
  for(const hidden of ['host','apiKey','not-for-model','192.168','client','sha256','target'])assert(!serialized.includes(hidden),hidden);
  f.data.clock+=4*60_000+1;await f.assistant.handle('Ну этот туда же');assert.equal(f.data.calls.at(-1).context.selectedFile,undefined);
});

const operationContext={printers:[{id:'max',name:'K1 Max',preset:'creality-k1-max'},{id:'compact',name:'K1C',preset:'creality-k1c-2025'}],fileChoices:[],printerChoices:[]};
await test('controls and forecasts are bounded typed requests, never raw tools or invented IDs',()=>{
 const request={text:'Включи свет на Максе',context:operationContext};
 for(const value of [{kind:'control',action:'heat',printerId:'max'},{kind:'control',action:'gcode',command:'M112'},{kind:'control',action:'light-on',printerId:'missing'},{kind:'control',action:'pause',query:'anything'},{kind:'forecast',mode:'random'},{kind:'forecast',mode:'after'},{kind:'forecast',mode:'after',minutes:0},{kind:'forecast',mode:'after',minutes:10081},{kind:'forecast',mode:'after',minutes:1.5},{kind:'forecast',mode:'after',minutes:'60'},{kind:'forecast',mode:'finish',minutes:60},{kind:'forecast',mode:'first',printerId:'max'},{kind:'forecast',mode:'first',usePreviousPrinter:false}])assert.throws(()=>validateVoiceSemanticResult(value,request),undefined,JSON.stringify(value));
 assert.deepEqual(semanticVoiceIntent(validateVoiceSemanticResult({kind:'control',action:'light-on',printerId:'max'},request),request.text),{kind:'control',action:'light-on',printerHint:'',printerId:'max'});
 const forecast={text:'Что будет печататься через 90 минут?',context:operationContext};
 assert.deepEqual(semanticVoiceIntent(validateVoiceSemanticResult({kind:'forecast',mode:'after',minutes:90},forecast),forecast.text),{kind:'forecast',mode:'after',printerHint:'',minutes:90});
});
await test('a control requires the positively requested action and one explicit known target',()=>{
 const ambiguous={kind:'clarify',reason:'ambiguous'};
 for(const [text,action] of [['Не включай свет на Максе','light-on'],['Поставь Макс на паузу и включи свет','pause'],['Включи свет на Максе и K1C','light-on'],['Включи свет на Максе если готов','light-on'],['Через час включи свет на Максе','light-on'],['Когда закончит Макс включи подсветку','light-on'],['Найди файл включи свет','light-on'],['Закинь держатель на Макс','light-on'],['Продолжи рассказ','resume'],['Продолжи поиск','resume'],['Приостанови рассказ','pause'],['Включи светофор','light-on'],['Включи световую модель','light-on'],['Макс','pause']]){
  assert.deepEqual(validateVoiceSemanticResult({kind:'control',action,printerId:'max'},{text,context:{...operationContext,selectedPrinterId:'max'}}),ambiguous,text);
 }
 assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'light-off',printerId:'max'},{text:'Включи свет на Максе',context:operationContext}),ambiguous);
 assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'light-on',printerId:'max'},{text:'Включи свет',context:operationContext}),ambiguous);
 assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'light-on'},{text:'Включи свет на Максе',context:operationContext}),{kind:'control',action:'light-on',printerId:'max'});
 assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'resume',printerId:'max'},{text:'Макс продолжи',context:operationContext}),{kind:'control',action:'resume',printerId:'max'});
 assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'camera',printerId:'max'},{text:'Покажи что происходит на камере Макса',context:operationContext}),{kind:'control',action:'camera',printerId:'max'});
});
await test('explicit printer pronouns use real current conversation data and cannot be invented',()=>{
 const previous={...operationContext,selectedPrinterId:'max'};
 for(const output of [{kind:'control',action:'light-on',printerId:'max'},{kind:'control',action:'light-on',usePreviousPrinter:true}])assert.deepEqual(validateVoiceSemanticResult(output,{text:'Включи на нём подсветку',context:previous}),{kind:'control',action:'light-on',usePreviousPrinter:true});
 for(const context of [operationContext,{...operationContext,selectedPrinterId:'removed'}])assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'light-on',printerId:'max'},{text:'Включи на нём подсветку',context}),{kind:'clarify',reason:'ambiguous'});
 assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'resume',usePreviousPrinter:true},{text:'Продолжи печать',context:previous}),{kind:'clarify',reason:'ambiguous'});
});
await test('one model alias matching several configured printers cannot become a first-device choice',()=>{
 const context={...operationContext,printers:Array.from({length:4},(_,index)=>({id:'ke'+index,name:'Эндер '+(index+1),preset:'ender3-v3-ke'}))};
 assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'light-on',printerId:'ke0'},{text:'Включи свет на эндере',context}),{kind:'clarify',reason:'ambiguous'});
 const duplicate={...operationContext,printers:[...operationContext.printers,{id:'second',name:'Второй Макс',preset:'creality-k1-max'}]};
 assert.deepEqual(validateVoiceSemanticResult({kind:'control',action:'pause',printerId:'max'},{text:'Поставь Макс на паузу',context:duplicate}),{kind:'clarify',reason:'ambiguous'});
});
await test('finish questions cannot acquire an unspoken hour and named forecasts retain their target',()=>{
 const text='Ксения, сколько ещё будет занят Макс?';
 assert.deepEqual(validateVoiceSemanticResult({kind:'forecast',mode:'after',minutes:60},{text,context:operationContext}),{kind:'forecast',mode:'finish',printerId:'max'});
 assert.deepEqual(validateVoiceSemanticResult({kind:'forecast',mode:'finish'},{text:'Когда закончит Макс?',context:operationContext}),{kind:'forecast',mode:'finish',printerId:'max'});
 assert.deepEqual(validateVoiceSemanticResult({kind:'forecast',mode:'finish',printerId:'max'},{text:'Когда закончит K1C?',context:operationContext}),{kind:'clarify',reason:'ambiguous'});
 assert.deepEqual(validateVoiceSemanticResult({kind:'forecast',mode:'finish',printerId:'max'},{text:'Когда закончится печать?',context:operationContext}),{kind:'forecast',mode:'finish'});
});
await test('a forecast horizon must be stated and parsed rather than guessed by the model',()=>{
 for(const [text,minutes] of [['Кто ещё будет занят через полчаса?',30],['Что будет печататься через 90 минут?',90],['Кто ещё будет занят через два часа?',120]]){
  assert.deepEqual(validateVoiceSemanticResult({kind:'forecast',mode:'after',minutes:60},{text,context:operationContext}),{kind:'forecast',mode:'after',minutes},text);
 }
 for(const text of ['Кто ещё будет печатать через некоторое время?','Кто ещё будет занят позже?','Кто будет печатать через -5 минут?','Сколько осталось пластика?'])assert.deepEqual(validateVoiceSemanticResult({kind:'forecast',mode:'after',minutes:60},{text,context:operationContext}),{kind:'clarify',reason:'ambiguous'},text);
});

// Срок назван в тексте — значит режим прогноза берётся из текста, а не из ответа модели.
// На одной машине модель отвечала first на «через час», на другой after; срок в просьбе не должен
// зависеть от того, какой процессор стоит в ферме.
await test('a stated horizon decides the forecast mode regardless of the model answer',()=>{
  const ctx={...input.context,printers:[{id:'max',name:'K1 Max (Макс)'},{id:'k1c',name:'K1C 2025'}]};
  for(const [text,minutes] of [
    ['Что будет печататься через час?',60],
    ['Через час что будет?',60],
    ['Кто ещё будет занят через полчаса?',30],
    ['Кто будет занят через 20 минут?',20],
    ['Что будет печататься через полтора часа?',90],
  ]){
    const request={text,context:ctx};
    // Модель ошиблась режимом — ответ всё равно обязан нести названный срок.
    const corrected=validateVoiceSemanticResult({kind:'forecast',mode:'first'},request);
    assert.equal(corrected.mode,'after',text);
    assert.equal(corrected.minutes,minutes,text);
  }
  // Без срока в тексте ничего не выдумывается: прежнее поведение сохраняется.
  const first=validateVoiceSemanticResult({kind:'forecast',mode:'first'},{text:'Кто освободится первым?',context:ctx});
  assert.equal(first.mode,'first');
  assert.equal(Object.hasOwn(first,'minutes'),false,'прогноз без срока не получает выдуманных минут');
});

// Служебная команда — не файл. «Отправь M112» модель однажды превратила в печать файла «M112».
await test('service commands are refused instead of becoming a file name',()=>{
  const ctx={...input.context,printers:[{id:'max',name:'K1 Max (Макс)'}]};
  for(const [text,model] of [
    ['Отправь M112 на принтер',{kind:'print',query:'M112'}],
    ['Выполни G28 на Максе',{kind:'print',query:'G28'}],
    ['Найди M84',{kind:'find',query:'M84'}],
    ['Пошли RESTART',{kind:'print',query:'RESTART'}],
    ['Выполни SET_PIN на Максе',{kind:'print',query:'SET_PIN'}],
  ]){
    const result=validateVoiceSemanticResult(model,{text,context:ctx});
    assert.equal(result.kind,'clarify',text);
    assert.equal(result.reason,'unsupported',text);
  }
  // Обычная просьба о печати не задета: короткое имя с цифрой остаётся файлом.
  const print=validateVoiceSemanticResult({kind:'print',query:'держатель',printerId:'max'},{text:'Напечатай держатель на Максе',context:ctx});
  assert.equal(print.kind,'print');
  const numeric=validateVoiceSemanticResult({kind:'print',query:'деталь 3',printerId:'max'},{text:'Напечатай деталь 3',context:ctx});
  assert.equal(numeric.kind,'print','имя файла с цифрой не путается с командой');
});

const report={passed:true,cases:results.length,results};if(process.env.KF_VOICE_SEMANTIC_PROOF)fs.writeFileSync(process.env.KF_VOICE_SEMANTIC_PROOF,JSON.stringify(report,null,2));
console.log(`Voice semantic boundary: ${results.length} cases passed`);
