import {useEffect,useMemo,useRef,useState} from 'react';
import {Mic,MicOff,Send,Volume2,VolumeX,X,LoaderCircle,Play,FileCode2,Square} from 'lucide-react';
import type {PrinterModel} from '../types';
import type {MoonrakerClient} from '../lib/moonraker';
import {VoiceAssistant,type VoiceReply,type VoiceCandidate} from '../lib/voiceAssistant';
import {interpretVoiceSemantic,prepareVoiceUnderstanding,voiceUnderstandingStatus} from '../lib/voiceUnderstanding';
import {parseVoiceCommand} from '../lib/voiceCommands';
import {VoiceLearnedNames,type VoiceLearnedName} from '../lib/voiceLearnedNames';
import {localLibraryScopeId} from '../lib/localLibraryScope';
import {localLibraryList} from '../lib/native';
import {readFilamentInventory} from '../lib/filamentInventoryStore';
import {analyzeLocalFile} from '../lib/localGCodeAnalysis';
import {validateGCodeAnalysis,printStartOptionsFromValidation} from '../lib/gcodeValidation';
import {audit} from '../lib/db';
import {OfflineSpeechInput,type ListeningState} from '../lib/offlineSpeech';
import {NeuralSpeechInput,speakNeuralOffline,stopNeuralSpeech,holdNeuralSpeechAnnouncements,type NeuralVoice,type SpeechPlaybackState,type RecognitionModel} from '../lib/neuralSpeech';
import {secureInvoke} from '../lib/auth';
import {VoiceDiagnostics,voiceDiagnosticIssue,type VoiceDiagnosticsSnapshot,type VoiceTiming,type VoiceDiagnosticStage} from '../lib/voiceDiagnostics';
import {VoiceDiagnosticsPanel,voiceDiagnosticStageLabel} from './VoiceDiagnosticsPanel';
import {VoiceCatalog} from '../lib/voiceCatalog';
import {VoiceCatalogMetadataEditor} from './VoiceCatalogMetadataEditor';
import {VoiceTaskQueue,type VoiceTask} from '../lib/voiceTaskQueue';
import {VoiceTaskQueuePanel} from './VoiceTaskQueuePanel';
import {voiceTaskHistoryEvidence} from '../lib/voiceTaskEvidence';
import {LocalGCodeThumbnail} from './LocalGCodeThumbnail';
import {hasPrinterCamera} from './PrinterCamera';
import {VoicePronunciation} from '../lib/voicePronunciation';
import {VoicePronunciationSettings} from './VoicePronunciationSettings';
import './VoiceAssistantPanel.css';

