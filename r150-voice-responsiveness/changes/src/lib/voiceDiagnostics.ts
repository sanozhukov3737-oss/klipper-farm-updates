export const VOICE_DIAGNOSTIC_STAGES=['microphone-setup','recording','recognition','command','semantic','search','validation','readiness','upload','launch','status','synthesis-wait','synthesis','playback'] as const;
export type VoiceDiagnosticStage=typeof VOICE_DIAGNOSTIC_STAGES[number];
export type VoiceProgressEvent={stage:'semantic'|'search'|'validation'|'readiness'|'upload'|'launch'|'status';phase:'start'|'end'|'error'};
export type VoiceTiming={stage:VoiceDiagnosticStage;milliseconds:number;outcome:'completed'|'cancelled'|'error'};
export type VoiceDiagnosticOutcome='running'|'ok'|'needs-input'|'error'|'cancelled';
export type VoiceDiagnosticIssue={code:'microphone-permission'|'microphone-unavailable'|'no-speech'|'recognition-unavailable'|'recognition-failed'|'speech-failed'|'command-failed';action:string};
export type VoiceDiagnosticTurn={id:string;createdAt:number;source:'text'|'voice'|'confirmation'|'preview';outcome:VoiceDiagnosticOutcome;timings:VoiceTiming[];responseMilliseconds?:number;transcript?:string;issue?:VoiceDiagnosticIssue};
export type VoiceDiagnosticsSnapshot={captureTranscript:boolean;turns:VoiceDiagnosticTurn[];storageError:boolean;cleanupFailed?:boolean};
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type Pending={at:number;depth:number;outcome:VoiceTiming['outcome']};
const MAX_TURNS=30,MAX_TIMINGS=24,MAX_CHARACTERS=48*1024,MAX_MILLISECONDS=24*60*60*1000;
const isNumber=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const stages=new Set<string>(VOICE_DIAGNOSTIC_STAGES);
const outcomes=new Set(['running','ok','needs-input','error','cancelled']);
const timingOutcomes=new Set(['completed','cancelled','error']);
const sources=new Set(['text','voice','confirmation','preview']);
const issueCodes=new Set(['microphone-permission','microphone-unavailable','no-speech','recognition-unavailable','recognition-failed','speech-failed','command-failed']);
const issueActions:Record<VoiceDiagnosticIssue['code'],string>={
  'microphone-permission':'Разрешите доступ к микрофону в Windows и повторите запись.',
  'microphone-unavailable':'Проверьте подключение и выбранный микрофон в настройках звука Windows.',
  'no-speech':'Поднесите микрофон ближе, говорите после надписи «Слушаю» и проверьте индикатор уровня.',
  'recognition-unavailable':'Проверьте, что установлена полная сборка приложения с речевыми моделями.',
  'recognition-failed':'Повторите короткую фразу или введите команду текстом. Для сложного имени выберите режим «Точнее».',
  'speech-failed':'Проверьте устройство вывода и громкость Windows, затем нажмите «Повторить озвучку».',
  'command-failed':'Проверьте ответ помощницы, соединение с принтером и повторите команду после уточнения данных.',
};
/** Persist only a fixed, local explanation. Native errors can contain filenames or transcript text. */
export function voiceDiagnosticIssue(stage:'microphone'|'recognition'|'speech'|'command',error:unknown):VoiceDiagnosticIssue{
  const message=String(error instanceof Error?error.message:error),name=error instanceof Error?error.name:'';
  let code:VoiceDiagnosticIssue['code']=stage==='speech'?'speech-failed':stage==='command'?'command-failed':'recognition-failed';
  if(stage==='microphone'||stage==='recognition'){
    if(name==='NotAllowedError'||/нет доступа к микрофону|permission denied/iu.test(message))code='microphone-permission';
    else if(name==='NotFoundError'||name==='NotReadableError'||/микрофон недоступен|device not found/iu.test(message))code='microphone-unavailable';
    else if(/не слышу речь|no speech/iu.test(message))code='no-speech';
    else if(/не установлен|модул.*whisper|model.*missing/iu.test(message))code='recognition-unavailable';
  }
  return{code,action:issueActions[code]};
}
/** Per-profile local metadata; audio is deliberately absent from the stored schema. */
export class VoiceDiagnostics{
  private key?:string;private captureTranscript=false;private turns:VoiceDiagnosticTurn[]=[];private storageError=false;private cleanupFailed=false;private disposed=false;private serial=0;
  private live=new Map<string,{started:number;pending:Map<VoiceDiagnosticStage,Pending>}>();
  constructor(private storage:StorageLike|undefined,profileId:string,private clock=()=>performance.now(),private wallClock=()=>Date.now()){
    if(profileId&&profileId.length<=128&&!/[\p{Cc}\p{Cf}]/u.test(profileId))try{this.key='klipper-voice-diagnostics-v1:'+encodeURIComponent(profileId)}catch{}
    this.read();
  }
  snapshot():VoiceDiagnosticsSnapshot{return{captureTranscript:this.captureTranscript,storageError:this.storageError,cleanupFailed:this.cleanupFailed,turns:this.turns.map(turn=>({...turn,timings:turn.timings.map(timing=>({...timing})),...(turn.issue?{issue:{...turn.issue}}:{})}))}}
  begin(source:VoiceDiagnosticTurn['source'],transcript?:string){
    if(this.disposed||!sources.has(source))return'';
    const createdAt=this.wallClock(),id=`${createdAt}-${++this.serial}`;
    this.turns.unshift({id,createdAt,source,outcome:'running',timings:[]});this.live.set(id,{started:this.clock(),pending:new Map()});
    this.turns=this.turns.slice(0,MAX_TURNS);for(const key of this.live.keys())if(!this.turns.some(turn=>turn.id===key))this.live.delete(key);
    if(transcript!==undefined)this.setTranscript(id,transcript);else this.persist();return id;
  }
  setTranscript(id:string,text:string){
    const turn=this.turn(id);if(!turn||typeof text!=='string')return;
    if(this.captureTranscript)turn.transcript=text.replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,300);else delete turn.transcript;
    this.persist();
  }
  setCaptureTranscript(enabled:boolean){
    if(this.disposed)return;this.captureTranscript=enabled;
    if(!enabled)for(const turn of this.turns)delete turn.transcript;
    this.persist(!enabled);
  }
  /** Overlapping calls of the same stage measure occupied wall time, rather than double-counting it. */
  progress(id:string,event:{stage:VoiceDiagnosticStage;phase:'start'|'end'|'error'|'cancelled'}){
    const live=this.live.get(id);if(!this.turn(id)||!live)return;
    const pending=live.pending.get(event.stage);
    if(event.phase==='start'){
      if(pending)pending.depth++;else live.pending.set(event.stage,{at:this.clock(),depth:1,outcome:'completed'});
      return;
    }
    if(!pending)return;
    if(event.phase==='error')pending.outcome='error';else if(event.phase==='cancelled'&&pending.outcome!=='error')pending.outcome='cancelled';
    if(--pending.depth>0)return;
    live.pending.delete(event.stage);this.timing(id,{stage:event.stage,milliseconds:this.clock()-pending.at,outcome:pending.outcome});
  }
  timing(id:string,timing:VoiceTiming){
    const turn=this.turn(id);if(!turn||!stages.has(timing.stage)||!timingOutcomes.has(timing.outcome)||!isNumber(timing.milliseconds)||timing.milliseconds>MAX_MILLISECONDS)return;
    turn.timings.push({stage:timing.stage,milliseconds:Math.round(timing.milliseconds),outcome:timing.outcome});turn.timings=turn.timings.slice(-MAX_TIMINGS);this.persist();
  }
  issue(id:string,issue:VoiceDiagnosticIssue){const turn=this.turn(id);if(!turn||!issueCodes.has(issue.code))return;turn.issue={code:issue.code,action:issueActions[issue.code]};this.persist()}
  finish(id:string,outcome:Exclude<VoiceDiagnosticOutcome,'running'>){
    const turn=this.turn(id),live=this.live.get(id);if(!turn||turn.outcome==='cancelled'&&outcome!=='cancelled')return;turn.outcome=outcome;
    if(live&&turn.responseMilliseconds===undefined){const duration=this.clock()-live.started;if(isNumber(duration))turn.responseMilliseconds=Math.round(duration)}
    this.persist();
  }
  finishPreview(id:string,played:boolean){this.finish(id,played?'ok':this.turn(id)?.issue?.code==='speech-failed'?'error':'cancelled')}
  cancel(id:string){
    const live=this.live.get(id);if(!this.turn(id))return;
    if(live)for(const [stage,pending] of live.pending)this.timing(id,{stage,milliseconds:this.clock()-pending.at,outcome:'cancelled'});
    this.finish(id,'cancelled');this.live.delete(id);
  }
  isCancelled(id:string){return this.turn(id)?.outcome==='cancelled'}
  clear(){if(this.disposed)return;this.turns=[];this.live.clear();this.persist(true)}
  dispose(){
    if(this.disposed)return;
    for(const [id,live] of this.live){
      for(const [stage,pending] of live.pending)this.timing(id,{stage,milliseconds:this.clock()-pending.at,outcome:'cancelled'});
      const turn=this.turn(id);if(turn?.outcome==='running')turn.outcome='cancelled';
    }
    this.persist();this.disposed=true;this.live.clear();
  }
  export(){return JSON.stringify({schema:1,audioStored:false,...this.snapshot()},null,2)}
  private turn(id:string){return this.disposed?undefined:this.turns.find(turn=>turn.id===id)}
  private read(){
    if(!this.storage||!this.key)return;
    try{
      const raw=this.storage.getItem(this.key);if(!raw||raw.length>MAX_CHARACTERS)return;
      const value=JSON.parse(raw);if(value?.version!==1||!Array.isArray(value.turns))return;
      this.captureTranscript=value.captureTranscript===true;
      for(const item of value.turns.slice(0,MAX_TURNS)){
        if(!item||typeof item.id!=='string'||item.id.length>80||!isNumber(item.createdAt)||!sources.has(item.source)||!outcomes.has(item.outcome)||!Array.isArray(item.timings))continue;
        const timings:VoiceTiming[]=item.timings.slice(-MAX_TIMINGS).filter((t:VoiceTiming)=>t&&stages.has(t.stage)&&isNumber(t.milliseconds)&&t.milliseconds<=MAX_MILLISECONDS&&timingOutcomes.has(t.outcome)).map((t:VoiceTiming)=>({stage:t.stage,milliseconds:Math.round(t.milliseconds),outcome:t.outcome}));
        const turn:VoiceDiagnosticTurn={id:item.id,createdAt:item.createdAt,source:item.source,outcome:item.outcome==='running'?'cancelled':item.outcome,timings};
        if(isNumber(item.responseMilliseconds)&&item.responseMilliseconds<=MAX_MILLISECONDS)turn.responseMilliseconds=Math.round(item.responseMilliseconds);
        if(this.captureTranscript&&typeof item.transcript==='string')turn.transcript=item.transcript.replace(/[\p{Cc}\p{Cf}]/gu,' ').slice(0,300);
        if(issueCodes.has(item.issue?.code))turn.issue={code:item.issue.code,action:issueActions[item.issue.code as VoiceDiagnosticIssue['code']]};
        if(!this.turns.some(previous=>previous.id===turn.id))this.turns.push(turn);
      }
    }catch{this.storageError=true}
  }
  private persist(removePrevious=false){
    if(!this.storage||!this.key||this.disposed)return;
    let removed=false;
    if(removePrevious)try{this.storage.removeItem(this.key);removed=true}catch{/* A sanitized overwrite may still succeed. */}
    try{
      let encoded=JSON.stringify({version:1,captureTranscript:this.captureTranscript,turns:this.turns});
      while(encoded.length>MAX_CHARACTERS&&this.turns.length){const removed=this.turns.pop()!;this.live.delete(removed.id);encoded=JSON.stringify({version:1,captureTranscript:this.captureTranscript,turns:this.turns})}
      this.storage.setItem(this.key,encoded);this.storageError=false;this.cleanupFailed=false;
    }catch{
      this.storageError=true;
      if(removePrevious){try{this.storage.removeItem(this.key);removed=true}catch{}this.cleanupFailed=!removed}
    }
  }
}
