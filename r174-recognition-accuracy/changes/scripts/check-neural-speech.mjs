import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export * from './src/lib/neuralSpeech';export {setAuthSession} from './src/lib/auth';export {mockIPC} from '@tauri-apps/api/mocks';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
globalThis.window=new EventTarget();globalThis.localStorage={setItem(){}};
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
api.setAuthSession({token:'test',user:{id:'test'}});
let calls=[],preparedModels=[],transcribedModels=[],transcribe=async()=>({text:'Принтер К1 Макс поставь на печать корпус',confidence:0.95}),status=async()=>({recognition:true,synthesis:true}),lastCapture,stopped=0;
api.mockIPC(async(command,args)=>{calls.push(command);if(command==='voice_tools_status')return status();if(command==='voice_prepare'){preparedModels.push(args.modelId);return}if(command==='voice_transcribe'){transcribedModels.push(args.modelId);return transcribe(args)}if(command==='voice_synthesize')return{pcm:[0,0,50,0],sampleRate:48000};throw new Error(command)});
class FakeAudioContext{sampleRate=48000;destination={};audioWorklet={addModule:async()=>{}};resume=async()=>{};close=async()=>{};createMediaStreamSource=()=>({connect(){},disconnect(){}})}
class FakeCapture{constructor(){lastCapture=this}port={onmessage:undefined};connect(){}disconnect(){}}
globalThis.AudioContext=FakeAudioContext;globalThis.AudioWorkletNode=window.AudioWorkletNode=FakeCapture;
Object.defineProperty(globalThis,'navigator',{value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++}}]})}},configurable:true});
globalThis.location={href:'http://localhost/'};globalThis.window.speechSynthesis={cancel(){}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const make=()=>{const events={states:[],texts:[],errors:[]};return{events,mic:new api.NeuralSpeechInput({state:s=>events.states.push(s),partial(){},text:t=>events.texts.push(t),error:e=>events.errors.push(e)})}};
const feed=(count,value)=>{for(let i=0;i<count;i++)lastCapture.port.onmessage({data:new Float32Array(480).fill(value)})};
const cases=[];async function test(name,fn){await fn();cases.push(name);console.log('PASS',name)}
await test('microphone encoding resamples to mono PCM and caps at twenty seconds',()=>{
 const wave=api.speechWave([new Float32Array(48000*21).fill(0.1)],48000),v=new DataView(wave.buffer);
 assert.equal(wave.length,640044);assert.equal(v.getUint32(24,true),16000);assert.equal(v.getUint32(40,true),640000);assert.equal(v.getInt16(44,true),3277);
});
await test('silence never goes to recognition',async()=>{calls=[];const f=make();await f.mic.start();feed(40,0);await f.mic.finish();assert(!calls.includes('voice_transcribe'));assert.equal(f.events.texts.length,0);assert(f.events.errors.length);f.mic.dispose()});
await test('a short pause inside the command is preserved; one second of final silence submits once',async()=>{calls=[];const f=make();await f.mic.start();feed(50,0.12);feed(70,0);assert.equal(f.events.texts.length,0);assert(!calls.includes('voice_transcribe'));feed(50,0.12);feed(105,0);await tick();assert.equal(f.events.texts.length,1);assert.equal(calls.filter(x=>x==='voice_transcribe').length,1);assert(stopped>0);f.mic.dispose()});
await test('leading and trailing silence are trimmed without losing speech or its inner pause',async()=>{
 let bytes;transcribe=async args=>{bytes=args.wave;return {text:'Остаток пластика',confidence:0.95}};const f=make();await f.mic.start();feed(200,0);feed(50,0.1);feed(50,0);feed(50,0.1);feed(105,0);await tick();
 const seconds=(bytes.length-44)/32000;assert(seconds>1.9&&seconds<2.1);assert.equal(f.events.texts.length,1);f.mic.dispose();
});
await test('five microphone turns each deliver once, and processing cannot open a second capture',async()=>{
 for(let i=0;i<5;i++){let done;transcribe=()=>new Promise(resolve=>done=resolve);calls=[];const f=make();await f.mic.start();feed(50,0.1);const finish=f.mic.finish();await tick();const before=calls.length;await f.mic.start();assert.equal(calls.length,before);done({text:'Остаток пластика',confidence:0.95});await finish;assert.equal(f.events.texts.length,1);assert.equal(calls.filter(x=>x==='voice_transcribe').length,1);f.mic.dispose()}
 transcribe=async()=>({text:'Остаток пластика',confidence:0.95});
});
await test('fast recognition is the default and accuracy mode uses the selected model for preparation and decoding',async()=>{
 const f=make();await f.mic.start();feed(50,0.1);await f.mic.finish();assert.equal(preparedModels.at(-1),'base');assert.equal(transcribedModels.at(-1),'base');
 f.mic.setModel('small');await f.mic.start();feed(50,0.1);await f.mic.finish();assert.equal(preparedModels.at(-1),'small');assert.equal(transcribedModels.at(-1),'small');assert.equal(f.events.texts.length,2);f.mic.dispose();
});
await test('speech vocabulary sanitizes Unicode names and excludes confirmation words and oversized entries',()=>{
 assert.deepEqual(api.sanitizeSpeechContextHints([' Держатель/телефона 12 ','держатель телефона 12','K1 Max','подтверждаю\u202eпечать','да','...','x'.repeat(65),'x'.repeat(100000)]),['Держатель телефона 12','K1 Max']);
 const names=api.sanitizeSpeechContextHints(Array.from({length:10000},(_,i)=>'Кронштейн '+i));
 assert.equal(names.length,16);assert([...names.join('. ')].length<=512);assert(new TextEncoder().encode(names.join('. ')).length<=1024);
 const long=api.sanitizeSpeechContextHints(Array.from({length:16},(_,i)=>'架'.repeat(32)+i));
 assert(long.length>0&&long.length<16);assert([...long.join('. ')].length<=512);assert(new TextEncoder().encode(long.join('. ')).length<=1024);
});
await test('each microphone turn snapshots current vocabulary and never reuses hints from an earlier recording',async()=>{
 const requests=[];transcribe=async args=>{requests.push(args.contextHints);return {text:'Остаток пластика',confidence:0.95}}
 const f=make();f.mic.setContextHints(['Держатель телефона 12']);await f.mic.start();
 f.mic.setContextHints(['Кронштейн камеры 25']);feed(50,0.1);await f.mic.finish();
 await f.mic.start();feed(50,0.1);await f.mic.finish();
 f.mic.setContextHints([]);await f.mic.start();feed(50,0.1);await f.mic.finish();
 assert.deepEqual(requests,[['Держатель телефона 12'],['Кронштейн камеры 25'],[]]);assert.equal(f.events.texts.length,3);f.mic.dispose();transcribe=async()=>({text:'Остаток пластика',confidence:0.95});
});
await test('cancellation during transcription never executes stale recognized text',async()=>{let resolve;transcribe=()=>new Promise(done=>resolve=done);const f=make();await f.mic.start();feed(50,0.1);const finishing=f.mic.finish();await tick();f.mic.cancel();resolve('Напечатай корпус');await finishing;assert.equal(f.events.texts.length,0);f.mic.dispose();transcribe=async()=>({text:'Остаток пластика',confidence:0.95})});
await test('cancellation while loading does not open the microphone',async()=>{let resolve;status=()=>new Promise(done=>resolve=done);const f=make(),starting=f.mic.start(),before=stopped;await tick();f.mic.cancel();resolve({recognition:true});await starting;assert.equal(stopped,before);assert.equal(f.events.texts.length,0);f.mic.dispose();status=async()=>({recognition:true})});
await test('missing packaged model is shown as an error without using cloud or old recognition',async()=>{calls=[];status=async()=>({recognition:false});const f=make();await f.mic.start();assert.equal(f.events.errors.length,1);assert.match(f.events.errors[0],/Whisper/);assert.deepEqual(calls,['voice_tools_status']);f.mic.dispose();status=async()=>({recognition:true})});
await test('default female voice and cancellation prevent delayed playback',async()=>{let resolve,played=0,requestedVoice;api.mockIPC((command,args)=>{requestedVoice=args.voiceId;return new Promise(done=>resolve=done)});globalThis.Audio=class{addEventListener(){}play(){played++;return Promise.resolve()}pause(){}};const speaking=api.speakNeuralOffline('Остаток пластика');await tick();assert.equal(requestedVoice,'kseniya');api.stopNeuralSpeech();resolve({pcm:[0,0],sampleRate:48000});await speaking;assert.equal(played,0)});
await test('interrupting playback does not report a missing voice module',async()=>{
 let rejectPlay,started=0;api.mockIPC(()=>({pcm:[0,0,50,0],sampleRate:48000}));
 globalThis.Audio=class{addEventListener(){}play(){started++;return new Promise((_,reject)=>rejectPlay=reject)}pause(){rejectPlay?.(new DOMException('Interrupted','AbortError'))}};
 const speaking=api.speakNeuralOffline('Проверка звука');await tick();assert.equal(started,1);api.stopNeuralSpeech();await speaking;
});
await test('a cancelled native synthesis failure is ignored and the next reply can play',async()=>{
 let reject,played=0;api.mockIPC(()=>new Promise((_,fail)=>reject=fail));
 const stale=api.speakNeuralOffline('Старый ответ');await tick();api.stopNeuralSpeech();reject(new Error('Old request failed'));await stale;
 api.mockIPC(()=>({pcm:[0,0,50,0],sampleRate:48000}));globalThis.Audio=class{addEventListener(){}play(){played++;return Promise.resolve()}pause(){}};
 const states=[];await api.speakNeuralOffline('Новый ответ','kseniya',s=>states.push(s));assert.equal(played,1);assert.deepEqual(states,['preparing','playing']);api.stopNeuralSpeech();assert.equal(states.at(-1),'idle');
});
const audioHarness=()=>{
 const samples=[];globalThis.Audio=class{listeners={};pauses=0;constructor(){samples.push(this)}addEventListener(name,callback){this.listeners[name]=callback}play(){this.started=true;return Promise.resolve()}pause(){this.pauses++}end(){this.listeners.ended?.()}};return samples;
};
await test('background notices wait for assistant playback and release after audio ends',async()=>{
 const samples=audioHarness();let synthesized=0;api.mockIPC(()=>{synthesized++;return{pcm:[0,0,50,0],sampleRate:48000}});
 await api.speakNeuralOffline('Ответ помощницы');assert.equal(await api.trySpeakNeuralAnnouncement('Печать скоро закончится'),false);assert.equal(synthesized,1);assert.equal(samples[0].pauses,0);
 samples[0].end();assert.equal(await api.trySpeakNeuralAnnouncement('Печать скоро закончится'),true);assert.equal(synthesized,2);samples[1].end();
});
await test('background notices never interrupt a reply that is still being synthesized',async()=>{
 let resolve,count=0;const samples=audioHarness();api.mockIPC(()=>{count++;return new Promise(done=>resolve=done)});
 const reply=api.speakNeuralOffline('Ответ');await tick();assert.equal(await api.trySpeakNeuralAnnouncement('Печать скоро закончится'),false);assert.equal(count,1);
 resolve({pcm:[0,0,50,0],sampleRate:48000});await reply;assert.equal(samples.length,1);samples[0].end();
});
await test('nested conversation holds are independent and may be released repeatedly',async()=>{
 const samples=audioHarness();let count=0;api.mockIPC(()=>{count++;return{pcm:[0,0,50,0],sampleRate:48000}});
 const first=api.holdNeuralSpeechAnnouncements(),second=api.holdNeuralSpeechAnnouncements();assert.equal(await api.trySpeakNeuralAnnouncement('Напоминание'),false);first();first();assert.equal(await api.trySpeakNeuralAnnouncement('Напоминание'),false);assert.equal(count,0);
 second();assert.equal(await api.trySpeakNeuralAnnouncement('Напоминание'),true);samples[0].end();
});
await test('a completed or changed print during synthesis never produces a stale announcement',async()=>{
 let resolve,current=true;const samples=audioHarness();api.mockIPC(()=>new Promise(done=>resolve=done));
 const notice=api.trySpeakNeuralAnnouncement('Печать скоро закончится',()=>current);await tick();current=false;resolve({pcm:[0,0,50,0],sampleRate:48000});assert.equal(await notice,false);assert.equal(samples.length,0);
 api.mockIPC(()=>({pcm:[0,0,50,0],sampleRate:48000}));assert.equal(await api.trySpeakNeuralAnnouncement('Следующий принтер'),true);samples[0].end();
});
await test('a user reply supersedes a queued background notice without delayed old playback',async()=>{
 let resolve,count=0;const samples=audioHarness();api.mockIPC(()=>{count++;return count===1?new Promise(done=>resolve=done):{pcm:[0,0,50,0],sampleRate:48000}});
 const notice=api.trySpeakNeuralAnnouncement('Напоминание');await tick();const reply=api.speakNeuralOffline('Ответ пользователю');resolve({pcm:[0,0,50,0],sampleRate:48000});assert.equal(await notice,false);await reply;assert.equal(samples.length,1);samples[0].end();
});
await test('microphone loading, capture and pending recognition all defer announcements',async()=>{
 let resolveRecognition;const samples=audioHarness();api.mockIPC((command)=>{
  if(command==='voice_tools_status')return{recognition:true};if(command==='voice_prepare')return;
  if(command==='voice_transcribe')return new Promise(done=>resolveRecognition=done);
  if(command==='voice_synthesize')return{pcm:[0,0,50,0],sampleRate:48000};throw new Error(command);
 });
 const f=make(),starting=f.mic.start();assert.equal(await api.trySpeakNeuralAnnouncement('Напоминание'),false);await starting;assert.equal(await api.trySpeakNeuralAnnouncement('Напоминание'),false);
 feed(50,.1);const finish=f.mic.finish();await tick();assert.equal(await api.trySpeakNeuralAnnouncement('Напоминание'),false);resolveRecognition('Сколько осталось пластика');await finish;
 assert.equal(await api.trySpeakNeuralAnnouncement('Напоминание'),true);samples[0].end();f.mic.dispose();
});
await test('cancelled microphone preparation releases its announcement hold',async()=>{
 let resolveStatus;const samples=audioHarness();api.mockIPC(command=>command==='voice_tools_status'?new Promise(done=>resolveStatus=done):{pcm:[0,0,50,0],sampleRate:48000});
 const f=make(),starting=f.mic.start();await tick();f.mic.cancel();assert.equal(await api.trySpeakNeuralAnnouncement('Напоминание'),true);samples[0].end();resolveStatus({recognition:true});await starting;f.mic.dispose();
});
await test('invalid or failing announcement guards skip native synthesis',async()=>{
 let count=0;api.mockIPC(()=>{count++;return{pcm:[0,0,50,0],sampleRate:48000}});assert.equal(await api.trySpeakNeuralAnnouncement('Устарело',()=>false),false);assert.equal(await api.trySpeakNeuralAnnouncement('Устарело',()=>{throw new Error('Removed')}),false);assert.equal(count,0);
});
await test('a failed background synthesis releases priority for the next notice',async()=>{
 const samples=audioHarness();api.mockIPC(()=>{throw new Error('Synthesis unavailable')});await assert.rejects(api.trySpeakNeuralAnnouncement('Напоминание'),/Synthesis unavailable/);
 api.mockIPC(()=>({pcm:[0,0,50,0],sampleRate:48000}));assert.equal(await api.trySpeakNeuralAnnouncement('Следующее напоминание'),true);samples[0].end();
});
console.log('Neural speech:',cases.length,'cases passed');
