import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export * from './src/lib/voiceDiagnostics';export * from './src/lib/neuralSpeech';export {VoiceDiagnosticsPanel} from './src/components/VoiceDiagnosticsPanel';export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server.browser';export {setAuthSession} from './src/lib/auth';export {mockIPC} from '@tauri-apps/api/mocks';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
globalThis.window=new EventTarget();globalThis.localStorage={setItem(){}};
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64')).catch(error=>{throw new Error('Diagnostic test bundle failed: '+error.message)});
api.setAuthSession({token:'test',user:{id:'test'}});
const report=[],test=async(name,run)=>{await run();report.push({name,passed:true});console.log('PASS',name)};
const memory=()=>{const data=new Map();return{data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}};
let clock=0;const originalPerformance=globalThis.performance;Object.defineProperty(globalThis,'performance',{value:{now:()=>clock},configurable:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
try{
await test('default diagnostics persist only measured metadata, never transcripts or audio-shaped extra keys',()=>{
 const storage=memory(),log=new api.VoiceDiagnostics(storage,'alice',()=>clock,()=>100);
 const id=log.begin('voice','private filename');log.timing(id,{stage:'recognition',milliseconds:17,outcome:'completed',wave:[11,22],rawAudio:'private audio'});
 log.issue(id,api.voiceDiagnosticIssue('recognition',new Error('recognition failed for private filename')));log.finish(id,'error');
 const encoded=[...storage.data.values()].join('');assert(!encoded.includes('private'));assert(!encoded.includes('wave'));assert(!encoded.includes('rawAudio'));
 assert.equal(log.snapshot().captureTranscript,false);assert.equal(log.snapshot().turns[0].transcript,undefined);assert.equal(log.snapshot().turns[0].timings[0].milliseconds,17);
 assert.equal(JSON.parse(log.export()).audioStored,false);
});
await test('transcript collection requires opt-in and disabling scrubs previous stored text',()=>{
 const storage=memory(),log=new api.VoiceDiagnostics(storage,'alice',()=>clock,()=>100);
 log.setCaptureTranscript(true);const id=log.begin('text','private '+'x'.repeat(500));assert.equal(log.snapshot().turns[0].transcript.length,300);
 log.setCaptureTranscript(false);assert.equal(log.snapshot().turns[0].transcript,undefined);assert(![...storage.data.values()].join('').includes('private'));
 const restored=new api.VoiceDiagnostics(storage,'alice');assert.equal(restored.snapshot().captureTranscript,false);assert.equal(restored.snapshot().turns[0].transcript,undefined);
});
await test('disabling transcripts removes the old copy even when sanitized writes fail',()=>{
 const storage=memory(),save=storage.setItem;let fail=false;storage.setItem=(key,value)=>{if(fail)throw new Error('write denied');save(key,value)};
 const log=new api.VoiceDiagnostics(storage,'alice');log.setCaptureTranscript(true);log.begin('text','private marker');fail=true;log.setCaptureTranscript(false);
 assert(!log.export().includes('private marker'));assert(![...storage.data.values()].some(value=>value.includes('private marker')));
 assert.equal(storage.getItem('klipper-voice-diagnostics-v1:alice'),null);assert.equal(log.snapshot().storageError,true);assert.equal(log.snapshot().cleanupFailed,false);
});
await test('clear retries deletion after a write failure without touching another profile',()=>{
 const storage=memory(),save=storage.setItem,remove=storage.removeItem;let fail=false,removals=0;
 storage.setItem=(key,value)=>{if(fail)throw new Error('write denied');save(key,value)};
 storage.removeItem=key=>{if(fail&&++removals===1)throw new Error('first remove denied');remove(key)};
 const log=new api.VoiceDiagnostics(storage,'alice'),other=new api.VoiceDiagnostics(storage,'bob');log.setCaptureTranscript(true);log.begin('text','private marker');other.begin('text');const bob=storage.getItem('klipper-voice-diagnostics-v1:bob');
 fail=true;log.clear();assert.equal(log.snapshot().turns.length,0);assert.equal(log.snapshot().storageError,true);assert.equal(log.snapshot().cleanupFailed,false);assert.equal(removals,2);
 assert.equal(storage.getItem('klipper-voice-diagnostics-v1:alice'),null);assert.equal(storage.getItem('klipper-voice-diagnostics-v1:bob'),bob);
});
await test('failed cleanup exposes the retained-text risk and leaves the empty-history clear button enabled',()=>{
 const storage=memory(),save=storage.setItem,remove=storage.removeItem;let fail=false;
 storage.setItem=(key,value)=>{if(fail)throw new Error('write denied');save(key,value)};storage.removeItem=key=>{if(fail)throw new Error('remove denied');remove(key)};
 const log=new api.VoiceDiagnostics(storage,'alice');log.setCaptureTranscript(true);log.begin('text','private marker');fail=true;log.setCaptureTranscript(false);log.clear();
 assert.equal(log.snapshot().cleanupFailed,true);assert.equal(log.snapshot().storageError,true);assert(!log.export().includes('private marker'));assert(storage.getItem('klipper-voice-diagnostics-v1:alice').includes('private marker'));
 const html=api.renderToStaticMarkup(api.createElement(api.VoiceDiagnosticsPanel,{snapshot:log.snapshot(),onCaptureText(){},onClear(){},onExport:()=>''}));
 assert(html.includes('мог остаться текст команд'));const clear=html.match(/<button[^>]*>Очистить историю<\/button>/u)?.[0];assert(clear&&!clear.includes('disabled'));
 fail=false;log.clear();assert.equal(log.snapshot().cleanupFailed,false);assert.equal(log.snapshot().storageError,false);assert(!storage.getItem('klipper-voice-diagnostics-v1:alice').includes('private marker'));
});
await test('profile disposal prevents late callbacks from changing either profile history',()=>{
 const storage=memory(),first=new api.VoiceDiagnostics(storage,'alice',()=>clock,()=>100);first.setCaptureTranscript(true);
 const id=first.begin('voice','alice private');first.progress(id,{stage:'command',phase:'start'});clock=20;first.dispose();const saved=storage.getItem('klipper-voice-diagnostics-v1:alice');
 const second=new api.VoiceDiagnostics(storage,'bob',()=>clock,()=>101);second.begin('text');first.setTranscript(id,'late private');first.timing(id,{stage:'launch',milliseconds:90,outcome:'completed'});first.finish(id,'ok');
 assert.equal(storage.getItem('klipper-voice-diagnostics-v1:alice'),saved);assert(!second.export().includes('alice'));assert(!second.export().includes('private'));
 second.clear();assert.equal(new api.VoiceDiagnostics(storage,'alice').snapshot().turns.length,1);
});
await test('overlapping progress measures occupied wall time and unmatched ends invent no timing',()=>{
 clock=0;const log=new api.VoiceDiagnostics(undefined,'',()=>clock,()=>100),id=log.begin('text');
 log.progress(id,{stage:'upload',phase:'end'});assert.equal(log.snapshot().turns[0].timings.length,0);
 log.progress(id,{stage:'search',phase:'start'});clock=5;log.progress(id,{stage:'search',phase:'start'});clock=15;log.progress(id,{stage:'search',phase:'end'});assert.equal(log.snapshot().turns[0].timings.length,0);
 clock=30;log.progress(id,{stage:'search',phase:'end'});assert.deepEqual(log.snapshot().turns[0].timings,[{stage:'search',milliseconds:30,outcome:'completed'}]);
 log.progress(id,{stage:'launch',phase:'start'});clock=42;log.cancel(id);log.finish(id,'ok');assert.equal(log.snapshot().turns[0].outcome,'cancelled');assert.equal(log.snapshot().turns[0].timings.at(-1).milliseconds,12);
});
await test('history and stage counts remain bounded, and clearing removes only the current profile',()=>{
 const storage=memory(),other=new api.VoiceDiagnostics(storage,'bob');other.begin('text');
 const log=new api.VoiceDiagnostics(storage,'alice',()=>clock,()=>100);log.setCaptureTranscript(true);
 for(let i=0;i<60;i++){const id=log.begin('text','x'.repeat(300));for(let j=0;j<35;j++)log.timing(id,{stage:'command',milliseconds:j,outcome:'completed'})}
 assert(log.snapshot().turns.length<=30);assert(log.snapshot().turns.every(turn=>turn.timings.length<=24));assert(storage.getItem('klipper-voice-diagnostics-v1:alice').length<=48*1024);
 log.clear();assert.equal(new api.VoiceDiagnostics(storage,'alice').snapshot().turns.length,0);assert.equal(new api.VoiceDiagnostics(storage,'bob').snapshot().turns.length,1);
});
await test('untrusted saved fields and corrupt data never become transcript or audio exports',()=>{
 const storage=memory();storage.setItem('klipper-voice-diagnostics-v1:alice',JSON.stringify({version:1,captureTranscript:false,audio:'private audio',turns:[{id:'1',createdAt:1,source:'voice',outcome:'running',transcript:'private text',audio:[1,2],timings:[{stage:'recording',milliseconds:10,outcome:'completed',wave:[3,4]}]}]}));
 const log=new api.VoiceDiagnostics(storage,'alice');assert(!log.export().includes('private'));assert(!log.export().includes('wave'));assert.equal(log.snapshot().turns[0].outcome,'cancelled');log.begin('text');assert(![...storage.data.values()].join('').includes('private'));
 storage.setItem('klipper-voice-diagnostics-v1:bad','{bad');assert.equal(new api.VoiceDiagnostics(storage,'bad').snapshot().turns.length,0);
 const unavailable=new api.VoiceDiagnostics({getItem(){throw new Error('denied')},setItem(){throw new Error('full')},removeItem(){}},'alice');unavailable.begin('text');assert.equal(unavailable.snapshot().storageError,true);
});
let lastCapture;const audio=[];
globalThis.Audio=class{listeners={};constructor(){audio.push(this)}addEventListener(name,callback){this.listeners[name]=callback}play(){return Promise.resolve()}pause(){}end(){this.listeners.ended?.()}};
window.speechSynthesis={cancel(){}};
await test('synthesis and playback timings stop at real promise and ended boundaries',async()=>{
 clock=100;let resolve;const timings=[];api.mockIPC(()=>new Promise(done=>resolve=done));
 const speaking=api.speakNeuralOffline('Ответ','kseniya',undefined,timing=>timings.push(timing));await tick();clock=160;resolve({pcm:[0,0,50,0],sampleRate:48000});assert.equal(await speaking,true);
 assert.equal(timings.find(t=>t.stage==='synthesis').milliseconds,60);assert(!timings.some(t=>t.stage==='playback'));
 clock=220;audio.at(-1).end();assert.deepEqual(timings.at(-1),{stage:'playback',milliseconds:60,outcome:'completed'});
});
await test('a preview device error is an error while a real interruption remains cancelled',async()=>{
 const NormalAudio=globalThis.Audio;let failed,rejectPlay;globalThis.Audio=class{listeners={};constructor(){failed=this}addEventListener(name,callback){this.listeners[name]=callback}play(){return new Promise((_,reject)=>rejectPlay=reject)}pause(){}};
 const log=new api.VoiceDiagnostics(undefined,'',()=>clock,()=>100),id=log.begin('preview');api.mockIPC(()=>({pcm:[0,0,50,0],sampleRate:48000}));
 try{
  const pending=api.speakNeuralOffline('Ответ','kseniya',undefined,timing=>{log.timing(id,timing);if(timing.outcome==='error')log.issue(id,api.voiceDiagnosticIssue('speech','device failed'))});
  await tick();clock+=20;failed.listeners.error();rejectPlay(new Error('device failed'));const played=await pending;assert.equal(played,false);log.finishPreview(id,played);
  assert.equal(log.snapshot().turns[0].outcome,'error');assert.equal(log.snapshot().turns[0].issue.code,'speech-failed');assert.equal(log.snapshot().turns[0].timings.at(-1).outcome,'error');
  const interrupted=log.begin('preview');log.finishPreview(interrupted,false);assert.equal(log.snapshot().turns[0].outcome,'cancelled');const successful=log.begin('preview');log.finishPreview(successful,true);assert.equal(log.snapshot().turns[0].outcome,'ok');
 }finally{globalThis.Audio=NormalAudio;api.stopNeuralSpeech()}
});
await test('interrupting pending speech records cancellation once without late playback',async()=>{
 clock=300;let resolve;const timings=[],count=audio.length;api.mockIPC(()=>new Promise(done=>resolve=done));
 const speaking=api.speakNeuralOffline('Ответ','kseniya',undefined,t=>timings.push(t));await tick();clock=340;api.stopNeuralSpeech();resolve({pcm:[0,0],sampleRate:48000});assert.equal(await speaking,false);
 assert.equal(audio.length,count);assert.deepEqual(timings.filter(t=>t.stage==='synthesis'),[{stage:'synthesis',milliseconds:40,outcome:'cancelled'}]);
});
class FakeAudioContext{sampleRate=48000;destination={};audioWorklet={addModule:async()=>{}};resume=async()=>{};close=async()=>{};createMediaStreamSource=()=>({connect(){},disconnect(){}})}
class FakeCapture{constructor(){lastCapture=this}port={onmessage:undefined};connect(){}disconnect(){}}
globalThis.AudioContext=FakeAudioContext;globalThis.AudioWorkletNode=window.AudioWorkletNode=FakeCapture;globalThis.location={href:'http://localhost/'};
Object.defineProperty(globalThis,'navigator',{value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}},configurable:true});
const feed=(count,value)=>{for(let i=0;i<count;i++){clock+=10;lastCapture.port.onmessage({data:new Float32Array(480).fill(value)})}};
await test('microphone level is measured from PCM and recognition timing brackets native transcription',async()=>{
 clock=1000;let resolve;const timings=[],levels=[],texts=[];
 api.mockIPC(command=>command==='voice_tools_status'?{recognition:true}:command==='voice_transcribe'?new Promise(done=>resolve=done):undefined);
 const mic=new api.NeuralSpeechInput({state(){},partial(){},text:text=>texts.push(text),error:error=>{throw new Error(error)},timing:t=>timings.push(t),level:value=>levels.push(value)});
 await mic.start();feed(50,.1);const finishing=mic.finish();await tick();clock=1560;resolve({text:'Остаток пластика',confidence:0.95});await finishing;
 assert.deepEqual(timings.filter(t=>t.stage==='recording'),[{stage:'recording',milliseconds:500,outcome:'completed'}]);assert.deepEqual(timings.filter(t=>t.stage==='recognition'),[{stage:'recognition',milliseconds:60,outcome:'completed'}]);
 assert(levels.length>0&&levels.every(value=>value>.099&&value<.101));assert.deepEqual(texts,['Остаток пластика']);assert(timings.every(t=>Object.keys(t).sort().join(',')==='milliseconds,outcome,stage'));mic.dispose();
});
await test('cancelled transcription emits no stale text and retains its measured cancelled duration',async()=>{
 clock=2000;let resolve;const timings=[],texts=[];api.mockIPC(command=>command==='voice_tools_status'?{recognition:true}:command==='voice_transcribe'?new Promise(done=>resolve=done):undefined);
 const mic=new api.NeuralSpeechInput({state(){},partial(){},text:text=>texts.push(text),error(){},timing:t=>timings.push(t)});await mic.start();feed(50,.1);const finishing=mic.finish();await tick();clock=2530;mic.cancel();resolve('Старая команда');await finishing;
 assert.deepEqual(texts,[]);assert.deepEqual(timings.filter(t=>t.stage==='recognition'),[{stage:'recognition',milliseconds:30,outcome:'cancelled'}]);mic.dispose();
});
await test('diagnostic observers cannot break speech, and actionable issues omit source errors',async()=>{
 api.mockIPC(command=>command==='voice_tools_status'?{recognition:true}:command==='voice_transcribe'?{text:'Остаток пластика',confidence:0.95}:{pcm:[0,0,50,0],sampleRate:48000});
 const texts=[],mic=new api.NeuralSpeechInput({state(){},partial(){},text:text=>texts.push(text),error:error=>{throw new Error(error)},timing(){throw new Error('observer')},level(){throw new Error('observer')}});
 await mic.start();feed(50,.1);await mic.finish();assert.equal(texts.length,1);mic.dispose();assert.equal(await api.speakNeuralOffline('Ответ','kseniya',undefined,()=>{throw new Error('observer')}),true);api.stopNeuralSpeech();
 const issue=api.voiceDiagnosticIssue('recognition',new Error('Не слышу речь. private filename'));assert.equal(issue.code,'no-speech');assert(!JSON.stringify(issue).includes('private'));
});
}finally{api.stopNeuralSpeech();Object.defineProperty(globalThis,'performance',{value:originalPerformance,configurable:true})}
const result={passed:true,cases:report.length,audioStored:false,physicalMicrophoneTested:false,report};
if(process.env.KF_VOICE_DIAGNOSTICS_PROOF)fs.writeFileSync(process.env.KF_VOICE_DIAGNOSTICS_PROOF,JSON.stringify(result,null,2)+'\n');
console.log('Voice diagnostics:',report.length,'cases passed');
