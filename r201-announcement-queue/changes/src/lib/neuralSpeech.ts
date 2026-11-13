import {secureInvoke} from './auth';
import type {ListeningState} from './offlineSpeech';
import type {VoiceTiming,VoiceDiagnosticStage} from './voiceDiagnostics';

export type NeuralVoice='kseniya';
export type RecognitionModel='base'|'small';
type Callbacks={state:(state:ListeningState)=>void;partial:(text:string)=>void;text:(text:string,confidence:number)=>void;error:(text:string)=>void;timing?:(timing:VoiceTiming)=>void;level?:(rms:number)=>void};
const measuredNow=()=>performance.now();
const publishTiming=(listener:((timing:VoiceTiming)=>void)|undefined,stage:VoiceDiagnosticStage,started:number,outcome:VoiceTiming['outcome'])=>{
  const milliseconds=measuredNow()-started;if(!Number.isFinite(milliseconds)||milliseconds<0)return;
  try{listener?.({stage,milliseconds,outcome})}catch{/* Diagnostics must never interrupt speech. */}
};
const contextHintLimits={items:16,itemCharacters:64,characters:512,bytes:1024};
const reservedContextHints=new Set(['подтверждаю печать','подтвердить печать','запускай печать','отмена','отмени','отменить','не печатай','нет','да']);
/** Decoder vocabulary is data, never an action; keep a small printable snapshot per utterance. */
export function sanitizeSpeechContextHints(values:readonly string[]){
  const hints:string[]=[],seen=new Set<string>(),encoder=new TextEncoder();
  for(const value of values.slice(0,256)){
    if(typeof value!=='string'||value.length>256)continue;
    const hint=value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/[^\p{L}\p{N} ._()-]/gu,' ').replace(/\s+/gu,' ').trim();
    const key=hint.toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
    if(!/[\p{L}\p{N}]/u.test(hint)||[...hint].length>contextHintLimits.itemCharacters||reservedContextHints.has(key)||seen.has(key))continue;
    const joined=[...hints,hint].join('. ');
    if([...joined].length>contextHintLimits.characters||encoder.encode(joined).length>contextHintLimits.bytes)continue;
    hints.push(hint);seen.add(key);if(hints.length>=contextHintLimits.items)break;
  }
  return hints;
}
let playback:HTMLAudioElement|undefined,playbackUrl:string|undefined,speechGeneration=0;
let synthesisQueue:Promise<unknown>=Promise.resolve();
export type SpeechPlaybackState='idle'|'preparing'|'playing';
let playbackState:((state:SpeechPlaybackState)=>void)|undefined;
let speechBusy=false;
let stopSpeechTimings:(()=>void)|undefined;
const announcementHolds=new Set<symbol>();
/** Defer background speech while the user is speaking or a command is being handled. */
export function holdNeuralSpeechAnnouncements(){
  const token=Symbol();announcementHolds.add(token);
  return()=>{announcementHolds.delete(token)};
}
export function stopNeuralSpeech(){
  speechGeneration++;const stopTimings=stopSpeechTimings;stopSpeechTimings=undefined;stopTimings?.();playback?.pause();playback=undefined;
  if(playbackUrl)URL.revokeObjectURL(playbackUrl);playbackUrl=undefined;
  speechBusy=false;
  playbackState?.('idle');playbackState=undefined;
}
export async function speakNeuralOffline(text:string,voiceId:NeuralVoice='kseniya',state?:(state:SpeechPlaybackState)=>void,timing?:(timing:VoiceTiming)=>void){
  return playNeuralSpeech(text,voiceId,state,()=>true,timing);
}
/** Background notices yield to conversation and are checked again after model preparation. */
// Объявления ставятся в очередь, а не отбрасываются. Раньше при занятой
// озвучке вызов сразу возвращал false, и на ферме из нескольких принтеров второе
// «печать завершена» пропадало молча. Очередь короткая: пять событий подряд
// разумно услышать, полсотни — уже нет.
const ANNOUNCEMENT_QUEUE_LIMIT = 5;
const announcementQueue: { text: string; stillCurrent: () => boolean }[] = [];
let announcementDraining = false;

