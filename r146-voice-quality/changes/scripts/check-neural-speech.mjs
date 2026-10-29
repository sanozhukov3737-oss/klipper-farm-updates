import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export * from './src/lib/neuralSpeech';export {setAuthSession} from './src/lib/auth';export {mockIPC} from '@tauri-apps/api/mocks';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
globalThis.window=new EventTarget();globalThis.localStorage={setItem(){}};
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
api.setAuthSession({token:'test',user:{id:'test'}});
let calls=[],transcribe=async()=> 'Принтер К1 Макс поставь на печать корпус',status=async()=>({recognition:true,synthesis:true}),lastCapture,stopped=0;
api.mockIPC(async(command,args)=>{calls.push(command);if(command==='voice_tools_status')return status();if(command==='voice_transcribe')return transcribe(args);if(command==='voice_synthesize')return{pcm:[0,0,50,0],sampleRate:48000};throw new Error(command)});
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
await test('a pause inside the command does not cut it off; final silence submits once',async()=>{calls=[];const f=make();await f.mic.start();feed(50,0.12);feed(100,0);assert.equal(f.events.texts.length,0);assert(!calls.includes('voice_transcribe'));feed(50,0.12);feed(185,0);await tick();assert.equal(f.events.texts.length,1);assert.equal(calls.filter(x=>x==='voice_transcribe').length,1);assert(stopped>0);f.mic.dispose()});
await test('cancellation during transcription never executes stale recognized text',async()=>{let resolve;transcribe=()=>new Promise(done=>resolve=done);const f=make();await f.mic.start();feed(50,0.1);const finishing=f.mic.finish();await tick();f.mic.cancel();resolve('Напечатай корпус');await finishing;assert.equal(f.events.texts.length,0);f.mic.dispose();transcribe=async()=> 'Остаток пластика'});
await test('cancellation while loading does not open the microphone',async()=>{let resolve;status=()=>new Promise(done=>resolve=done);const f=make(),starting=f.mic.start(),before=stopped;await tick();f.mic.cancel();resolve({recognition:true});await starting;assert.equal(stopped,before);assert.equal(f.events.texts.length,0);f.mic.dispose();status=async()=>({recognition:true})});
await test('missing packaged model is shown as an error without using cloud or old recognition',async()=>{calls=[];status=async()=>({recognition:false});const f=make();await f.mic.start();assert.equal(f.events.errors.length,1);assert.match(f.events.errors[0],/Whisper/);assert.deepEqual(calls,['voice_tools_status']);f.mic.dispose();status=async()=>({recognition:true})});
await test('default female voice and cancellation prevent delayed playback',async()=>{let resolve,played=0,requestedVoice;api.mockIPC((command,args)=>{requestedVoice=args.voiceId;return new Promise(done=>resolve=done)});globalThis.Audio=class{addEventListener(){}play(){played++;return Promise.resolve()}pause(){}};const speaking=api.speakNeuralOffline('Остаток пластика');await tick();assert.equal(requestedVoice,'kseniya');api.stopNeuralSpeech();resolve({pcm:[0,0],sampleRate:48000});await speaking;assert.equal(played,0)});
await test('interrupting playback does not report a missing voice module',async()=>{
 let rejectPlay,started=0;api.mockIPC(()=>({pcm:[0,0,50,0],sampleRate:48000}));
 globalThis.Audio=class{addEventListener(){}play(){started++;return new Promise((_,reject)=>rejectPlay=reject)}pause(){rejectPlay?.(new DOMException('Interrupted','AbortError'))}};
 const speaking=api.speakNeuralOffline('Проверка звука');await tick();assert.equal(started,1);api.stopNeuralSpeech();await speaking;
});
console.log('Neural speech:',cases.length,'cases passed');
