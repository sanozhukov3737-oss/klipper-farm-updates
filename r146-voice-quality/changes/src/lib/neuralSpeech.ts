import {secureInvoke} from './auth';
import type {ListeningState} from './offlineSpeech';

export type NeuralVoice='kseniya';
type Callbacks={state:(state:ListeningState)=>void;partial:(text:string)=>void;text:(text:string,confidence:number)=>void;error:(text:string)=>void};
let playback:HTMLAudioElement|undefined,playbackUrl:string|undefined,speechGeneration=0;
let synthesisQueue:Promise<unknown>=Promise.resolve();
export function stopNeuralSpeech(){
  speechGeneration++;playback?.pause();playback=undefined;
  if(playbackUrl)URL.revokeObjectURL(playbackUrl);playbackUrl=undefined;
}
export async function speakNeuralOffline(text:string,voiceId:NeuralVoice='kseniya'){
  stopNeuralSpeech();const generation=speechGeneration;
  const task=synthesisQueue.then(()=>generation===speechGeneration?secureInvoke<{pcm:number[];sampleRate:number}>('voice_synthesize',{text:text.replace(/\s+/g,' ').slice(0,1200),voiceId}):undefined);
  synthesisQueue=task.catch(()=>{});
  const result=await task;
  if(!result||generation!==speechGeneration)return;
  const bytes=new Uint8Array(result.pcm),header=wavHeader(bytes.length,result.sampleRate);
  playbackUrl=URL.createObjectURL(new Blob([header,bytes],{type:'audio/wav'}));
  const audio=new Audio(playbackUrl);playback=audio;
  const release=()=>{if(playback===audio)stopNeuralSpeech()};
  audio.addEventListener('ended',release,{once:true});audio.addEventListener('error',release,{once:true});
  try{await audio.play()}catch(error){if(generation!==speechGeneration)return;release();throw error}
}
function wavHeader(bytes:number,rate:number){
  const out=new ArrayBuffer(44),view=new DataView(out),str=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i))};
  str(0,'RIFF');view.setUint32(4,36+bytes,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,bytes,true);return out;
}
export function speechWave(chunks:Float32Array[],sampleRate:number){
  const length=chunks.reduce((sum,chunk)=>sum+chunk.length,0),input=new Float32Array(length);let offset=0;
  for(const chunk of chunks){input.set(chunk,offset);offset+=chunk.length}
  const count=Math.min(20*16000,Math.floor(length*16000/sampleRate)),out=new Uint8Array(44+count*2);out.set(new Uint8Array(wavHeader(count*2,16000)));
  const view=new DataView(out.buffer);
  // Average each output interval to avoid the high-frequency aliasing of dropping input samples.
  for(let i=0;i<count;i++){
    const from=Math.floor(i*sampleRate/16000),to=Math.max(from+1,Math.floor((i+1)*sampleRate/16000));let sum=0;
    for(let j=from;j<Math.min(to,length);j++)sum+=input[j];
    view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,sum/(to-from)))*32767),true);
  }
  return out;
}

/** Capture one complete utterance; audio remains in memory and is passed to a local process. */
export class NeuralSpeechInput{
  private audio?:AudioContext;private stream?:MediaStream;private source?:MediaStreamAudioSourceNode;private capture?:AudioWorkletNode;
  private chunks:Float32Array[]=[];private epoch=0;private active=false;private disposed=false;
  private timer?:ReturnType<typeof setTimeout>;private elapsed=0;private lastSpeech=0;private voiced=0;private noise=0.002;
  constructor(private callbacks:Callbacks){}
  async start(){
    if(this.active||this.disposed)return;this.active=true;const epoch=++this.epoch;stopNeuralSpeech();window.speechSynthesis?.cancel();this.callbacks.state('loading');this.callbacks.partial('');
    try{
      const status=await secureInvoke<{recognition:boolean}>('voice_tools_status');
      if(epoch!==this.epoch)return;
      if(!status.recognition)throw new Error('Не установлен новый модуль распознавания Whisper. Установите сборку с речевыми моделями.');
      if(!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode)throw new Error('Микрофон недоступен в этой среде');
      const audio=new AudioContext();this.audio=audio;await audio.resume();
      if(epoch!==this.epoch)return;
      const stream=await navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
      if(epoch!==this.epoch){stream.getTracks().forEach(track=>track.stop());return}this.stream=stream;
      await audio.audioWorklet.addModule(new URL('/voice/capture.js',location.href).href);
      if(epoch!==this.epoch)return;
      this.elapsed=0;this.lastSpeech=0;this.voiced=0;this.noise=0.002;this.chunks=[];
      this.source=audio.createMediaStreamSource(stream);this.capture=new AudioWorkletNode(audio,'farm-voice-capture');
      this.capture.port.onmessage=event=>{
        if(epoch!==this.epoch||!this.active||!this.audio)return;
        const chunk=event.data as Float32Array;if(!(chunk instanceof Float32Array))return;
        this.chunks.push(chunk);const seconds=chunk.length/audio.sampleRate;this.elapsed+=seconds;
        const rms=Math.sqrt(chunk.reduce((sum,x)=>sum+x*x,0)/chunk.length);
        if(rms>Math.max(0.008,this.noise*3)){this.voiced+=seconds;this.lastSpeech=this.elapsed;}
        else if(!this.lastSpeech)this.noise=this.noise*0.95+Math.min(rms,0.01)*0.05;
        if(this.voiced>=0.25&&this.elapsed-this.lastSpeech>=1.8)void this.finish();
        else if(this.elapsed>=20)void this.finish();
      };
      this.source.connect(this.capture);this.capture.connect(audio.destination);this.callbacks.state('listening');
      this.timer=setTimeout(()=>void this.finish(),21_000);
    }catch(error){if(epoch===this.epoch){this.release();this.callbacks.state('idle');this.callbacks.error(error instanceof DOMException&&error.name==='NotAllowedError'?'Нет доступа к микрофону. Разрешите его в Windows.':String(error instanceof Error?error.message:error))}}
  }
  async finish(){
    if(!this.active||!this.audio)return;this.active=false;const epoch=this.epoch,rate=this.audio.sampleRate,chunks=this.chunks,voiced=this.voiced;
    this.release();this.callbacks.state('finishing');this.callbacks.partial('');
    try{
      if(voiced<0.25)throw new Error('Не слышу речь. Проверьте выбранный микрофон и повторите команду.');
      const wave=speechWave(chunks,rate);
      const text=(await secureInvoke<string>('voice_transcribe',{wave:Array.from(wave)})).trim();
      if(epoch!==this.epoch)return;
      if(!text)throw new Error('Речь не распознана. Повторите команду или введите её текстом.');
      this.callbacks.state('idle');this.callbacks.partial('');
      // Whisper has no calibrated confirmation confidence. Only the separate Vosk confirmation path or a click may confirm printing.
      this.callbacks.text(text,0);
    }catch(error){if(epoch===this.epoch){this.callbacks.state('idle');this.callbacks.partial('');this.callbacks.error(String(error instanceof Error?error.message:error))}}
  }
  private release(){clearTimeout(this.timer);this.capture?.disconnect();this.source?.disconnect();this.stream?.getTracks().forEach(track=>track.stop());if(this.audio)void this.audio.close().catch(()=>{});this.audio=undefined;this.stream=undefined;this.source=undefined;this.capture=undefined;this.chunks=[];this.active=false;}
  cancel(){this.epoch++;this.release();this.callbacks.state('idle');}
  dispose(){this.disposed=true;this.cancel();}
}
