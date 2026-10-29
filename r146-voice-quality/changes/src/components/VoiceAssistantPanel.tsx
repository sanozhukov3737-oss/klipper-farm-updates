import {useEffect,useRef,useState} from 'react';
import {Mic,MicOff,Send,Volume2,VolumeX,X,LoaderCircle,Play,FileCode2} from 'lucide-react';
import type {PrinterModel} from '../types';
import type {MoonrakerClient} from '../lib/moonraker';
import {VoiceAssistant,type VoiceReply,type VoiceCandidate} from '../lib/voiceAssistant';
import {parseVoiceCommand} from '../lib/voiceCommands';
import {localLibraryList} from '../lib/native';
import {readFilamentInventory} from '../lib/filamentInventoryStore';
import {analyzeLocalFile} from '../lib/localGCodeAnalysis';
import {validateGCodeAnalysis,printStartOptionsFromValidation} from '../lib/gcodeValidation';
import {audit} from '../lib/db';
import {OfflineSpeechInput,type ListeningState} from '../lib/offlineSpeech';
import {NeuralSpeechInput,speakNeuralOffline,stopNeuralSpeech,type NeuralVoice} from '../lib/neuralSpeech';
import {secureInvoke} from '../lib/auth';
import './VoiceAssistantPanel.css';