async function drainAnnouncements(): Promise<void> {
  if (announcementDraining) return;
  announcementDraining = true;
  try {
    while (announcementQueue.length) {
      const next = announcementQueue.shift()!;
      if (announcementHolds.size) continue; // пауза объявлений: пропускаем, не копим
      if (!next.stillCurrent()) continue;
      try { await playNeuralSpeech(next.text, 'kseniya', undefined, next.stillCurrent); }
      catch { /* одна неудача не должна останавливать остальные */ }
    }
  } finally {
    announcementDraining = false;
  }
}

export async function trySpeakNeuralAnnouncement(text:string,stillCurrent:()=>boolean=()=>true):Promise<boolean>{
  const normalized = text.trim();
  if (!normalized) return false;
  if (announcementHolds.size || window.speechSynthesis?.speaking || window.speechSynthesis?.pending) return false;
  // Тот же текст, ещё не проигранный, второй раз не ставим: два одинаковых
  // сообщения подряд на слух сливаются в одно.
  if (announcementQueue.some(item => item.text === normalized)) return true;
  announcementQueue.push({ text: normalized, stillCurrent });
  while (announcementQueue.length > ANNOUNCEMENT_QUEUE_LIMIT) announcementQueue.shift();
  void drainAnnouncements();
  return true;
}

async function playNeuralSpeech(text:string,voiceId:NeuralVoice,state?:((state:SpeechPlaybackState)=>void),stillCurrent:()=>boolean=()=>true,timing?:(timing:VoiceTiming)=>void):Promise<boolean>{
  const allowed=()=>{try{return stillCurrent()}catch{return false}};
  if(!allowed())return false;
  stopNeuralSpeech();const generation=speechGeneration;speechBusy=true;
  const starts=new Map<VoiceDiagnosticStage,number>();
  const begin=(stage:VoiceDiagnosticStage)=>starts.set(stage,measuredNow());
  const end=(stage:VoiceDiagnosticStage,outcome:VoiceTiming['outcome'])=>{const started=starts.get(stage);if(started===undefined)return;starts.delete(stage);publishTiming(timing,stage,started,outcome)};
  stopSpeechTimings=()=>{for(const stage of starts.keys())end(stage,'cancelled')};
  playbackState=state;state?.('preparing');
  begin('synthesis-wait');
  const task=synthesisQueue.then(async()=>{
    end('synthesis-wait','completed');if(generation!==speechGeneration||!allowed())return;
    begin('synthesis');
    try{const result=await secureInvoke<{pcm:number[];sampleRate:number}>('voice_synthesize',{text:text.replace(/\s+/g,' ').slice(0,1200),voiceId});end('synthesis','completed');return result}
    catch(error){end('synthesis','error');throw error}
  });
  synthesisQueue=task.catch(()=>{});
  let result;
  try{result=await task}catch(error){if(generation!==speechGeneration)return false;stopNeuralSpeech();throw error}
  if(!result||generation!==speechGeneration||!allowed()){if(generation===speechGeneration)stopNeuralSpeech();return false}
  const bytes=new Uint8Array(result.pcm),header=wavHeader(bytes.length,result.sampleRate);
  playbackUrl=URL.createObjectURL(new Blob([header,bytes],{type:'audio/wav'}));
  const audio=new Audio(playbackUrl);playback=audio;
  const release=()=>{if(playback===audio)stopNeuralSpeech()};
  audio.addEventListener('ended',()=>{end('playback','completed');release()},{once:true});audio.addEventListener('error',()=>{end('playback','error');release()},{once:true});
  begin('playback');
  try{await audio.play();if(generation!==speechGeneration)return false;state?.('playing');return true}catch(error){if(generation!==speechGeneration)return false;end('playback','error');release();throw error}
}
function wavHeader(bytes:number,rate:number){
  const out=new ArrayBuffer(44),view=new DataView(out),str=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i))};
  str(0,'RIFF');view.setUint32(4,36+bytes,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,bytes,true);return out;
}
export function speechWave(chunks:Float32Array[],sampleRate:number,startSeconds=0,endSeconds=20){
  const length=chunks.reduce((sum,chunk)=>sum+chunk.length,0),input=new Float32Array(length);let offset=0;
  for(const chunk of chunks){input.set(chunk,offset);offset+=chunk.length}
  const start=Math.max(0,Math.floor(startSeconds*sampleRate));
  const end=Math.min(length,Math.ceil(endSeconds*sampleRate));
  const count=Math.min(20*16000,Math.floor(Math.max(0,end-start)*16000/sampleRate)),out=new Uint8Array(44+count*2);out.set(new Uint8Array(wavHeader(count*2,16000)));
  // Громкость нормализуем к -20 dBFS. Тихий голос или микрофон в метре от рта
  // иначе теряется в шуме, и Whisper слышит половину фразы. Усиление ограничено:
  // шипение пустой комнаты не должно подниматься до уровня речи.
  let peak=0,power=0;
  for(let i=start;i<end;i++){const value=input[i];power+=value*value;const magnitude=Math.abs(value);if(magnitude>peak)peak=magnitude}
  const span=Math.max(1,end-start),rms=Math.sqrt(power/span);
  const gain=rms>0.0005?Math.min(0.1/rms,peak>1e-6?12/peak:8,8):1;
  const view=new DataView(out.buffer);
  // Average each output interval to avoid the high-frequency aliasing of dropping input samples.
  for(let i=0;i<count;i++){
    const from=start+Math.floor(i*sampleRate/16000),to=Math.max(from+1,start+Math.floor((i+1)*sampleRate/16000));let sum=0;
    for(let j=from;j<Math.min(to,length);j++)sum+=input[j];
    view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,(sum/(to-from))*gain))*32767),true);
  }
  return out;
}