type Props={userId?:string;printers:PrinterModel[];clients:Map<string,MoonrakerClient>;canOperate:boolean;open:boolean;onClose:()=>void;onOpenCamera?:(printerId:string)=>boolean|void;onNavigate?:(target:string,printerId?:string)=>boolean|void};
type Message={id:number;kind:'user'|'assistant';text:string};
const greeting='Скажите своими словами, что нужно сделать с печатью, файлами или принтерами. Если не хватит данных, я уточню.';
const recognitionKey=(profileId?:string)=>'klipper-voice-recognition-v1:'+encodeURIComponent(profileId??'');
const readRecognitionModel=(profileId?:string):RecognitionModel=>{
  try{return localStorage.getItem(recognitionKey(profileId))==='base'?'base':'small'}catch{return'small'}
};
export function VoiceAssistantPanel(props:Props){
  const latest=useRef(props);latest.current=props;
  const pronunciation=useMemo(()=>{let storage:Storage|undefined;try{storage=localStorage}catch{}return new VoicePronunciation(storage,props.userId??'')},[props.userId]);
  const [messages,setMessages]=useState<Message[]>([{id:0,kind:'assistant',text:greeting}]);
  const [reply,setReply]=useState<VoiceReply>({text:greeting}),[input,setInput]=useState(''),[partial,setPartial]=useState('');
  const [listening,setListening]=useState<ListeningState>('idle'),[busy,setBusy]=useState(false),[voice,setVoice]=useState(true),[voiceAvailable,setVoiceAvailable]=useState(false);
  const [voiceId,setVoiceId]=useState<NeuralVoice>('kseniya'),[speechError,setSpeechError]=useState('');
  const [speechState,setSpeechState]=useState<SpeechPlaybackState>('idle'),[warming,setWarming]=useState(false);
  const profileRevision=useRef(0);
  const diagnostics=useRef<VoiceDiagnostics>(),activeCommandTurn=useRef<string>(),recordingTurn=useRef<{id:string;revision:number}>();
  const [diagnosticSnapshot,setDiagnosticSnapshot]=useState<VoiceDiagnosticsSnapshot>({captureTranscript:false,turns:[],storageError:false});
  const [operationStage,setOperationStage]=useState<VoiceDiagnosticStage>(),[microphoneLevel,setMicrophoneLevel]=useState(0),[heard,setHeard]=useState(''),[microphoneError,setMicrophoneError]=useState('');
  const refreshDiagnostics=()=>setDiagnosticSnapshot(diagnostics.current?.snapshot()??{captureTranscript:false,turns:[],storageError:false});
  const learned=useRef<VoiceLearnedNames>();
  const [learnedNames,setLearnedNames]=useState<VoiceLearnedName[]>([]),[learningError,setLearningError]=useState('');
  const refreshLearning=()=>setLearnedNames(learned.current?.list()??[]);
  const catalog=useRef<VoiceCatalog>(),tasks=useRef<VoiceTaskQueue>();
  const [queuedTasks,setQueuedTasks]=useState<VoiceTask[]>([]),[queueOpen,setQueueOpen]=useState(false),[queueError,setQueueError]=useState('');
  const refreshTasks=()=>{setQueuedTasks(tasks.current?.list()??[]);const status=tasks.current?.availability();setQueueError(status?.available?'':status?.error??'')};
  const [recognitionModel,setRecognitionModel]=useState<RecognitionModel>(()=>readRecognitionModel(props.userId));
  const [understandingAvailable,setUnderstandingAvailable]=useState<boolean>();
  const [understandingWarming,setUnderstandingWarming]=useState(false);
  const commandInput=useRef<HTMLInputElement>(null);
  const assistant=useRef<VoiceAssistant>(),accurateMicrophone=useRef<NeuralSpeechInput>(),microphone=useRef<OfflineSpeechInput>(),serial=useRef(0),mounted=useRef(false),busyRef=useRef(false);
  const microphoneAnnouncementHold=useRef<(()=>void)>();
  const commandAnnouncementHolds=useRef(new Set<()=>void>());
  const holdCommandAnnouncements=()=>{
    const release=holdNeuralSpeechAnnouncements();
    const done=()=>{release();commandAnnouncementHolds.current.delete(done)};
    commandAnnouncementHolds.current.add(done);return done;
  };
  const releaseCommandAnnouncements=()=>{for(const release of commandAnnouncementHolds.current)release()};
  const submitRef=useRef<(text:string,confidence?:number,turnId?:string)=>void>(()=>{}),log=useRef<HTMLDivElement>(null);
  const append=(kind:Message['kind'],text:string)=>setMessages(items=>[...items,{id:++serial.current,kind,text}].slice(-30));
  const beginTurn=(source:'text'|'voice'|'confirmation'|'preview',text?:string)=>{const id=diagnostics.current?.begin(source,text)??'';refreshDiagnostics();return id};
  const recordTiming=(turnId:string,revision:number,timing:VoiceTiming)=>{
    if(!mounted.current||revision!==profileRevision.current)return;
    diagnostics.current?.timing(turnId,timing);
    if(timing.outcome==='error'&&(timing.stage==='synthesis'||timing.stage==='playback')){const issue=voiceDiagnosticIssue('speech','');diagnostics.current?.issue(turnId,issue);setSpeechError(issue.action)}
    refreshDiagnostics();
  };
  const say=(text:string,turnId?:string)=>{
    if(pronunciation.profileId!==(latest.current.userId??''))return;
    const revision=profileRevision.current,id=turnId??beginTurn('preview');setSpeechError('');
    void speakNeuralOffline(pronunciation.apply(text),voiceId,state=>{if(mounted.current&&revision===profileRevision.current)setSpeechState(state)},timing=>recordTiming(id,revision,timing))
      .then(played=>{if(mounted.current&&revision===profileRevision.current&&!turnId){diagnostics.current?.finishPreview(id,played);refreshDiagnostics()}})
      .catch(error=>{if(mounted.current&&revision===profileRevision.current){const issue=voiceDiagnosticIssue('speech',error);diagnostics.current?.issue(id,issue);if(!turnId)diagnostics.current?.finish(id,'error');refreshDiagnostics();if(latest.current.open)setSpeechError(issue.action)}});
  };
  const deliver=(result:VoiceReply,turnId?:string)=>{if(!mounted.current)return;refreshLearning();refreshTasks();if(result.plan?.length)setQueueOpen(true);setReply(result);append('assistant',result.text);if(voice&&latest.current.open&&!document.hidden)say(result.text,turnId)};
  const runAssistantAction=async(action:()=>Promise<VoiceReply>,turnId:string,revision:number)=>{
    if(!activeCommandTurn.current)activeCommandTurn.current=turnId;
    diagnostics.current?.progress(turnId,{stage:'command',phase:'start'});setOperationStage('command');
    try{
      const result=await action();if(!mounted.current||revision!==profileRevision.current||diagnostics.current?.isCancelled(turnId))return;
      const outcome=result.diagnosticOutcome??(result.clarification?'needs-input':'ok');
      diagnostics.current?.progress(turnId,{stage:'command',phase:outcome==='error'?'error':outcome==='cancelled'?'cancelled':'end'});
      diagnostics.current?.finish(turnId,outcome);refreshDiagnostics();deliver(result,turnId);
    }catch(error){if(mounted.current&&revision===profileRevision.current){
      const issue=voiceDiagnosticIssue('command',error);diagnostics.current?.progress(turnId,{stage:'command',phase:'error'});diagnostics.current?.issue(turnId,issue);diagnostics.current?.finish(turnId,'error');refreshDiagnostics();deliver({text:issue.action,diagnosticOutcome:'error'},turnId);
    }}finally{if(activeCommandTurn.current===turnId)activeCommandTurn.current=undefined;if(mounted.current&&revision===profileRevision.current)setOperationStage(undefined)}
  };
  const execute=async(text:string,confidence?:number,turnId?:string)=>{
    text=text.trim();if(!text)return;
    const intent=parseVoiceCommand(text);
    if(busyRef.current&&intent.kind!=='cancel'){
      // The previous command is still running (free-form understanding can take a couple of
      // minutes on a slow computer). Say so instead of silently dropping the new command.
      const message='Предыдущая команда ещё выполняется — она скоро завершится. Подожди немного или нажми «Отменить запрос».';
      setReply({text:message});append('assistant',message);return;
    }
    const releaseAnnouncement=holdCommandAnnouncements(),revision=profileRevision.current;
    if(recordingTurn.current&&recordingTurn.current.id!==turnId)diagnostics.current?.cancel(recordingTurn.current.id);
    if(intent.kind==='cancel'&&activeCommandTurn.current)diagnostics.current?.cancel(activeCommandTurn.current);
    const id=turnId??beginTurn(confidence===undefined?'text':'voice',text);diagnostics.current?.setTranscript(id,text);setMicrophoneError('');
    try{
    microphone.current?.cancel();accurateMicrophone.current?.cancel();recordingTurn.current=undefined;stopNeuralSpeech();speechSynthesis.cancel();setPartial('');setInput('');append('user',text);
    if(intent.kind==='confirm'&&confidence!==undefined&&confidence<0.8){diagnostics.current?.finish(id,'needs-input');refreshDiagnostics();deliver({text:'Для голосового подтверждения нажмите «Подтвердить голосом» и скажите «Подтверждаю печать». Можно также нажать кнопку подтверждения.'},id);return;}
    busyRef.current=true;setBusy(true);
    try{await runAssistantAction(()=>assistant.current!.handle(text),id,revision)}finally{if(mounted.current&&revision===profileRevision.current){busyRef.current=false;setBusy(false)}}
    }finally{releaseAnnouncement()}
  };
  submitRef.current=execute;
  useEffect(()=>{
    mounted.current=true;profileRevision.current++;busyRef.current=false;setBusy(false);
    setRecognitionModel(readRecognitionModel(latest.current.userId));setUnderstandingAvailable(undefined);
    const revision=profileRevision.current,current=()=>mounted.current&&profileRevision.current===revision;
    let storage:Storage|undefined;try{storage=localStorage}catch{}
    const profileDiagnostics=new VoiceDiagnostics(storage,latest.current.userId??'');diagnostics.current=profileDiagnostics;activeCommandTurn.current=undefined;recordingTurn.current=undefined;refreshDiagnostics();setOperationStage(undefined);setMicrophoneLevel(0);setHeard('');setMicrophoneError('');setSpeechError('');
    learned.current=new VoiceLearnedNames(storage,latest.current.userId??'');refreshLearning();setLearningError('');
    catalog.current=new VoiceCatalog(storage,latest.current.userId??'');
    const profileTasks=new VoiceTaskQueue(storage,latest.current.userId??'');tasks.current=profileTasks;refreshTasks();setQueueOpen(false);
    const unsubscribeTasks=profileTasks.subscribe(()=>{if(current())refreshTasks()});
    setMessages([{id:0,kind:'assistant',text:greeting}]);setReply({text:greeting});
    const client=(id:string)=>{const value=latest.current.clients.get(id);if(!value)throw new Error('Нет соединения с принтером');return value};
    assistant.current=new VoiceAssistant({
      interpret:interpretVoiceSemantic,
      hasCamera:hasPrinterCamera,openCamera:id=>{const open=latest.current.onOpenCamera;return open?open(id):false},
      navigate:(target,printerId)=>{const open=latest.current.onNavigate;return open?open(target,printerId):false},
      progress:event=>{const id=activeCommandTurn.current;if(current()&&id){profileDiagnostics.progress(id,event);setOperationStage(event.phase==='start'?event.stage:'command');refreshDiagnostics()}},
      learning:learned.current,catalog:catalog.current,tasks:profileTasks,printers:()=>latest.current.printers,canOperate:()=>latest.current.canOperate,client:id=>latest.current.clients.get(id),
      list:async scope=>(await localLibraryList(scope)).files,inventory:readFilamentInventory,
      validate:async(printer,candidate,signal)=>{const {analysis,sha256}=await analyzeLocalFile(candidate.scopeId,candidate.entry.path,signal);return{sha256,report:validateGCodeAnalysis(printer,candidate.entry.path,analysis)}},
      ready:async printer=>{
        if(!await client(printer.id).checkIdleReady())throw new Error('Принтер не подтвердил готовность. Проверьте его карточку');
      },
      upload:(printer,proposal,signal)=>client(printer.id).uploadLocalLibrary(proposal.candidate.entry.path,proposal.sha256,proposal.candidate.scopeId,undefined,signal),
      start:(printer,path,report)=>client(printer.id).start(path,printStartOptionsFromValidation(report)),
      check:async(printer,path)=>(await client(printer.id).checkPrintStart(path)).confirmed,
      taskHistory:async(printer,path,dispatchedAt,signal)=>{
        const page=await client(printer.id).historyPage({limit:100,since:dispatchedAt/1000,order:'asc',signal});
        return voiceTaskHistoryEvidence(page.jobs,path,dispatchedAt).confirmed;
      },
      audit:message=>audit('voice.validated_start',message),
    });
    let confirmationStage:VoiceDiagnosticStage|undefined,confirmationTurn:string|undefined;
    const inputState=(engine:'neural'|'confirmation')=>(state:ListeningState)=>{
      if(!current())return;
      if(engine==='confirmation'){
        if(confirmationStage&&confirmationTurn)profileDiagnostics.progress(confirmationTurn,{stage:confirmationStage,phase:'end'});
        confirmationStage=state==='loading'?'microphone-setup':state==='listening'?'recording':state==='finishing'?'recognition':undefined;
        confirmationTurn=recordingTurn.current?.id;
        if(confirmationStage&&confirmationTurn)profileDiagnostics.progress(confirmationTurn,{stage:confirmationStage,phase:'start'});
        refreshDiagnostics();
      }
      if(state==='idle'){microphoneAnnouncementHold.current?.();microphoneAnnouncementHold.current=undefined}
      else microphoneAnnouncementHold.current??=holdNeuralSpeechAnnouncements();
      setListening(state);if(state==='idle')setMicrophoneLevel(0);
    };
    const received=(text:string,confidence:number)=>{if(current()){setHeard(text.slice(0,300));submitRef.current(text,confidence,recordingTurn.current?.id)}};
    const inputError=(text:string)=>{if(current()){
      const id=recordingTurn.current?.id,issue=voiceDiagnosticIssue('recognition',text);if(id){profileDiagnostics.issue(id,issue);profileDiagnostics.finish(id,'error')}recordingTurn.current=undefined;refreshDiagnostics();setMicrophoneError(issue.action);setReply({text});append('assistant',text);
    }};
    microphone.current=new OfflineSpeechInput({state:inputState('confirmation'),partial:text=>{if(current())setPartial(text)},text:received,error:inputError});
    accurateMicrophone.current=new NeuralSpeechInput({state:inputState('neural'),partial:text=>{if(current())setPartial(text)},text:received,error:inputError,timing:timing=>{const id=recordingTurn.current?.id;if(id)recordTiming(id,revision,timing)},level:level=>{if(current())setMicrophoneLevel(level)}});
    void secureInvoke<{synthesis:boolean}>('voice_tools_status').then(status=>{if(current())setVoiceAvailable(status.synthesis)}).catch(()=>{});
    void voiceUnderstandingStatus().then(status=>{if(current())setUnderstandingAvailable(status.available)}).catch(()=>{if(current())setUnderstandingAvailable(false)});
    return()=>{mounted.current=false;unsubscribeTasks();microphone.current?.dispose();accurateMicrophone.current?.dispose();microphoneAnnouncementHold.current?.();microphoneAnnouncementHold.current=undefined;releaseCommandAnnouncements();assistant.current?.dispose();stopNeuralSpeech();speechSynthesis.cancel();profileDiagnostics.dispose();activeCommandTurn.current=undefined;recordingTurn.current=undefined};
  },[props.userId]);
  const vocabularyKey=JSON.stringify(props.printers.map(p=>[p.id,p.name,localLibraryScopeId(p)]));
  useEffect(()=>{
    if(!props.open||!understandingAvailable){setUnderstandingWarming(false);return}
    let active=true;setUnderstandingWarming(true);
    void prepareVoiceUnderstanding().catch(()=>{}).finally(()=>{if(active)setUnderstandingWarming(false)});
    return()=>{active=false};
  },[props.open,props.userId,understandingAvailable]);
  useEffect(()=>{
    if(!props.open)return;let cancelled=false;
    const refresh=()=>void assistant.current?.refreshSpeechHints().then(names=>{if(!cancelled)accurateMicrophone.current?.setContextHints(names)});
    refresh();const timer=setInterval(refresh,45_000);
    return()=>{cancelled=true;clearInterval(timer)};
  },[props.open,props.userId,vocabularyKey]);
  useEffect(()=>{
    if(!props.open)return;
    let cancelled=false;setWarming(true);
    accurateMicrophone.current?.setModel(recognitionModel);
    void Promise.all(['recognition','synthesis'].map(engine=>secureInvoke('voice_prepare',{engine,modelId:recognitionModel})))
      .catch(()=>{if(!cancelled)setSpeechError('Не удалось заранее подготовить речь. При команде попробую ещё раз.')})
      .finally(()=>{if(!cancelled)setWarming(false)});
    return()=>{cancelled=true};
  },[props.open,recognitionModel,props.userId]);
  useEffect(()=>{if(!props.open){if(recordingTurn.current)diagnostics.current?.cancel(recordingTurn.current.id);if(activeCommandTurn.current)diagnostics.current?.cancel(activeCommandTurn.current);microphone.current?.cancel();accurateMicrophone.current?.cancel();recordingTurn.current=undefined;assistant.current?.cancel();releaseCommandAnnouncements();stopNeuralSpeech();speechSynthesis.cancel();refreshDiagnostics();setReply({text:greeting});setPartial('');setHeard('');setMicrophoneError('')}},[props.open]);
  useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight,behavior:'smooth'})},[messages,partial]);
  useEffect(()=>{
    const hide=()=>{if(!document.hidden)return;if(recordingTurn.current)diagnostics.current?.cancel(recordingTurn.current.id);microphone.current?.cancel();accurateMicrophone.current?.cancel();recordingTurn.current=undefined;stopNeuralSpeech();speechSynthesis.cancel();refreshDiagnostics();setPartial('');setMicrophoneLevel(0)};
    document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide);
  },[]);
  const choose=async(candidate:VoiceCandidate)=>{
    if(busyRef.current)return;const releaseAnnouncement=holdCommandAnnouncements(),revision=profileRevision.current;busyRef.current=true;setBusy(true);if(recordingTurn.current)diagnostics.current?.cancel(recordingTurn.current.id);microphone.current?.cancel();accurateMicrophone.current?.cancel();recordingTurn.current=undefined;stopNeuralSpeech();speechSynthesis.cancel();
    const id=beginTurn('text');try{await runAssistantAction(()=>assistant.current!.choose(candidate),id,revision)}finally{releaseAnnouncement();if(revision===profileRevision.current){busyRef.current=false;if(mounted.current)setBusy(false)}}
  };
  const choosePrinter=async(id:string)=>{
    if(busyRef.current)return;const releaseAnnouncement=holdCommandAnnouncements(),revision=profileRevision.current;busyRef.current=true;setBusy(true);if(recordingTurn.current)diagnostics.current?.cancel(recordingTurn.current.id);microphone.current?.cancel();accurateMicrophone.current?.cancel();recordingTurn.current=undefined;stopNeuralSpeech();speechSynthesis.cancel();
    const turnId=beginTurn('text');try{await runAssistantAction(()=>assistant.current!.choosePrinter(id),turnId,revision)}finally{releaseAnnouncement();if(revision===profileRevision.current){busyRef.current=false;if(mounted.current)setBusy(false)}}
  };
  const startMicrophone=()=>{
    stopNeuralSpeech();
    if(listening!=='idle'){microphone.current?.finish();void accurateMicrophone.current?.finish();return}
    recordingTurn.current={id:beginTurn('voice'),revision:profileRevision.current};setHeard('');setMicrophoneError('');setSpeechError('');setMicrophoneLevel(0);
    accurateMicrophone.current?.setContextHints(assistant.current?.speechHints()??[]);
    void accurateMicrophone.current?.start();
    const revision=profileRevision.current;void assistant.current?.refreshSpeechHints().then(names=>{if(mounted.current&&revision===profileRevision.current)accurateMicrophone.current?.setContextHints(names)});
  };
  const startConfirmation=()=>{stopNeuralSpeech();recordingTurn.current={id:beginTurn('confirmation'),revision:profileRevision.current};setHeard('');setMicrophoneError('');void microphone.current?.start(['подтверждаю печать','отмена'])};
  const queueAction=async(id:string,check=false)=>{
    if(busyRef.current)return;const revision=profileRevision.current,release=holdCommandAnnouncements();busyRef.current=true;setBusy(true);
    if(recordingTurn.current)diagnostics.current?.cancel(recordingTurn.current.id);microphone.current?.cancel();accurateMicrophone.current?.cancel();recordingTurn.current=undefined;stopNeuralSpeech();speechSynthesis.cancel();
    const turn=beginTurn('text');
    try{await runAssistantAction(()=>check?assistant.current!.checkTask(id):assistant.current!.prepareTask(id),turn,revision)}finally{release();if(mounted.current&&revision===profileRevision.current){busyRef.current=false;setBusy(false);refreshTasks()}}
  };
  const removeTask=(id?:string)=>{
    if(busyRef.current)return;const result=id?tasks.current?.remove(id):tasks.current?.reset();
    if(result?.ok){assistant.current?.cancel();setReply({text:'План обновлён. Выберите следующее задание для проверки.'})}
    refreshTasks();if(result&&!result.ok)setQueueError(result.error??'Не удалось изменить план');
  };
  const candidateKey=(c:VoiceCandidate)=>JSON.stringify([c.scopeId,c.printerId,c.entry.path]);
  if(!props.open)return null;
  return <section className="kfVoicePanel" role="dialog" aria-label="Голосовой помощник" aria-modal="false" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();props.onClose()}}}>
    <header><div className="kfVoiceSymbol"><Mic/></div><div><h2>Помощник фермы</h2><span><i/>Работает без интернета</span></div><button type="button" aria-label="Закрыть помощника" onClick={props.onClose}><X/></button></header>
    <div className="kfVoiceMessages" ref={log} role="log" aria-live="polite">{messages.map(message=><div key={message.id} className={'kfVoiceMessage '+message.kind}>{message.text}</div>)}{partial&&<div className="kfVoicePartial">Слышу: {partial}</div>}</div>
    <div className="kfVoiceChoices">{reply.clarification!=='printer'&&reply.choices?.map((candidate,index)=><div className="kfVoiceCandidate" key={candidateKey(candidate)}><button disabled={busy} onClick={()=>choose(candidate)}><LocalGCodeThumbnail printerId={candidate.scopeId} entry={candidate.entry} fallback={<FileCode2/>} alt={'Предпросмотр '+candidate.entry.path}/><span><b>{index+1}. {candidate.entry.path}</b><small>{candidate.printerName}</small></span></button>{reply.matchReasons?.[candidateKey(candidate)]&&<small className="kfVoiceMatchReason">{reply.matchReasons[candidateKey(candidate)].join(' · ')}</small>}{props.userId&&<VoiceCatalogMetadataEditor userId={props.userId} scopeId={candidate.scopeId} entry={candidate.entry} catalog={catalog.current}/>}</div>)}</div>
    {!!reply.printerChoices?.length&&<div className="kfVoiceChoices" aria-label="Выбор принтера">{reply.printerChoices.map((printer,index)=><button key={printer.id} disabled={busy} onClick={()=>choosePrinter(printer.id)}><Play/><span><b>{index+1}. {printer.name}</b><small>Выбрать принтер</small></span></button>)}</div>}
    {reply.proposal&&<div className="kfVoiceProposal"><b>{reply.proposal.candidate.entry.path}</b><span>{reply.proposal.candidate.printerName}</span><button className="primary" disabled={busy||!props.canOperate} onClick={()=>execute('Подтверждаю печать')}><Play/>Подтверждаю печать</button><button type="button" disabled={busy||listening!=='idle'||!props.canOperate} onClick={startConfirmation}><Mic/>Подтвердить голосом</button><button disabled={busy} onClick={()=>execute('Отмена')}>Отмена</button></div>}
    {reply.proposal&&props.userId&&<VoiceCatalogMetadataEditor userId={props.userId} scopeId={reply.proposal.candidate.scopeId} entry={reply.proposal.candidate.entry} catalog={catalog.current}/>}
    {reply.unconfirmed&&<button className="kfVoiceCheck" disabled={busy} onClick={()=>execute('Проверь запуск')}>Проверить запуск без повторной отправки</button>}
    <details className="kfVoicePlan" open={queueOpen} onToggle={event=>setQueueOpen(event.currentTarget.open)}><summary>План заданий · {queuedTasks.length}</summary><VoiceTaskQueuePanel tasks={queuedTasks} busy={busy} canOperate={props.canOperate} onPrepare={id=>void queueAction(id)} onCheck={id=>void queueAction(id,true)} onRemove={removeTask} onReset={()=>removeTask()}/>{queueError&&<p role="alert">{queueError}</p>}</details>
    <div className="kfVoiceSuggestions">{['Сколько осталось пластика?','Какие принтеры свободны?','Покажи очередь помощника'].map(text=><button disabled={busy} key={text} onClick={()=>execute(text)}>{text}</button>)}</div>
    <form onSubmit={event=>{event.preventDefault();void execute(input)}}><input ref={commandInput} aria-label="Команда помощнику" value={input} maxLength={300} onChange={event=>setInput(event.target.value)} placeholder="Скажите или напишите задачу своими словами…"/><button type="submit" disabled={busy||!input.trim()} aria-label="Отправить команду"><Send/></button><button type="button" className={listening==='listening'?'listening':''} disabled={busy||listening==='loading'||listening==='finishing'} aria-label={listening==='idle'?'Включить микрофон':'Завершить запись'} onClick={startMicrophone}>{listening==='loading'||listening==='finishing'?<LoaderCircle className="spin"/>:listening==='listening'?<MicOff/>:<Mic/>}</button></form>
    {heard&&<p className="kfVoiceHeard"><b>Услышала:</b> {heard} <button type="button" disabled={busy||listening!=='idle'} onClick={()=>{setInput(heard);commandInput.current?.focus()}}>Исправить</button></p>}
    {understandingAvailable===false&&<p className="kfVoiceHint" role="status">В этой установке нет модуля понимания свободной речи. Для него нужна полная новая сборка.</p>}
    {busy&&<button type="button" className="kfVoiceCheck" onClick={()=>void execute('Отмена')}>Отменить запрос</button>}
    {listening==='listening'&&<div className="kfVoiceMicrophoneLevel"><label>Уровень микрофона <meter aria-label="Уровень микрофона" min={0} max={0.2} value={Math.min(0.2,microphoneLevel)}/></label><small>{microphoneLevel>0.008?'Сигнал есть':'Пока тишина'}</small></div>}
    {microphoneError&&<p className="kfVoiceLocalError" role="alert">{microphoneError}</p>}
    <footer><span role="status">{busy?(operationStage&&operationStage!=='command'?voiceDiagnosticStageLabel(operationStage)+'…':'Проверяю и выполняю…'):listening==='loading'?'Подготавливаю распознавание…':listening==='listening'?'Слушаю одну команду…':listening==='finishing'?'Распознаю команду…':speechState==='preparing'?'Подготавливаю озвучку ответа…':speechState==='playing'?'Ксения отвечает…':warming?'Подготавливаю речь для быстрых ответов…':understandingWarming?'Подготавливаю понимание свободной речи…':'Готова к команде'}</span><div><button type="button" aria-label="Остановить озвучку" onClick={()=>{stopNeuralSpeech();speechSynthesis.cancel()}}><Square/>Стоп</button><button aria-label={voice?'Выключить голосовые ответы':'Включить голосовые ответы'} aria-pressed={voice} onClick={()=>{setVoice(!voice);stopNeuralSpeech();speechSynthesis.cancel()}}>{voice?<Volume2/>:<VolumeX/>}</button></div></footer>
    <label className="kfVoiceHint">Голос: <select aria-label="Голос помощника" value={voiceId} onChange={event=>{stopNeuralSpeech();setVoiceId(event.target.value as NeuralVoice)}}><option value="kseniya">Ксения — русский, офлайн</option></select> <button type="button" disabled={busy||listening!=='idle'||speechState==='preparing'} onClick={()=>say('Привет! Рада тебя слышать. Помогу найти файл, проверить принтеры и узнать остатки пластика.')}>Послушать</button></label>
    {speechError&&voice&&<button type="button" disabled={busy||listening!=='idle'||speechState==='preparing'} onClick={()=>say(reply.text)}>Повторить озвучку</button>}
    <label className="kfVoiceHint">Распознавание: <select aria-label="Режим распознавания" value={recognitionModel} disabled={busy||listening!=='idle'} onChange={event=>{const model=event.target.value as RecognitionModel;setRecognitionModel(model);try{localStorage.setItem(recognitionKey(props.userId),model)}catch{}}}><option value="base">Быстро</option><option value="small">Точнее</option></select></label>
    <VoicePronunciationSettings key={'pronunciation:'+(props.userId??'')} store={pronunciation} disabled={busy||listening!=='idle'||speechState==='preparing'} onPreview={text=>say(text)}/>
    <details className="kfVoiceLearning"><summary>Запомненные названия: {learnedNames.length}</summary><p>Исправления сохраняются на этом компьютере только для вашего профиля.</p>{learnedNames.map(row=><div key={JSON.stringify([row.query,row.scopeId,row.path])}><span><b>{row.query}</b><small>{row.path}</small></span><button type="button" disabled={busy} aria-label={'Забыть название '+row.query} onClick={()=>{const result=learned.current?.forget(row.query,row.scopeId,row.path);setLearningError(result?.saved?'':'Не удалось сохранить изменение.');refreshLearning()}}>Забыть</button></div>)}{!!learnedNames.length&&<button type="button" disabled={busy} onClick={()=>{const result=learned.current?.reset();setLearningError(result?.saved?'':'Не удалось очистить запомненные названия.');refreshLearning()}}>Забыть все названия</button>}{learningError&&<p role="status">{learningError}</p>}</details>
    <VoiceDiagnosticsPanel key={props.userId??''} snapshot={diagnosticSnapshot} onCaptureText={enabled=>{diagnostics.current?.setCaptureTranscript(enabled);refreshDiagnostics()}} onClear={()=>{diagnostics.current?.clear();refreshDiagnostics()}} onExport={()=>diagnostics.current?.export()??''}/>
    {(speechError||!voiceAvailable)&&<p className="kfVoiceHint">{speechError||'Для нейроголоса установите новую сборку с речевым модулем. Текстовые команды доступны.'}</p>}
  </section>;
}