type Props={printers:PrinterModel[];clients:Map<string,MoonrakerClient>;canOperate:boolean;open:boolean;onClose:()=>void};
type Message={id:number;kind:'user'|'assistant';text:string};
const greeting='Я помогу найти файл, запустить печать и узнать остатки пластика. Нажмите микрофон и скажите команду.';
export function VoiceAssistantPanel(props:Props){
  const latest=useRef(props);latest.current=props;
  const [messages,setMessages]=useState<Message[]>([{id:0,kind:'assistant',text:greeting}]);
  const [reply,setReply]=useState<VoiceReply>({text:greeting}),[input,setInput]=useState(''),[partial,setPartial]=useState('');
  const [listening,setListening]=useState<ListeningState>('idle'),[busy,setBusy]=useState(false),[voice,setVoice]=useState(true),[voiceAvailable,setVoiceAvailable]=useState(false);
  const [voiceId,setVoiceId]=useState<NeuralVoice>('kseniya'),[speechError,setSpeechError]=useState('');
  const assistant=useRef<VoiceAssistant>(),accurateMicrophone=useRef<NeuralSpeechInput>(),microphone=useRef<OfflineSpeechInput>(),serial=useRef(0),mounted=useRef(false),busyRef=useRef(false);
  const submitRef=useRef<(text:string,confidence?:number)=>void>(()=>{}),log=useRef<HTMLDivElement>(null);
  const append=(kind:Message['kind'],text:string)=>setMessages(items=>[...items,{id:++serial.current,kind,text}].slice(-30));
  const deliver=(result:VoiceReply)=>{if(!mounted.current)return;setReply(result);append('assistant',result.text);if(voice&&latest.current.open){setSpeechError('');void speakNeuralOffline(result.text,voiceId).catch(()=>{if(mounted.current)setSpeechError('Нейроголос недоступен. Проверьте установку речевого модуля или выключите озвучивание.')})}};
  const execute=async(text:string,confidence?:number)=>{
    text=text.trim();if(!text)return;
    const intent=parseVoiceCommand(text);
    if(busyRef.current&&intent.kind!=='cancel')return;
    microphone.current?.cancel();accurateMicrophone.current?.cancel();stopNeuralSpeech();speechSynthesis.cancel();setPartial('');setInput('');append('user',text);
    if(intent.kind==='confirm'&&confidence!==undefined&&confidence<0.8){deliver({text:'Подтверждение распознано неуверенно. Повторите «Подтверждаю печать» или нажмите кнопку подтверждения.'});return;}
    busyRef.current=true;setBusy(true);
    try{deliver(await assistant.current!.handle(text))}finally{if(mounted.current){busyRef.current=false;setBusy(false)}}
  };
  submitRef.current=execute;
  useEffect(()=>{
    mounted.current=true;
    const client=(id:string)=>{const value=latest.current.clients.get(id);if(!value)throw new Error('Нет соединения с принтером');return value};
    assistant.current=new VoiceAssistant({
      printers:()=>latest.current.printers,canOperate:()=>latest.current.canOperate,client:id=>latest.current.clients.get(id),
      list:async scope=>(await localLibraryList(scope)).files,inventory:readFilamentInventory,
      validate:async(printer,candidate,signal)=>{const {analysis,sha256}=await analyzeLocalFile(candidate.scopeId,candidate.entry.path,signal);return{sha256,report:validateGCodeAnalysis(printer,candidate.entry.path,analysis)}},
      ready:async printer=>{
        if(!await client(printer.id).checkIdleReady())throw new Error('Принтер не подтвердил готовность. Проверьте его карточку');
      },
      upload:(printer,proposal,signal)=>client(printer.id).uploadLocalLibrary(proposal.candidate.entry.path,proposal.sha256,proposal.candidate.scopeId,undefined,signal),
      start:(printer,path,report)=>client(printer.id).start(path,printStartOptionsFromValidation(report)),
      check:async(printer,path)=>(await client(printer.id).checkPrintStart(path)).confirmed,
      audit:message=>audit('voice.validated_start',message),
    });
    microphone.current=new OfflineSpeechInput({state:setListening,partial:setPartial,text:(text,confidence)=>submitRef.current(text,confidence),error:text=>{if(mounted.current){setReply({text});append('assistant',text)}}});
    accurateMicrophone.current=new NeuralSpeechInput({state:setListening,partial:setPartial,text:(text,confidence)=>submitRef.current(text,confidence),error:text=>{if(mounted.current){setReply({text});append('assistant',text)}}});
    void secureInvoke<{synthesis:boolean}>('voice_tools_status').then(status=>{if(mounted.current)setVoiceAvailable(status.synthesis)}).catch(()=>{});
    return()=>{mounted.current=false;microphone.current?.dispose();accurateMicrophone.current?.dispose();assistant.current?.dispose();stopNeuralSpeech();speechSynthesis.cancel()};
  },[]);
  useEffect(()=>{if(!props.open){microphone.current?.cancel();accurateMicrophone.current?.cancel();assistant.current?.cancel();stopNeuralSpeech();speechSynthesis.cancel();setReply({text:greeting});setPartial('')}},[props.open]);
  useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight,behavior:'smooth'})},[messages,partial]);
  const choose=async(candidate:VoiceCandidate)=>{
    if(busyRef.current)return;busyRef.current=true;setBusy(true);microphone.current?.cancel();accurateMicrophone.current?.cancel();stopNeuralSpeech();speechSynthesis.cancel();
    try{deliver(await assistant.current!.choose(candidate))}finally{busyRef.current=false;if(mounted.current)setBusy(false)}
  };
  if(!props.open)return null;
  return <section className="kfVoicePanel" role="dialog" aria-label="Голосовой помощник" aria-modal="false" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();props.onClose()}}}>
    <header><div className="kfVoiceSymbol"><Mic/></div><div><h2>Помощник фермы</h2><span><i/>Работает без интернета</span></div><button type="button" aria-label="Закрыть помощника" onClick={props.onClose}><X/></button></header>
    <div className="kfVoiceMessages" ref={log} role="log" aria-live="polite">{messages.map(message=><div key={message.id} className={'kfVoiceMessage '+message.kind}>{message.text}</div>)}{partial&&<div className="kfVoicePartial">Слышу: {partial}</div>}</div>
    <div className="kfVoiceChoices">{reply.choices?.map((candidate,index)=><button key={`${candidate.scopeId}:${candidate.printerId}:${candidate.entry.path}`} disabled={busy} onClick={()=>choose(candidate)}><FileCode2/><span><b>{index+1}. {candidate.entry.path}</b><small>{candidate.printerName}</small></span></button>)}</div>
    {reply.proposal&&<div className="kfVoiceProposal"><b>{reply.proposal.candidate.entry.path}</b><span>{reply.proposal.candidate.printerName}</span><button className="primary" disabled={busy||!props.canOperate} onClick={()=>execute('Подтверждаю печать')}><Play/>Подтверждаю печать</button><button disabled={busy} onClick={()=>execute('Отмена')}>Отмена</button></div>}
    {reply.unconfirmed&&<button className="kfVoiceCheck" disabled={busy} onClick={()=>execute('Проверь запуск')}>Проверить запуск без повторной отправки</button>}
    <div className="kfVoiceSuggestions">{['Сколько осталось пластика?','Какие принтеры свободны?'].map(text=><button disabled={busy} key={text} onClick={()=>execute(text)}>{text}</button>)}</div>
    <form onSubmit={event=>{event.preventDefault();void execute(input)}}><input aria-label="Команда помощнику" value={input} maxLength={300} onChange={event=>setInput(event.target.value)} placeholder="Команда голосом или текстом…"/><button type="submit" disabled={busy||!input.trim()} aria-label="Отправить команду"><Send/></button><button type="button" className={listening==='listening'?'listening':''} disabled={busy||listening==='finishing'} aria-label={listening==='idle'?'Включить микрофон':'Завершить запись'} onClick={()=>{stopNeuralSpeech();if(listening==='idle'){if(reply.proposal)void microphone.current?.start(['подтверждаю печать','отмена']);else void accurateMicrophone.current?.start()}else{microphone.current?.finish();void accurateMicrophone.current?.finish()}}}>{listening==='loading'||listening==='finishing'?<LoaderCircle className="spin"/>:listening==='listening'?<MicOff/>:<Mic/>}</button></form>
    <footer><span>{busy?'Проверяю и выполняю…':listening==='loading'?'Подготавливаю микрофон…':listening==='listening'?'Слушаю одну команду…':listening==='finishing'?'Распознаю команду…':'Микрофон выключен'}</span><button aria-label={voice?'Выключить голосовые ответы':'Включить голосовые ответы'} aria-pressed={voice} onClick={()=>{setVoice(!voice);stopNeuralSpeech();speechSynthesis.cancel()}}>{voice?<Volume2/>:<VolumeX/>}</button></footer>
    <label className="kfVoiceHint">Голос: <select aria-label="Голос помощника" value={voiceId} onChange={event=>{stopNeuralSpeech();setVoiceId(event.target.value as NeuralVoice)}}><option value="kseniya">Ксения — русский, офлайн</option></select> <button type="button" disabled={busy||listening!=='idle'} onClick={()=>{void speakNeuralOffline('Привет! Рада тебя слышать. Помогу найти файл, проверить принтеры и узнать остатки пластика.',voiceId).catch(()=>setSpeechError('Речевой модуль не установлен.'))}}>Послушать</button></label>
    {(speechError||!voiceAvailable)&&<p className="kfVoiceHint">{speechError||'Для нейроголоса установите новую сборку с речевым модулем. Текстовые команды доступны.'}</p>}
  </section>;
}