/** Минимальная уверенность Whisper, при которой команда считается расслышанной. */
export const MIN_RECOGNITION_CONFIDENCE=0.72;

/** Capture one complete utterance; audio remains in memory and is passed to a local process. */
export class NeuralSpeechInput{
  private audio?:AudioContext;private stream?:MediaStream;private source?:MediaStreamAudioSourceNode;private capture?:AudioWorkletNode;
  private chunks:Float32Array[]=[];private epoch=0;private active=false;private processing=false;private disposed=false;
  private timer?:ReturnType<typeof setTimeout>;private elapsed=0;private lastSpeech=0;private firstSpeech=-1;private voiced=0;private noise=0.002;
  private announcementHold?:()=>void;
  private contextHints:string[]=[];private utteranceHints:string[]=[];
  private measuredStages=new Map<VoiceDiagnosticStage,number>();private levelAt=-1;
  constructor(private callbacks:Callbacks,private modelId:RecognitionModel='base'){}
  private beginTiming(stage:VoiceDiagnosticStage){this.measuredStages.set(stage,measuredNow())}
  private endTiming(stage:VoiceDiagnosticStage,outcome:VoiceTiming['outcome']){const started=this.measuredStages.get(stage);if(started===undefined)return;this.measuredStages.delete(stage);publishTiming(this.callbacks.timing,stage,started,outcome)}
  setContextHints(names:readonly string[]){this.contextHints=sanitizeSpeechContextHints(names)}
  setModel(modelId:RecognitionModel){if(modelId!==this.modelId){this.cancel();this.modelId=modelId}}
  async start(){
    if(this.active||this.processing||this.disposed)return;this.active=true;this.utteranceHints=[...this.contextHints];this.announcementHold=holdNeuralSpeechAnnouncements();const epoch=++this.epoch;stopNeuralSpeech();window.speechSynthesis?.cancel();this.beginTiming('microphone-setup');this.callbacks.state('loading');this.callbacks.partial('');
    try{
      const status=await secureInvoke<{recognition:boolean}>('voice_tools_status');
      if(epoch!==this.epoch)return;
      if(!status.recognition)throw new Error('Не установлен новый модуль распознавания Whisper. Установите сборку с речевыми моделями.');
      await secureInvoke('voice_prepare',{engine:'recognition',modelId:this.modelId});
      if(epoch!==this.epoch)return;
      if(!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode)throw new Error('Микрофон недоступен в этой среде');
      const audio=new AudioContext();this.audio=audio;await audio.resume();
      if(epoch!==this.epoch)return;
      const stream=await navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
      if(epoch!==this.epoch){stream.getTracks().forEach(track=>track.stop());return}this.stream=stream;
      await audio.audioWorklet.addModule(new URL('/voice/capture.js',location.href).href);
      if(epoch!==this.epoch)return;
      this.elapsed=0;this.lastSpeech=0;this.firstSpeech=-1;this.voiced=0;this.noise=0.002;this.chunks=[];this.levelAt=-1;
      this.source=audio.createMediaStreamSource(stream);this.capture=new AudioWorkletNode(audio,'farm-voice-capture');
      this.capture.port.onmessage=event=>{
        if(epoch!==this.epoch||!this.active||!this.audio)return;
        const chunk=event.data as Float32Array;if(!(chunk instanceof Float32Array))return;
        this.chunks.push(chunk);const seconds=chunk.length/audio.sampleRate;this.elapsed+=seconds;
        const rms=Math.sqrt(chunk.reduce((sum,x)=>sum+x*x,0)/chunk.length);
        if(this.elapsed-this.levelAt>=0.1){this.levelAt=this.elapsed;try{this.callbacks.level?.(rms)}catch{}}
        if(rms>Math.max(0.008,this.noise*3)){if(this.firstSpeech<0)this.firstSpeech=this.elapsed-seconds;this.voiced+=seconds;this.lastSpeech=this.elapsed;}
        else if(!this.lastSpeech)this.noise=this.noise*0.95+Math.min(rms,0.01)*0.05;
        if(this.voiced>=0.25&&this.elapsed-this.lastSpeech>=1.0)void this.finish();
        else if(this.elapsed>=20)void this.finish();
      };
      this.source.connect(this.capture);this.capture.connect(audio.destination);this.endTiming('microphone-setup','completed');this.beginTiming('recording');this.callbacks.state('listening');
      this.timer=setTimeout(()=>void this.finish(),21_000);
    }catch(error){if(epoch===this.epoch){this.endTiming('microphone-setup','error');this.endTiming('recording','error');this.release();this.releaseAnnouncementHold();this.callbacks.state('idle');this.callbacks.error(error instanceof DOMException&&error.name==='NotAllowedError'?'Нет доступа к микрофону. Разрешите его в Windows.':String(error instanceof Error?error.message:error))}}
  }
  async finish(){
    if(!this.active||!this.audio)return;this.active=false;const epoch=this.epoch,rate=this.audio.sampleRate,chunks=this.chunks,voiced=this.voiced,from=Math.max(0,this.firstSpeech-0.2),to=this.lastSpeech+0.25,modelId=this.modelId,hold=this.announcementHold,contextHints=[...this.utteranceHints];
    this.endTiming('recording','completed');this.release();this.processing=true;this.callbacks.state('finishing');this.callbacks.partial('');
    try{
      if(voiced<0.25)throw new Error('Не слышу речь. Проверьте выбранный микрофон и повторите команду.');
      this.beginTiming('recognition');
      const wave=speechWave(chunks,rate,from,to);
      const result=await secureInvoke<{text:string;confidence:number}>('voice_transcribe',{wave:Array.from(wave),modelId,contextHints});
      if(epoch!==this.epoch)return;
      const text=(result?.text??'').trim(),confidence=typeof result?.confidence==='number'?result.confidence:1;
      if(!text)throw new Error('Речь не распознана. Повторите команду или введите её текстом.');
      // Уверенность ниже порога означает, что модель плохо расслышала: выполнять такую
      // команду опаснее, чем переспросить. Порог подобран на эталонной записи (0.91)
      // и на шумной (ниже 0.6).
      if(confidence<MIN_RECOGNITION_CONFIDENCE)throw new Error('Не расслышала команду. Повторите ближе к микрофону или введите её текстом.');
      this.endTiming('recognition','completed');
      this.processing=false;this.callbacks.state('idle');this.callbacks.partial('');
      // Whisper has no calibrated confirmation confidence. Only the separate Vosk confirmation path or a click may confirm printing.
      this.callbacks.text(text,confidence);
    }catch(error){if(epoch===this.epoch){this.endTiming('recognition','error');this.processing=false;this.callbacks.state('idle');this.callbacks.partial('');this.callbacks.error(String(error instanceof Error?error.message:error))}}
    finally{if(this.announcementHold===hold)this.releaseAnnouncementHold()}
  }
  private releaseAnnouncementHold(){this.announcementHold?.();this.announcementHold=undefined}
  private release(){clearTimeout(this.timer);this.capture?.disconnect();this.source?.disconnect();this.stream?.getTracks().forEach(track=>track.stop());if(this.audio)void this.audio.close().catch(()=>{});this.audio=undefined;this.stream=undefined;this.source=undefined;this.capture=undefined;this.chunks=[];this.active=false;}
  cancel(){this.epoch++;for(const stage of this.measuredStages.keys())this.endTiming(stage,'cancelled');this.processing=false;this.release();this.releaseAnnouncementHold();this.callbacks.state('idle');}
  dispose(){this.disposed=true;this.cancel();this.contextHints=[];this.utteranceHints=[];}
}
