import type { PrinterModel } from '../types';
import type { FilamentInventory } from './filamentInventory';
import { materialSummary } from './filamentInventory';
import type { LocalLibraryEntry } from './native';
import type { GCodeValidation } from './gcodeValidation';
import { validateVoiceSemanticResult,semanticVoiceIntent,semanticDuplicatePrinters,semanticClarification,type VoiceSemanticInput,type VoiceSemanticIntent,type ResolvedVoiceIntent } from './voiceSemantic';
import type { VoiceLearnedNames } from './voiceLearnedNames';
import type { VoiceCatalog } from './voiceCatalog';
import type { VoiceTask, VoiceTaskDraft, VoiceTaskQueue } from './voiceTaskQueue';
import { localLibraryScopeId } from './localLibraryScope';
import { assertModelDependentOperationAllowed } from './modelSafety';
import { printStartDefinitelyNotSent, uncertainPrintStart } from './printStartConfirmation';
import { normalizeVoice,parseVoiceCommand,voiceFileMatches,voiceFileNearMatch,voicePrinterMatches,type VoiceIntent,type PrinterStatusFilter } from './voiceCommands';
import { executeVoicePrinterControl } from './voicePrinterControls';
import { voicePrinterForecast } from './voicePrinterForecast';

export type VoiceCandidate={scopeId:string;entry:LocalLibraryEntry;printerId:string;printerName:string};
export type VoiceProposal={candidate:VoiceCandidate;sha256:string;report:GCodeValidation;target:string;client:unknown;expiresAt:number;taskId?:string};
export type VoicePrinterChoice={id:string;name:string};
export type VoiceReply={text:string;choices?:VoiceCandidate[];printerChoices?:VoicePrinterChoice[];proposal?:VoiceProposal;unconfirmed?:boolean;clarification?:'file'|'printer'|'choice';learnedNameSaved?:boolean;plan?:VoiceTask[];matchReasons?:Record<string,string[]>;diagnosticOutcome?:'ok'|'needs-input'|'error'|'cancelled'};
type ProgressStage='semantic'|'search'|'validation'|'readiness'|'upload'|'launch'|'status';
// The native semantic worker answers within its own 120-second HTTP deadline.
// The frontend timeout only guards a lost IPC reply; it aborts the native call too.
const SEMANTIC_TIMEOUT_MS=150_000;
export interface VoiceAssistantDependencies{
  printers:()=>PrinterModel[];canOperate:()=>boolean;client:(id:string)=>unknown;
  list:(scope:string)=>Promise<LocalLibraryEntry[]>;inventory:()=>Promise<FilamentInventory>;
  validate:(printer:PrinterModel,candidate:VoiceCandidate,signal:AbortSignal)=>Promise<{sha256:string;report:GCodeValidation}>;
  ready:(printer:PrinterModel)=>Promise<void>;
  upload:(printer:PrinterModel,proposal:VoiceProposal,signal:AbortSignal)=>Promise<string>;
  start:(printer:PrinterModel,path:string,report:GCodeValidation)=>Promise<void>;
  check:(printer:PrinterModel,path:string)=>Promise<boolean>;
  interpret?:(input:VoiceSemanticInput,signal:AbortSignal)=>Promise<unknown>;
  openCamera?:(printerId:string)=>boolean|void;
  hasCamera?:(printer:PrinterModel)=>boolean;
  navigate?:(target:string,printerId?:string)=>boolean|void;
  taskHistory?:(printer:PrinterModel,path:string,dispatchedAt:number,signal:AbortSignal)=>Promise<boolean>;
  audit:(message:string)=>Promise<unknown>;
  learning?:VoiceLearnedNames;
  catalog?:VoiceCatalog;
  tasks?:VoiceTaskQueue;
  progress?:(event:{stage:ProgressStage;phase:'start'|'end'|'error'})=>void;
  now?:()=>number;
}
type RepeatFile={scopeId:string;path:string;sha256?:string};
type SearchRequest={query:string;hint:string;print:boolean;printerId?:string;excludePrinterId?:string;requireChoice?:boolean;afterPrint?:boolean;learnQueries:string[];repeat?:RepeatFile;repeatMissing?:true;plan?:{quantity:number;freeOnly:boolean;requestId:string}};
type Conversation={expiresAt:number;topic:'file'|'stock'|'printers';request?:SearchRequest;selected?:VoiceCandidate;selectedSha256?:string;printerId?:string;awaiting?:'file'|'printer'|'choice'};
const target=(p:PrinterModel)=>JSON.stringify([p.id,p.host,p.profile,p.modelSelection?.mode,p.modelSelection?.selectedPreset,p.modelSelection?.confirmationRequired,p.modelSelection?.pendingPreset]);
const grams=(n:number)=>`${Math.round(n).toLocaleString('ru-RU')} грамм`;
const fileEntry=(entry:LocalLibraryEntry)=>/\.(?:gcode|gco|g)$/i.test(entry.path);
const candidateKey=(c:VoiceCandidate)=>JSON.stringify([c.scopeId,c.printerId,c.entry.path]);
const singularCount=(value:number)=>value%10===1&&value%100!==11;
const printerCount=(value:number)=>`${value} ${singularCount(value)?'принтер':value%10>=2&&value%10<=4&&(value%100<12||value%100>14)?'принтера':'принтеров'}`;
const label=(value:string)=>value.split(/[\\/]/u).pop()!.replace(/\.(?:gcode|gco|g)$/iu,'');
const fileName=(value:string)=>value.split(/[\\/]/u).pop()!.normalize('NFKC').toLowerCase();
const CONVERSATION_MS=4*60_000;
type PrinterCommand=Extract<ResolvedVoiceIntent,{kind:'control'|'forecast'}>;
export class VoiceAssistant{
  private proposal?:VoiceProposal;
  private candidates:VoiceCandidate[]=[];
  private printerOptions:VoicePrinterChoice[]=[];
  private conversation?:Conversation;
  private semanticPrinterPending?:{intent:VoiceSemanticIntent;text:string;options:VoicePrinterChoice[]};
  private printerCommandPending?:{intent:PrinterCommand;options:VoicePrinterChoice[]};
  private flashPending?:{options:VoicePrinterChoice[]};
  private catalog=new Map<string,LocalLibraryEntry[]>();
  private hintRefresh?:Promise<string[]>;
  private hintOffset=0;
  private unresolved?:{printerId:string;path:string;target:string;client:unknown;taskId?:string};
  private controller?:AbortController;
  private busy=false;
  private disposed=false;
  private revision=0;
  private serial=0;
  constructor(private deps:VoiceAssistantDependencies){}
  private progress(stage:ProgressStage,phase:'start'|'end'|'error'){try{this.deps.progress?.({stage,phase})}catch{}}
  private async phase<T>(stage:ProgressStage,action:()=>Promise<T>):Promise<T>{
    this.progress(stage,'start');try{const result=await action();this.progress(stage,'end');return result}catch(error){this.progress(stage,'error');throw error}
  }
  private withSemanticTimeout<T>(call:()=>Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{const error=new Error('semantic-timeout');error.name='TimeoutError';reject(error)},SEMANTIC_TIMEOUT_MS)});
    return Promise.race([call(),timeout]).finally(()=>clearTimeout(timer));
  }
  private requestId(){return `${this.now()}-${++this.serial}-${Math.random().toString(36).slice(2,10)}`}
  private now(){return this.deps.now?.()??Date.now()}
  private touch(){if(this.conversation)this.conversation.expiresAt=this.now()+CONVERSATION_MS}
  private currentConversation(){
    if(this.conversation&&this.now()>this.conversation.expiresAt){this.conversation=undefined;this.proposal=undefined;this.candidates=[];this.printerOptions=[];this.semanticPrinterPending=undefined;this.printerCommandPending=undefined}
    return this.conversation;
  }
  private clearSemanticPrinterChoice(){
    if(!this.semanticPrinterPending&&!this.printerCommandPending&&!this.flashPending)return;
    this.semanticPrinterPending=undefined;this.printerCommandPending=undefined;this.flashPending=undefined;this.printerOptions=[];
    if(this.conversation?.awaiting==='printer')this.conversation.awaiting=undefined;
  }
  dispose(){this.disposed=true;this.cancel();this.catalog.clear()}
  cancel(){this.revision++;this.proposal=undefined;this.candidates=[];this.printerOptions=[];this.conversation=undefined;this.semanticPrinterPending=undefined;this.printerCommandPending=undefined;this.flashPending=undefined;this.controller?.abort()}
  private assertActive(revision:number){if(this.disposed||revision!==this.revision)throw new Error('Действие отменено')}
  private printer(id:string){const p=this.deps.printers().find(p=>p.id===id);if(!p)throw new Error('Принтер удалён. Выберите его заново');return p}
  private assertReady(p:PrinterModel){
    if(!this.deps.canOperate())throw new Error('Вашей учётной записи недоступен запуск печати');
    if(p.status.connectionState!=='online'||p.status.state!=='ready'||p.status.remoteControlSuspended)throw new Error(`${p.name} сейчас не готов к печати. Проверьте связь и состояние принтера`);
    assertModelDependentOperationAllowed(p);
    if(!this.deps.client(p.id))throw new Error('Связь с принтером ещё не установлена');
  }
  speechHints():string[]{
    const context=this.currentConversation(),names:string[]=this.deps.printers().map(p=>p.name);
    if(context?.selected)names.push(label(context.selected.entry.path));
    for(const c of this.candidates.slice(0,6))names.push(label(c.entry.path));
    const liveScopes=new Set(this.deps.printers().map(localLibraryScopeId));
    const catalogs=[...this.catalog.entries()].filter(([scope])=>liveScopes.has(scope)).map(([,entries])=>entries).map(entries=>entries.filter(fileEntry).slice().sort((a,b)=>(b.modified??0)-(a.modified??0)||a.path.localeCompare(b.path,'ru')));
    for(let round=0;round<16;round++)for(const files of catalogs){if(files.length)names.push(label(files[(this.hintOffset+round)%files.length].path))}
    this.hintOffset=(this.hintOffset+5)%10_000;
    const result:string[]=[],seen=new Set<string>();let chars=0,bytes=0;
    for(const raw of names){const name=raw.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim();const length=[...name].length,size=new TextEncoder().encode(name).length,key=normalizeVoice(name);
      if(!key||seen.has(key)||length>64||chars+length+(result.length?2:0)>512||bytes+size+(result.length?2:0)>1024)continue;
      seen.add(key);chars+=length+(result.length?2:0);bytes+=size+(result.length?2:0);result.push(name);if(result.length===16)break;
    }
    return result;
  }
  refreshSpeechHints():Promise<string[]>{
    if(this.disposed)return Promise.resolve([]);
    if(this.hintRefresh)return this.hintRefresh;
    const revision=this.revision,scopes=[...new Set(this.deps.printers().map(localLibraryScopeId))];
    for(const scope of this.catalog.keys())if(!scopes.includes(scope))this.catalog.delete(scope);
    const refresh=Promise.all(scopes.map(async scope=>{try{const files=await this.deps.list(scope);if(!this.disposed&&revision===this.revision)this.catalog.set(scope,files.filter(fileEntry))}catch{if(!this.disposed&&revision===this.revision)this.catalog.delete(scope)}}))
      .then(()=>this.disposed?[]:this.speechHints()).finally(()=>{if(this.hintRefresh===refresh)this.hintRefresh=undefined});
    this.hintRefresh=refresh;return refresh;
  }
  private semanticInput(text:string,context:Conversation|undefined):VoiceSemanticInput{
    const bounded=(value:string,limit=160)=>value.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,limit);
    const printers=this.deps.printers().filter(p=>p.id&&p.id.length<=128&&!/[\p{Cc}\p{Cf}]/u.test(p.id)).slice(0,32).map(p=>({id:p.id,name:bounded(p.name),preset:p.modelSelection?.selectedPreset??p.profile?.preset}));
    const ids=new Set(printers.map(p=>p.id));
    return{text:bounded(text,300),context:{...(context?{topic:context.topic,...(context.awaiting?{awaiting:context.awaiting}:{}),...(context.request?{request:{query:bounded(context.request.query,300),action:context.request.plan?'plan' as const:context.request.print?'print' as const:'find' as const}}:{}),...(context.selected?{selectedFile:{name:bounded(label(context.selected.entry.path))}}:{}),...(context.printerId&&ids.has(context.printerId)?{selectedPrinterId:context.printerId}:{})}:{}),printers,fileChoices:this.candidates.slice(0,8).map((c,index)=>({number:index+1,name:bounded(label(c.entry.path),96),printerId:c.printerId})).filter(c=>ids.has(c.printerId)),printerChoices:this.printerOptions.slice(0,8).map((p,index)=>({number:index+1,id:p.id,name:bounded(p.name,96)})).filter(p=>ids.has(p.id))}};
  }
  async handle(text:string):Promise<VoiceReply>{
    const context=this.currentConversation(),initial=parseVoiceCommand(text,this.deps.printers(),{awaiting:context?.awaiting});
    if(initial.kind==='cancel'){this.cancel();return{text:this.unresolved?'Действие отменено. Ранее отправленный запуск пока не подтверждён: проверьте его состояние.':'Действие отменено. Печать не запускаю',diagnosticOutcome:'cancelled'};}
    return this.run(async(revision,signal)=>{
      if(this.printerCommandPending&&initial.kind==='followup'&&!initial.query&&initial.printerHint){
        const matches=voicePrinterMatches(this.deps.printers(),initial.printerHint).filter(p=>this.printerCommandPending!.options.some(option=>option.id===p.id));
        if(matches.length===1)return this.selectPrinterCommand(matches[0].id,revision,signal);
        return{text:matches.length?'Под это название подходят несколько принтеров. Выбери карточку или назови её номер.':'Выбери принтер из списка или назови его точное имя.',printerChoices:this.printerCommandPending.options,clarification:'printer'};
      }
      if(this.flashPending&&initial.kind==='followup'&&!initial.query&&initial.printerHint){
        const matches=voicePrinterMatches(this.deps.printers(),initial.printerHint).filter(p=>this.flashPending!.options.some(option=>option.id===p.id));
        if(matches.length===1)return this.openFlashFor(matches[0].id,revision,signal);
        return{text:matches.length?'Под это название подходят несколько принтеров. Выбери карточку или назови её номер.':'Выбери принтер из списка или назови его точное имя.',printerChoices:this.flashPending.options,clarification:'printer'};
      }
      // An explicit file reference cannot be resolved without a current file or query.
      // Ask for that missing fact immediately, even while the local model is warming up.
      if(initial.kind==='followup'&&initial.usePreviousFile&&!initial.query&&!context?.selected&&!context?.request?.query)return this.dispatch(initial,context,revision,signal);
      // A printer answer to an exact repeat must retain its scoped path and hash.
      // Reinterpreting that answer as a new print request would lose those pins.
      if(initial.kind==='followup'&&context?.request?.repeat&&!initial.query&&(initial.printerHint||initial.usePreviousPrinter||initial.otherPrinter))return this.dispatch(initial,context,revision,signal);
      if(initial.kind==='followup'&&initial.query&&context?.awaiting==='file'&&context.request?.repeatMissing)return this.dispatch(initial,context,revision,signal);
      // Exact controls and already understood commands stay immediate. Open phrasing and
      // ambiguous dialogue answers use the actual local interpreter, never a phrase-list simulation.
      if(this.deps.interpret&&(initial.kind==='help'||initial.kind==='followup')){
        const input=this.semanticInput(text,context);let output:unknown;
        this.progress('semantic','start');
        try{output=await this.withSemanticTimeout(()=>this.deps.interpret!(input,signal))}
        catch(error){
          this.progress('semantic','error');
          this.assertActive(revision);this.proposal=undefined;this.clearSemanticPrinterChoice();
          if(error instanceof Error&&error.name==='TimeoutError'){
            // Abort the native call so its worker slot is released for the next command.
            try{this.controller?.abort()}catch{}
            return{text:'Понимание свободной речи думает слишком долго на этом компьютере. Попробуй точную команду из подсказок внизу панели или повтори свой запрос чуть позже.',diagnosticOutcome:'error'};
          }
          return{text:semanticClarification(text,'unavailable'),diagnosticOutcome:'error'};
        }
        this.progress('semantic','end');
        this.assertActive(revision);let semantic;
        try{semantic=validateVoiceSemanticResult(output,input)}catch{
          this.proposal=undefined;this.clearSemanticPrinterChoice();return{text:semanticClarification(text,'invalid'),diagnosticOutcome:'needs-input'};
        }
        if(semantic.kind==='clarify'){this.proposal=undefined;this.clearSemanticPrinterChoice();return{text:semanticClarification(text,semantic.reason),diagnosticOutcome:'needs-input'};}
        const duplicates=semanticDuplicatePrinters(semantic,input);
        if(duplicates.length){
          this.clearSemanticPrinterChoice();
          this.proposal=undefined;this.semanticPrinterPending={intent:semantic,text,options:duplicates};this.printerOptions=duplicates;
          this.conversation={...(context??{topic:'printers'}),expiresAt:this.now()+CONVERSATION_MS,awaiting:'printer'};
          return{text:'У нескольких карточек одинаковое имя. Какой принтер ты имеешь в виду? Выбери карточку или назови её номер.',printerChoices:duplicates,clarification:'printer'};
        }
        return this.dispatch(semanticVoiceIntent(semantic,text),this.currentConversation(),revision,signal);
      }
      return this.dispatch(initial,context,revision,signal);
    });
  }
  private async selectSemanticPrinter(printerId:string,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    const pending=this.semanticPrinterPending;
    if(!pending||!pending.options.some(p=>p.id===printerId))throw new Error('Список принтеров устарел. Повтори запрос');
    this.printer(printerId);this.semanticPrinterPending=undefined;this.printerOptions=[];
    if(this.conversation)this.conversation.awaiting=undefined;
    return this.dispatch({...semanticVoiceIntent(pending.intent,pending.text),printerId},this.currentConversation(),revision,signal);
  }
  private async dispatch(intent:ResolvedVoiceIntent,context:Conversation|undefined,revision:number,signal:AbortSignal):Promise<VoiceReply>{
      if(intent.kind==='confirm'){this.clearSemanticPrinterChoice();return this.confirmPrint(revision,signal)}
      if(intent.kind==='check'){this.clearSemanticPrinterChoice();return this.check(revision,signal)}
      if(intent.kind==='choose'){
        if(this.printerCommandPending){const p=this.printerCommandPending.options[intent.index];if(!p)throw new Error('Такого варианта нет. Назови номер принтера из списка');return this.selectPrinterCommand(p.id,revision,signal)}
        if(this.flashPending){const p=this.flashPending.options[intent.index];if(!p)throw new Error('Такого варианта нет. Назови номер принтера из списка');return this.openFlashFor(p.id,revision,signal)}
        if(this.semanticPrinterPending){const p=this.semanticPrinterPending.options[intent.index];if(!p)throw new Error('Такого варианта нет. Назовите номер принтера из списка');return this.selectSemanticPrinter(p.id,revision,signal)}
        if(this.conversation?.awaiting==='printer'){const p=this.printerOptions[intent.index];if(!p)throw new Error('Такого варианта нет. Назовите номер принтера из списка');return this.selectPrinter(p.id,revision,signal)}
        const candidate=this.candidates[intent.index];if(!candidate)throw new Error('Такого варианта нет. Назовите номер из списка');return this.selectFile(candidate,revision,signal);
      }
      this.clearSemanticPrinterChoice();
      if(intent.kind==='control'||intent.kind==='forecast')return this.printerCommand(intent,context,revision,signal);
      if(intent.kind==='navigate')return this.navigateCommand(intent,context,revision,signal);
      if(intent.kind==='repeat')return this.repeatPrint(intent,revision,signal);
      if(intent.kind==='followup')return this.followup(intent,revision,signal);
      if(intent.kind==='stock'){
        this.candidates=[];this.printerOptions=[];
        const pending=this.proposal;if(!intent.afterPrint)this.proposal=undefined;
        const result=await this.stock(intent.query,!!intent.afterPrint,!!intent.usePreviousPrinter,revision,signal,intent.printerId);
        if(pending&&intent.afterPrint&&this.proposal===pending&&this.proposalCurrent(pending))return{...result,proposal:pending};
        this.proposal=undefined;return result;
      }
      this.proposal=undefined;
      if(intent.kind==='tasks'){
        this.candidates=[];this.printerOptions=[];this.conversation=undefined;
        const tasks=this.deps.tasks?.list().filter(t=>t.status!=='cancelled')??[];
        return{text:tasks.length?`В очереди помощника заданий: ${tasks.length}. Выберите задание, чтобы проверить файл и подготовить запуск.`:'Очередь помощника пуста. Например: «Нужно три держателя».',plan:tasks};
      }
      if(intent.kind==='printers'){
        this.candidates=[];this.printerOptions=[];
        this.conversation={...(context??{}),expiresAt:this.now()+CONVERSATION_MS,topic:'printers',awaiting:undefined,...(intent.printerId?{printerId:intent.printerId}:{})};
        return this.statuses(intent.filter,!!intent.countOnly,intent.printerId);
      }
      if(intent.kind==='find'||intent.kind==='print'||intent.kind==='plan')return this.fileCommand(intent,revision,signal);
      if(context?.awaiting==='file')return this.askFile();
      if(context?.awaiting==='printer'&&context.request)return this.askPrinter(context.request,this.printerPool(context.request));
      if(context?.awaiting==='choice')return{text:'Какой файл выбрать? Назовите номер варианта или уточните название.',choices:this.candidates,clarification:'choice'};
      this.candidates=[];this.printerOptions=[];
      return{text:'Что сделать: найти файл, подготовить печать или проверить принтеры?'};
  }
  async choose(candidate:VoiceCandidate){
    this.currentConversation();
    return this.run(async(revision,signal)=>{
      this.clearSemanticPrinterChoice();
      if(!this.candidates.includes(candidate))throw new Error('Результаты поиска устарели. Найдите файл заново');
      return this.selectFile(candidate,revision,signal);
    });
  }
  async choosePrinter(printerId:string){
    this.currentConversation();
    return this.run(async(revision,signal)=>{
      if(this.printerCommandPending)return this.selectPrinterCommand(printerId,revision,signal);
      if(this.flashPending)return this.openFlashFor(printerId,revision,signal);
      if(this.semanticPrinterPending)return this.selectSemanticPrinter(printerId,revision,signal);
      if(this.conversation?.awaiting!=='printer'||!this.printerOptions.some(p=>p.id===printerId))throw new Error('Список принтеров устарел. Назовите принтер заново');
      return this.selectPrinter(printerId,revision,signal);
    });
  }
  private async selectPrinterCommand(printerId:string,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    const pending=this.printerCommandPending;
    if(!pending||!pending.options.some(p=>p.id===printerId))throw new Error('Список принтеров устарел. Повтори команду');
    this.printer(printerId);this.printerCommandPending=undefined;this.printerOptions=[];
    const {usePreviousPrinter:_,...intent}=pending.intent;
    return this.printerCommand({...intent,printerHint:'',printerId},this.currentConversation(),revision,signal);
  }
  private async printerCommand(intent:PrinterCommand,context:Conversation|undefined,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    this.proposal=undefined;this.candidates=[];this.printerOptions=[];this.printerCommandPending=undefined;
    const all=this.deps.printers();
    const fleetForecast=intent.kind==='forecast'&&(intent.mode==='first'||intent.mode==='after')&&!intent.printerId&&!intent.printerHint&&!intent.usePreviousPrinter;
    if(fleetForecast){
      this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'printers'};
      return{text:voicePrinterForecast(all,intent,this.now())};
    }
    const contextualId=intent.printerId??(!intent.printerHint?context?.printerId:undefined);
    const options=contextualId?all.filter(p=>p.id===contextualId):voicePrinterMatches(all,intent.printerHint);
    if(options.length!==1){
      const choices=(options.length?options:all).map(p=>({id:p.id,name:p.name}));
      this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'printers',awaiting:'printer'};
      this.printerOptions=choices;
      if(choices.length)this.printerCommandPending={intent,options:choices};
      return{text:!all.length?'В ферме пока нет принтеров.':options.length?'На каком принтере? Выбери карточку или назови её имя или номер.':'Такой принтер не найден. Выбери карточку или назови её точное имя.',printerChoices:choices,clarification:'printer'};
    }
    const printer=options[0];
    this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'printers',printerId:printer.id};
    if(intent.kind==='forecast')return{text:voicePrinterForecast([printer],intent,this.now())};
    const result=await this.phase('status',()=>executeVoicePrinterControl(printer,intent.action,{
      printers:this.deps.printers,client:this.deps.client,canOperate:this.deps.canOperate,
      assertActive:()=>this.assertActive(revision),openCamera:this.deps.openCamera,hasCamera:this.deps.hasCamera,
    },signal));
    this.assertActive(revision);
    return{text:result.text,diagnosticOutcome:result.confirmed?'ok':'needs-input'};
  }
  private navigateNames:Record<string,string>={dashboard:'панель',printers:'принтеры',tools:'инструменты',queue:'очередь',files:'производство',history:'историю',settings:'настройки',spools:'пластик',tv:'ТВ-экран',assistant:'помощник','camera-guard':'контроль камеры',flash:'Мою флешку'};
  private async navigateCommand(intent:Extract<ResolvedVoiceIntent,{kind:'navigate'}>,context:Conversation|undefined,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    this.assertActive(revision);
    if(intent.target==='flash')return this.openFlashIntent(intent,context,revision,signal);
    if(!this.deps.navigate)throw new Error('Открытие разделов сейчас недоступно. Выберите его на экране.');
    const opened=this.deps.navigate(intent.target);
    this.assertActive(revision);
    if(opened===false)throw new Error(`Раздел «${this.navigateNames[intent.target]??intent.target}» сейчас недоступен.`);
    this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'printers'};
    return{text:`Открыла ${this.navigateNames[intent.target]??'раздел'}.`,diagnosticOutcome:'ok'};
  }
  private async openFlashIntent(intent:Extract<ResolvedVoiceIntent,{kind:'navigate'}>,context:Conversation|undefined,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    const all=this.deps.printers();
    const contextualId=intent.printerId??(!intent.printerHint?context?.printerId:undefined)??(all.length===1?all[0].id:undefined);
    const options=contextualId?all.filter(p=>p.id===contextualId):voicePrinterMatches(all,intent.printerHint);
    if(options.length!==1){
      const choices=(options.length?options:all).map(p=>({id:p.id,name:p.name}));
      this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'printers',awaiting:'printer'};
      this.printerOptions=choices;
      if(choices.length)this.flashPending={options:choices};
      return{text:!all.length?'В ферме пока нет принтеров.':options.length?'На каком принтере открыть Мою флешку? Выбери карточку или назови её имя или номер.':'Такой принтер не найден. Выбери карточку или назови её точное имя.',printerChoices:choices,clarification:'printer'};
    }
    return this.openFlashFor(options[0].id,revision,signal);
  }
  private async openFlashFor(printerId:string,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    this.assertActive(revision);
    if(!this.flashPending?.options.some(p=>p.id===printerId)&&!this.deps.printers().some(p=>p.id===printerId))throw new Error('Список принтеров устарел. Повтори команду');
    const printer=this.printer(printerId);
    this.flashPending=undefined;this.printerOptions=[];
    if(this.conversation)this.conversation.awaiting=undefined;
    if(!this.deps.navigate)throw new Error('Открытие флешки сейчас недоступно. Откройте её в карточке принтера.');
    const opened=this.deps.navigate('flash',printer.id);
    this.assertActive(revision);
    if(opened===false)throw new Error(`Не удалось открыть Мою флешку принтера ${printer.name}. Откройте её в карточке принтера.`);
    this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'printers',printerId:printer.id};
    return{text:`Открыла Мою флешку принтера ${printer.name}.`,diagnosticOutcome:'ok'};
  }
  /** Resuming a saved task always re-reads the exact scoped file and validates it again. */
  async prepareTask(id:string):Promise<VoiceReply>{
    return this.run(async(revision,signal)=>{
      this.clearSemanticPrinterChoice();
      this.proposal=undefined;this.candidates=[];this.printerOptions=[];
      const task=this.deps.tasks?.get(id);if(!task)throw new Error('Задание не найдено');
      if(!['draft','prepared','failed'].includes(task.status))throw new Error('Это задание уже отправлялось. Сначала проверьте его состояние');
      const p=this.printer(task.printerId);this.assertReady(p);
      if(localLibraryScopeId(p)!==task.scopeId||task.target&&target(p)!==task.target)throw new Error('Модель или адрес принтера изменились. Составьте план заново');
      const files=await this.phase('search',()=>this.deps.list(task.scopeId));this.assertActive(revision);
      this.catalog.set(task.scopeId,files.filter(fileEntry));this.deps.catalog?.observe(task.scopeId,files);
      const entry=files.find(entry=>entry.path===task.path);if(!entry)throw new Error('Файл задания удалён из библиотеки. Составьте план заново');
      this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'file',printerId:p.id};
      const result=await this.prepare({scopeId:task.scopeId,entry,printerId:p.id,printerName:p.name},revision,signal);
      if(!result.proposal)return result;
      if(task.sha256&&task.sha256!==result.proposal.sha256){this.proposal=undefined;throw new Error('Содержимое файла изменилось после составления плана. Составьте план заново');}
      const saved=this.deps.tasks!.setStatus(id,'prepared',{sha256:result.proposal.sha256,target:result.proposal.target});
      if(!saved.ok){this.proposal=undefined;throw new Error(saved.error||'Не удалось сохранить подготовку задания');}
      result.proposal.taskId=id;
      return{...result,text:`Задание ${task.copy}: ${result.text}`};
    });
  }
  async checkTask(id:string):Promise<VoiceReply>{
    return this.run((revision,signal)=>{this.clearSemanticPrinterChoice();return this.resolveTask(id,revision,signal)});
  }
  private async resolveTask(id:string,revision:number,signal:AbortSignal):Promise<VoiceReply>{
      const task=this.deps.tasks?.get(id);if(!task||!['needs-check','awaiting-confirmation','sending'].includes(task.status)||!task.remotePath)throw new Error('Нет отправленного файла для проверки. Откройте карточку принтера');
      const p=this.printer(task.printerId),client=this.deps.client(p.id);
      if(target(p)!==task.target||localLibraryScopeId(p)!==task.scopeId)throw new Error('Адрес или модель принтера изменились. Проверьте задание в его карточке');
      let confirmed=await this.phase('status',()=>this.deps.check(p,task.remotePath!)),historical=false;this.assertActive(revision);
      if(!confirmed&&task.dispatchedAt!==undefined&&this.deps.taskHistory){
        historical=await this.phase('status',()=>this.deps.taskHistory!(p,task.remotePath!,task.dispatchedAt!,signal));confirmed=historical;this.assertActive(revision);
      }
      if(target(this.printer(p.id))!==task.target||this.deps.client(p.id)!==client)throw new Error('Соединение или настройки принтера изменились во время проверки');
      if(confirmed){
        const saved=this.deps.tasks!.reconcile(id,{confirmed:true,target:task.target,remotePath:task.remotePath});
        if(!saved.ok)throw new Error(saved.error||'Запуск подтверждён, но не удалось сохранить состояние задания');
        if(this.unresolved?.taskId===id)this.unresolved=undefined;
      }
      return{text:confirmed?historical?`${p.name}: история принтера подтвердила запуск файла «${task.path}» после отправки. Текущее состояние смотрите в карточке.`:`${p.name}: активный запуск файла «${task.path}» подтверждён.`:'Активный запуск этого файла пока не подтверждён. Проверьте историю и карточку принтера. Повторная команда не отправлялась.',unconfirmed:!confirmed};
  }
  private async run(action:(revision:number,signal:AbortSignal)=>Promise<VoiceReply>):Promise<VoiceReply>{
    if(this.disposed)return{text:'Помощник закрыт'};
    if(this.busy)return{text:'Предыдущее действие ещё выполняется. Повторный запуск не отправляю'};
    this.busy=true;this.controller=new AbortController();const revision=this.revision;
    try{const result=await action(revision,this.controller.signal);return{...result,diagnosticOutcome:result.diagnosticOutcome??(result.clarification||result.proposal||result.plan?.length?'needs-input':'ok')}}
    catch(error){this.proposal=undefined;return{text:error instanceof Error?error.message:String(error),unconfirmed:!!this.unresolved,diagnosticOutcome:'error'}}
    finally{this.busy=false;this.controller=undefined}
  }
  private statuses(filter:PrinterStatusFilter,countOnly:boolean,printerId?:string):VoiceReply{
    const printers=printerId?[this.printer(printerId)]:this.deps.printers(),free=printers.filter(p=>p.status.state==='ready'&&p.status.connectionState==='online'&&!p.status.remoteControlSuspended);
    const printing=printers.filter(p=>p.status.state==='printing'&&p.status.connectionState==='online');
    const freeReply=!free.length?'Свободных принтеров сейчас нет.':free.length===1?`Сейчас свободен один принтер: ${free[0].name}.`:`Сейчас свободны: ${free.map(p=>p.name).join(', ')}.`;
    const printingReply=!printing.length?'Сейчас ни один принтер не печатает.':printing.length===1?`Сейчас печатает: ${printing[0].name}.`:`Сейчас печатают: ${printing.map(p=>p.name).join(', ')}.`;
    if(countOnly)return{text:filter==='free'?!free.length?freeReply:`Сейчас ${singularCount(free.length)?'свободен':'свободны'} ${printerCount(free.length)}.`:filter==='printing'?!printing.length?printingReply:`Сейчас ${singularCount(printing.length)?'печатает':'печатают'} ${printerCount(printing.length)}.`:printers.length?`В ферме ${printerCount(printers.length)}.`:'В ферме пока нет принтеров.'};
    if(!printers.length)return{text:'В ферме пока нет принтеров'};
    if(printerId&&!countOnly){const p=printers[0],states:Record<PrinterModel['status']['state'],string>={ready:'свободен',printing:'печатает',paused:'на паузе',error:'ошибка',offline:'нет связи'};return{text:`${p.name}: ${p.status.connectionState!=='online'?'нет подтверждённой связи':p.status.remoteControlSuspended?'управление приостановлено':states[p.status.state]}.`};}
    if(filter==='free')return{text:freeReply};
    if(filter==='printing')return{text:printingReply};
    const states:Record<PrinterModel['status']['state'],string>={ready:'готов',printing:'печатает',paused:'на паузе',error:'ошибка',offline:'нет связи'};
    const others=printers.filter(p=>!free.includes(p)&&!printing.includes(p)).map(p=>`${p.name} — ${p.status.connectionState!=='online'?'нет подтвержденной связи':p.status.remoteControlSuspended?'управление приостановлено':states[p.status.state]}`);
    return{text:[freeReply,printingReply,...(others.length?[`Остальные принтеры: ${others.join('; ')}.`]:[])].join(' ')};
  }
  private async repeatPrint(intent:Extract<VoiceIntent,{kind:'repeat'}>&{printerId?:string},revision:number,signal:AbortSignal):Promise<VoiceReply>{
    const previous=this.currentConversation(),selected=intent.fromHistory?undefined:previous?.selected;
    // Only this profile's confirmed starts are historical evidence. Drafts,
    // uncertain deliveries and files merely mentioned in a search do not count.
    const last=this.deps.tasks?.list().filter(task=>task.status==='started').reverse().sort((a,b)=>(b.dispatchedAt??b.updatedAt)-(a.dispatchedAt??a.updatedAt))[0];
    const repeat:RepeatFile|undefined=selected?{scopeId:selected.scopeId,path:selected.entry.path,sha256:previous?.selectedSha256}:last?{scopeId:last.scopeId,path:last.path,sha256:last.sha256}:undefined;
    this.proposal=undefined;this.candidates=[];this.printerOptions=[];
    if(!repeat){
      const options=intent.printerId?[this.printer(intent.printerId)]:intent.printerHint?voicePrinterMatches(this.deps.printers(),intent.printerHint):[];
      const printerId=options.length===1?options[0].id:undefined;
      this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'file',awaiting:'file',printerId,request:{query:'',hint:intent.printerHint,print:true,printerId,learnQueries:[],repeatMissing:true}};
      return{text:'Пока не знаю, какую печать повторить. Выбери файл или назови его название.',clarification:'file'};
    }
    const previousPrinterId=selected?.printerId??last?.printerId;
    const printerId=intent.printerId??(!intent.printerHint&&!intent.otherPrinter?previousPrinterId:undefined);
    const request:SearchRequest={query:label(repeat.path),hint:intent.printerHint,print:true,printerId,learnQueries:[],repeat,...(intent.otherPrinter?{excludePrinterId:previousPrinterId}:{})};
    this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'file',request,printerId};
    const options=this.printerPool(request);
    if(!options.length)return this.askPrinter({...request,printerId:undefined,hint:''},this.deps.printers().filter(p=>p.id!==request.excludePrinterId));
    if(options.length!==1)return this.askPrinter(request,options);
    return this.find(request,revision,signal);
  }
  private askFile():VoiceReply{
    if(!this.conversation)this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'file'};
    this.conversation.awaiting='file';this.touch();
    return{text:'Какой файл нужно найти или напечатать? Назовите его название.',clarification:'file'};
  }
  private printerPool(request:SearchRequest){return this.deps.printers().filter(p=>p.id!==request.excludePrinterId&&(request.printerId?p.id===request.printerId:voicePrinterMatches([p],request.hint).length>0))}
  private askPrinter(request:SearchRequest,printers:PrinterModel[]):VoiceReply{
    this.conversation??={expiresAt:this.now()+CONVERSATION_MS,topic:'file'};
    this.conversation.request=request;this.conversation.awaiting='printer';this.touch();
    this.printerOptions=printers.map(p=>({id:p.id,name:p.name}));
    return{text:printers.length?`На каком принтере ${request.print?'печатать':'искать файл'}${request.query?' «'+label(request.query)+'»':''}? Назовите имя или номер.`:'Такой принтер не найден. Назовите точное имя его карточки.',printerChoices:this.printerOptions,choices:this.candidates,clarification:'printer'};
  }
  private async fileCommand(intent:Extract<VoiceIntent,{kind:'find'|'print'|'plan'}>&{printerId?:string},revision:number,signal:AbortSignal){
    const previous=this.currentConversation();let query=intent.query,hint=intent.printerHint,printerId=intent.printerId;
    if(printerId)this.printer(printerId);
    if(intent.usePreviousFile){query=previous?.selected?.entry.path??previous?.request?.query??'';}
    if(!printerId&&(intent.usePreviousPrinter||intent.kind!=='plan'&&intent.usePreviousFile&&!hint))printerId=previous?.printerId;
    const request:SearchRequest={query,hint,print:intent.kind==='print',printerId,learnQueries:query?[query]:[],...(intent.kind==='plan'?{requireChoice:true,plan:{quantity:intent.quantity,freeOnly:!!intent.freeOnly,requestId:this.requestId()}}:{}),...(intent.otherPrinter?{excludePrinterId:previous?.printerId}:{}),...(intent.usePreviousFile&&!previous?.selected?{requireChoice:true}:{})};
    this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'file',request,printerId};this.candidates=[];this.printerOptions=[];
    if(!query)return this.askFile();
    if(intent.usePreviousPrinter&&!printerId||intent.otherPrinter)return this.askPrinter(request,this.printerPool({...request,hint:''}));
    return this.find(request,revision,signal);
  }
  private async followup(intent:Extract<VoiceIntent,{kind:'followup'}>&{printerId?:string},revision:number,signal:AbortSignal):Promise<VoiceReply>{
    this.proposal=undefined;
    const context=this.currentConversation();
    if(context?.topic==='stock'&&!intent.query&&!intent.usePreviousFile&&!intent.otherPrinter){
      const hint=intent.printerHint;
      return this.stock(hint?'Сколько пластика на '+hint:'Сколько пластика?',false,!!intent.usePreviousPrinter,revision,signal,intent.printerId);
    }
    if(context?.topic==='printers'&&!intent.query&&!intent.usePreviousFile&&!intent.otherPrinter){
      const options=intent.printerId?[this.printer(intent.printerId)]:intent.printerHint?voicePrinterMatches(this.deps.printers(),intent.printerHint):this.deps.printers().filter(p=>p.id===context.printerId);
      if(options.length!==1)return{text:options.length?'Назовите точное имя карточки принтера.':'О каком принтере речь? Назовите его имя.'};
      const p=options[0];context.printerId=p.id;this.touch();
      const states:Record<PrinterModel['status']['state'],string>={ready:'свободен',printing:'печатает',paused:'на паузе',error:'ошибка',offline:'нет связи'};
      return{text:`${p.name}: ${p.status.connectionState!=='online'?'нет подтверждённой связи':p.status.remoteControlSuspended?'управление приостановлено':states[p.status.state]}.`};
    }
    const old=context?.request,selected=context?.selected;
    let query=intent.query??selected?.entry.path??old?.query??'',hint=intent.printerHint??old?.hint??'',printerId=intent.printerId??(intent.printerHint?undefined:context?.printerId);
    const changedScope=!!selected&&(intent.printerId?localLibraryScopeId(this.printer(intent.printerId))!==selected.scopeId:!!intent.printerHint&&voicePrinterMatches(this.deps.printers(),intent.printerHint).some(p=>localLibraryScopeId(p)!==selected.scopeId));
    if(intent.otherPrinter){hint='';printerId=undefined;}
    if(intent.usePreviousPrinter&&!context?.printerId)printerId=undefined;
    const request:SearchRequest={query,hint,print:old?.print??true,printerId,learnQueries:[...new Set([...(intent.query?(intent.correctPreviousQuery?old?.learnQueries??[]:[]):old?.learnQueries??[]),...(intent.query?[intent.query]:[])])].slice(-3),...(old?.afterPrint?{afterPrint:true}:{}),...(old?.repeat&&!intent.query?{repeat:old.repeat}:{}),...(old?.plan?{plan:old.plan,requireChoice:true}:{}),...(intent.otherPrinter?{excludePrinterId:context?.printerId}:{}),...(changedScope||intent.usePreviousFile&&!selected?{requireChoice:true}:{})};
    this.proposal=undefined;this.candidates=[];this.printerOptions=[];
    this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'file',request,printerId};
    if(!query)return this.askFile();
    if(intent.otherPrinter||intent.usePreviousPrinter&&!printerId)return this.askPrinter(request,this.printerPool({...request,hint:''}));
    return this.find(request,revision,signal);
  }
  private async selectPrinter(printerId:string,revision:number,signal:AbortSignal){
    const request=this.conversation?.request;if(!request)throw new Error('Сначала назовите файл');
    this.printer(printerId);this.proposal=undefined;this.candidates=[];this.printerOptions=[];
    const next={...request,hint:'',printerId};this.conversation!.request=next;this.conversation!.printerId=printerId;this.conversation!.awaiting=undefined;this.touch();
    return next.query?this.find(next,revision,signal):this.askFile();
  }
  private async selectFile(candidate:VoiceCandidate,revision:number,signal:AbortSignal){
    this.proposal=undefined;
    const request=this.conversation?.request,paths=(this.catalog.get(candidate.scopeId)??[]).map(e=>e.path);
    let result:VoiceReply;
    if(request?.plan)result=await this.createPlan(candidate,request,revision,signal);
    else if(request?.afterPrint){this.conversation!.selected=candidate;this.conversation!.selectedSha256=undefined;this.conversation!.printerId=candidate.printerId;this.conversation!.awaiting=undefined;this.candidates=[];result=await this.stock('Сколько пластика?',true,true,revision,signal)}
    else result=await this.prepare(candidate,revision,signal,request?.repeat?.scopeId===candidate.scopeId?request.repeat.sha256:undefined);
    this.assertActive(revision);
    let saved=false;
    if(this.deps.learning)for(const query of request?.learnQueries??[]){
      if(!voiceFileMatches(candidate.entry.path,query))saved=this.deps.learning.learnConfirmed(query,candidate.scopeId,candidate.entry.path,paths).saved||saved;
    }
    return saved?{...result,text:result.text+' Запомнила, как вы называете этот файл.',learnedNameSaved:true}:result;
  }
  private async createPlan(candidate:VoiceCandidate,request:SearchRequest,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    if(!this.deps.canOperate())throw new Error('Вашей учётной записи недоступна подготовка печати');
    if(!this.deps.tasks||!request.plan)throw new Error('Очередь помощника недоступна');
    const currentFiles=await this.phase('search',()=>this.deps.list(candidate.scopeId));this.assertActive(revision);
    this.catalog.set(candidate.scopeId,currentFiles.filter(fileEntry));this.deps.catalog?.observe(candidate.scopeId,currentFiles);
    const entry=currentFiles.find(e=>e.path===candidate.entry.path);if(!entry)throw new Error('Выбранный файл удалён. Повторите поиск');
    const targets=this.printerPool(request).filter(p=>localLibraryScopeId(p)===candidate.scopeId&&p.status.connectionState==='online'&&['ready','printing'].includes(p.status.state)&&!p.status.remoteControlSuspended&&(!request.plan!.freeOnly||p.status.state==='ready'));
    const eligible:Array<{p:PrinterModel;sha256:string;fingerprint:string}>=[],excluded:string[]=[];
    for(const p of targets){
      this.assertActive(revision);const fingerprint=target(p);
      try{
        assertModelDependentOperationAllowed(p);
        const {report,sha256}=await this.phase('validation',()=>this.deps.validate(p,{...candidate,entry,printerId:p.id,printerName:p.name},signal));this.assertActive(revision);
        if(!report.ok||target(this.printer(p.id))!==fingerprint){excluded.push(p.name);continue;}
        eligible.push({p,sha256,fingerprint});
      }catch(error){this.assertActive(revision);if(signal.aborted)throw error;excluded.push(p.name);}
    }
    if(!eligible.length)throw new Error(request.plan.freeOnly?'Для выбранного G-code сейчас нет свободного принтера, прошедшего проверку.':'Для выбранного G-code нет доступного принтера, прошедшего проверку.');
    // A selected scope is a compatibility boundary. Never substitute a similarly named model-specific file.
    const livePrinters=this.deps.printers();
    if(new Set(eligible.map(e=>e.sha256)).size>1)throw new Error('Файл изменился во время составления плана. Повторите поиск');
    const live=eligible.flatMap(e=>{const p=livePrinters.find(p=>p.id===e.p.id);return p&&target(p)===e.fingerprint&&p.status.connectionState==='online'&&['ready','printing'].includes(p.status.state)&&!p.status.remoteControlSuspended&&(!request.plan!.freeOnly||p.status.state==='ready')?[{...e,p}]:[]});
    if(!live.length)throw new Error('Состояние принтеров изменилось. Составьте план заново');
    live.sort((a,b)=>Number(b.p.status.state==='ready')-Number(a.p.status.state==='ready')||a.p.name.localeCompare(b.p.name,'ru'));
    const drafts:VoiceTaskDraft[]=[];
    for(let i=0;i<request.plan.quantity;i++){
      const selected=live[i%live.length];drafts.push({query:request.query,scopeId:candidate.scopeId,path:entry.path,printerId:selected.p.id,printerName:selected.p.name,sha256:selected.sha256,target:selected.fingerprint});
    }
    const result=this.deps.tasks.addPlan(drafts,request.plan.requestId);if(!result.ok)throw new Error(result.error||'Не удалось сохранить план');
    this.candidates=[];this.printerOptions=[];this.proposal=undefined;
    if(this.conversation){this.conversation.selected={...candidate,entry};this.conversation.awaiting=undefined;this.touch()}
    const distribution=live.map(({p})=>`${p.name}: ${drafts.filter(d=>d.printerId===p.id).length}`).filter((_,i)=>drafts.some(d=>d.printerId===live[i].p.id)).join(', ');
    return{text:`План сохранён: ${request.plan.quantity} запусков файла «${entry.path}». ${distribution}. Каждый запуск проверяется и подтверждается отдельно. Количество деталей внутри G-code не меняется.${excluded.length?' Не прошли проверку: '+excluded.join(', ')+'.':''}`,plan:result.tasks};
  }
  private async find(request:SearchRequest,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    const {query}=request;if(!query)return this.askFile();
    const printers=this.printerPool(request);
    if(!printers.length){const reply=this.askPrinter({...request,printerId:undefined,hint:''},this.deps.printers().filter(p=>p.id!==request.excludePrinterId));return{...reply,text:'Такой принтер не найден. '+reply.text};}
    const scopes=new Map<string,PrinterModel[]>();
    for(const p of printers){const scope=localLibraryScopeId(p);scopes.set(scope,[...(scopes.get(scope)??[]),p])}
    const choices:VoiceCandidate[]=[],nearby:VoiceCandidate[]=[],learned:VoiceCandidate[]=[],semantic:VoiceCandidate[]=[];
    const matchReasons:Record<string,string[]>={},notices=new Set<string>();let failures=0,historyRequested=false;
    for(const [scope,targets] of scopes){
      this.assertActive(revision);if(signal.aborted)throw new Error('Поиск отменён');
      try{
        const files=(await this.phase('search',()=>this.deps.list(scope))).filter(fileEntry);this.catalog.set(scope,files);
        const current:VoiceCandidate[]=[];
        for(const entry of files){const repeat=request.repeat;
          const repeatMatches=repeat&&(scope===repeat.scopeId?entry.path===repeat.path:fileName(entry.path)===fileName(repeat.path));
          const list=repeat?repeatMatches?choices:undefined:voiceFileMatches(entry.path,query)?choices:voiceFileNearMatch(entry.path,query)?nearby:undefined;
          for(const p of targets){const candidate={scopeId:scope,entry,printerId:p.id,printerName:p.name};current.push(candidate);if(list)list.push(candidate)}
        }
        if(this.deps.learning&&!request.repeat)learned.push(...this.deps.learning.lookup(query,scope,current).candidates);
        if(this.deps.catalog&&!request.repeat){
          const result=this.deps.catalog.search(query,scope,current,this.now());historyRequested||=result.historyRequested;
          for(const match of result.matches){semantic.push(match.candidate);matchReasons[candidateKey(match.candidate)]=match.reasons;}
          for(const notice of result.notices)notices.add(notice);
        }
      }catch{failures++}
    }
    this.assertActive(revision);
    const suggestions:VoiceCandidate[]=[],known=new Set<string>();
    // A dated request is constrained by real history, never by an incidental filename token.
    const ranked=historyRequested?semantic:[...learned,...choices,...semantic,...(!choices.length?nearby:[])];
    for(const c of ranked){const key=request.plan?JSON.stringify([c.scopeId,c.entry.path]):candidateKey(c);if(!known.has(key)){known.add(key);suggestions.push(c)}}
    this.candidates=suggestions.slice(0,40);this.printerOptions=[];
    this.conversation??={expiresAt:this.now()+CONVERSATION_MS,topic:'file'};
    this.conversation.request=request;this.conversation.awaiting='choice';this.touch();
    if(printers.length===1)this.conversation.printerId=printers[0].id;
    if(failures)return{text:'Часть библиотеки недоступна. Повторите поиск после проверки хранилища; автоматический выбор отключён.',choices:this.candidates,clarification:'choice'};
    if(!suggestions.length){this.conversation.awaiting='file';return{text:request.repeat?'В библиотеке этого принтера нет прежнего файла «'+label(request.repeat.path)+'». Назови другой файл или добавь подходящий G-code.':[...notices,'В «Моей флешке» такого файла не нашла. Как он называется? Можно назвать часть имени.'].join(' '),choices:[],clarification:'file'};}
    if(request.print&&printers.length>1)return this.askPrinter(request,printers);
    if(request.print&&choices.length===1&&!learned.length&&!historyRequested&&!request.requireChoice&&(!request.repeat||request.repeat.scopeId===choices[0].scopeId))return this.prepare(choices[0],revision,signal,request.repeat?.sha256);
    const more=suggestions.length>40?' Показаны первые 40: уточните название.':'';
    if(request.plan)return{text:`Сначала выберите G-code для плана из ${request.plan.quantity} запусков. Затем проверю подходящие принтеры. Количество деталей внутри файла не изменяется.${more}`,choices:this.candidates,clarification:'choice',matchReasons};
    if(learned.length)return{text:'Нашла варианты по запомненному названию. Какой выбрать?'+more,choices:this.candidates,clarification:'choice',matchReasons};
    if(semantic.length&&(!choices.length||historyRequested))return{text:'Нашла варианты по описанию, тегам или истории запусков. Какой файл нужен?'+more,choices:this.candidates,clarification:'choice',matchReasons};
    if(!choices.length&&nearby.length)return{text:'Точного совпадения нет. Какой из похожих файлов нужен? Выберите файл или назовите номер.'+more,choices:this.candidates,clarification:'choice'};
    return{text:`Найдено вариантов: ${suggestions.length}. Какой файл выбрать? Назовите номер или уточните название.${more}`,choices:this.candidates,clarification:'choice'};
  }
  private async stock(query:string,afterPrint:boolean,usePreviousPrinter:boolean,revision:number,signal:AbortSignal,printerId?:string):Promise<VoiceReply>{
    const previous=this.currentConversation(),selected=previous?.selected;
    const printerQuery=query.replace(/(?:^|\s)у\s+(?:меня|нас)(?=\s|$)/gu,' ').replace(afterPrint?/после\s+(?:(?:этой|текущей)\s+печати|(?:этого|текущего)\s+файла|печати)/gu:/(?!)/u,' ').replace(/\s+/gu,' ').trim();
    const rawHint=printerQuery.match(/(?:^|\s)(?:на|у)\s+(?:принтер(?:е|а)?\s+)?(.+)$/u)?.[1];
    const hint=usePreviousPrinter&&rawHint&&/^(?:этом|том(?: же)?|нем|нём|него)(?: принтере)?$/u.test(rawHint)?undefined:rawHint;
    let printers=printerId?[this.printer(printerId)]:hint?voicePrinterMatches(this.deps.printers(),hint):undefined;
    const previousPrinter=printerId??(usePreviousPrinter?previous?.printerId:afterPrint?selected?.printerId:undefined);
    if(!hint&&previousPrinter)printers=this.deps.printers().filter(p=>p.id===previousPrinter);
    if(afterPrint&&!selected){this.candidates=[];this.printerOptions=[];this.conversation={expiresAt:this.now()+CONVERSATION_MS,topic:'file',printerId:previousPrinter,request:{query:'',hint:hint??'',printerId:previousPrinter,print:false,afterPrint:true,learnQueries:[]}};return this.askFile();}
    if(usePreviousPrinter&&!hint&&!previousPrinter)return{text:'О каком принтере речь? Назовите его имя.'};
    this.conversation={...(previous??{}),expiresAt:this.now()+CONVERSATION_MS,topic:'stock',awaiting:undefined};
    if(printers&&printers.length!==1)return{text:printers.length?'Под это название подходят несколько принтеров. Назовите точное имя карточки.':'Такой принтер не найден. Назовите имя его карточки.'};
    const state=await this.deps.inventory();this.assertActive(revision);
    const p=printers?.[0];if(p)this.conversation.printerId=p.id;
    if(afterPrint){
      if(!selected)return{text:'Какой файл учитывать? Сначала найдите и выберите его.'};
      const printer=p??this.deps.printers().find(p=>p.id===selected.printerId);
      if(!printer||localLibraryScopeId(printer)!==selected.scopeId)return{text:'Для этого принтера сначала выберите файл из его библиотеки.'};
      const {report,sha256}=await this.phase('validation',()=>this.deps.validate(printer,{...selected,printerId:printer.id,printerName:printer.name},signal));this.assertActive(revision);
      if(this.proposal&&this.proposal.sha256!==sha256)this.proposal=undefined;
      const weight=report.metadata?.filament_weight_total;
      if(!report.ok)return{text:'Файл не прошёл проверку для этого принтера. Выберите подходящий файл.'};
      this.conversation.selectedSha256=sha256;
      if(typeof weight!=='number'||!Number.isFinite(weight)||weight<=0)return{text:'В этом G-code нет однозначной оценки веса пластика. Остаток после печати пока неизвестен.'};
      const binding=state.printers[printer.id]?.binding,spool=state.spools.find(s=>s.id===binding?.spoolId);
      if(!spool)return{text:`${printer.name}: привяжите катушку, чтобы рассчитать остаток после печати.`};
      const material=report.metadata?.filament_type;
      if(material&&normalizeVoice(material)!==normalizeVoice(spool.material))return{text:`Материал файла ${material} отличается от материала катушки ${spool.material}. Уточните катушку.`};
      const remaining=spool.remainingWeight-weight;
      return{text:remaining>=0?`${printer.name}: файл потребует примерно ${grams(weight)}. После печати на катушке останется около ${grams(remaining)} по учёту программы.`:`${printer.name}: на файл нужно примерно ${grams(weight)}, на катушке ${grams(spool.remainingWeight)}. Не хватает около ${grams(-remaining)}.`};
    }
    if(p){const binding=state.printers[p.id]?.binding,spool=state.spools.find(s=>s.id===binding?.spoolId);return{text:spool?`${p.name}: на катушке ${spool.material} осталось ${grams(spool.remainingWeight)} по учёту программы.`:`${p.name}: катушка не привязана, её остаток неизвестен.`};}
    const materials=materialSummary(state),material=materials.find(m=>normalizeVoice(query).split(' ').includes(normalizeVoice(m.material)));
    if(material)return{text:`${material.material}: осталось ${grams(material.totalGrams)} по учёту программы.`};
    return{text:`Общий запас пластика: ${grams(materials.reduce((s,m)=>s+m.totalGrams,0))}. ${materials.filter(m=>m.totalGrams>0).map(m=>`${m.material}: ${grams(m.totalGrams)}`).join('. ')}. Данные учёта программы.`};
  }
  private proposalCurrent(proposal:VoiceProposal){
    const p=this.deps.printers().find(p=>p.id===proposal.candidate.printerId);
    return !!p&&this.deps.canOperate()&&this.now()<=proposal.expiresAt&&this.conversation?.printerId===p.id&&target(p)===proposal.target&&this.deps.client(p.id)===proposal.client&&p.status.state==='ready'&&p.status.connectionState==='online'&&!p.status.remoteControlSuspended;
  }
  private async prepare(candidate:VoiceCandidate,revision:number,signal:AbortSignal,expectedSha256?:string):Promise<VoiceReply>{
    if(this.unresolved)throw new Error('Предыдущий запуск ещё не подтверждён. Скажите «Проверь запуск»');
    const p=this.printer(candidate.printerId);this.assertReady(p);
    if(this.deps.tasks?.list().some(t=>t.printerId===p.id&&['awaiting-confirmation','needs-check'].includes(t.status)))throw new Error('На этом принтере есть запуск с неизвестным результатом. Сначала проверьте задание в очереди помощника');
    if(localLibraryScopeId(p)!==candidate.scopeId)throw new Error('Библиотека принтера изменилась. Повторите поиск');
    const fingerprint=target(p),client=this.deps.client(p.id);
    const {sha256,report}=await this.phase('validation',()=>this.deps.validate(p,candidate,signal));
    this.assertActive(revision);
    if(expectedSha256&&sha256!==expectedSha256)throw new Error('Содержимое прежнего файла изменилось. Выбери файл заново, чтобы проверить новую версию.');
    if(target(this.printer(p.id))!==fingerprint||client!==this.deps.client(p.id))throw new Error('Настройки или соединение принтера изменились. Повторите поиск');
    if(!report.ok)return{text:`Файл не прошёл проверку: ${report.issues.filter(i=>i.level==='error').map(i=>i.message).join('. ')}`,diagnosticOutcome:'error'};
    this.assertReady(this.printer(p.id));
    this.proposal={candidate,sha256,report,target:fingerprint,client,expiresAt:this.now()+90_000};
    if(this.conversation){this.conversation.selected=candidate;this.conversation.selectedSha256=sha256;this.conversation.printerId=p.id;this.conversation.awaiting=undefined;this.touch()}
    this.printerOptions=[];
    const warnings=report.issues.filter(i=>i.level==='warning').map(i=>i.message);
    return{text:`Файл «${candidate.entry.path}», принтер ${p.name}.${warnings.length?' Предупреждения: '+warnings.join('. ')+'.':''} Для запуска скажите: «Подтверждаю печать». Подтверждение действует 90 секунд.`,proposal:this.proposal};
  }
  private async confirmPrint(revision:number,signal:AbortSignal):Promise<VoiceReply>{
    const proposal=this.proposal;this.proposal=undefined;
    if(!proposal||this.now()>proposal.expiresAt)throw new Error('Нет действующего подтверждения. Сначала выберите файл и принтер заново');
    const validateTarget=()=>{
      this.assertActive(revision);const p=this.printer(proposal.candidate.printerId);this.assertReady(p);
      if(target(p)!==proposal.target||this.deps.client(p.id)!==proposal.client)throw new Error('Принтер или его настройки изменились. Проверьте файл заново');return p;
    };
    let p=validateTarget();await this.phase('readiness',()=>this.deps.ready(p));p=validateTarget();
    let taskId=proposal.taskId;
    const save=(status:Parameters<VoiceTaskQueue['setStatus']>[1],details?:Parameters<VoiceTaskQueue['setStatus']>[2])=>{
      if(!taskId||!this.deps.tasks)return;const saved=this.deps.tasks.setStatus(taskId,status,details);if(!saved.ok)throw new Error(saved.error||'Не удалось сохранить состояние задания');
    };
    if(this.deps.tasks){
      if(!taskId){
        const added=this.deps.tasks.addPlan([{query:proposal.candidate.entry.path.slice(0,300),scopeId:proposal.candidate.scopeId,path:proposal.candidate.entry.path,printerId:p.id,printerName:p.name,sha256:proposal.sha256,target:proposal.target}],this.requestId());
        if(!added.ok||!added.tasks.length)throw new Error(added.error||'Не удалось сохранить задание перед отправкой');taskId=added.tasks[0].id;
        save('prepared',{sha256:proposal.sha256,target:proposal.target});
      }
      const current=this.deps.tasks.get(taskId);
      if(!current||current.sha256!==proposal.sha256||current.target!==proposal.target||current.status!=='prepared')throw new Error('Подготовка задания устарела. Выберите его в очереди заново');
      save('sending');
    }
    let path:string;
    try{
      path=await this.phase('upload',()=>this.deps.upload(p,proposal,signal));
      p=validateTarget();await this.phase('readiness',()=>this.deps.ready(p));p=validateTarget();
      // Persist the uncertain boundary before sending the print command, including its exact remote path.
      save('awaiting-confirmation',{remotePath:path});
    }catch(error){if(taskId)this.deps.tasks?.setStatus(taskId,'failed',{error:(error instanceof Error?error.message:String(error)).slice(0,600)});throw error;}
    this.unresolved={printerId:p.id,path,target:proposal.target,client:proposal.client,taskId};
    try{await this.phase('launch',()=>this.deps.start(p,path,proposal.report))}
    catch(error){
      if(printStartDefinitelyNotSent(error)){
        if(taskId){const saved=this.deps.tasks?.setStatus(taskId,'failed',{confirmedNotStarted:true,error:error.message.slice(0,600)});if(!saved?.ok)throw new Error(saved?.error||'Команда не отправлялась, но не удалось сохранить результат. Проверьте очередь');}
        this.unresolved=undefined;throw error;
      }
      if(uncertainPrintStart(error)){
        if(taskId)this.deps.tasks?.setStatus(taskId,'needs-check',{error:(error instanceof Error?error.message:String(error)).slice(0,600)});
        return{text:'Команда отправлена, но запуск пока не подтверждён. Повторно не отправляю. Скажите «Проверь запуск».',unconfirmed:true,diagnosticOutcome:'needs-input'};
      }
      // Even a late transport error can follow delivery. A queued command is never automatically replayed.
      if(taskId)this.deps.tasks?.setStatus(taskId,'needs-check',{error:(error instanceof Error?error.message:String(error)).slice(0,600)});
      if(!taskId)this.unresolved=undefined;throw error;
    }
    try{save('started',{confirmed:true,remotePath:path})}catch(error){return{text:'Принтер подтвердил запуск, но состояние очереди не сохранилось. Проверьте задание перед дальнейшими действиями.',unconfirmed:true,diagnosticOutcome:'error'};}
    this.unresolved=undefined;this.deps.catalog?.recordPrinted(proposal.candidate.scopeId,proposal.candidate.entry.path,this.now());
    void this.deps.audit(`${proposal.candidate.entry.path} → ${path} → ${p.name}`).catch(()=>{});
    return{text:`Принтер ${p.name} подтвердил запуск файла «${proposal.candidate.entry.path}».`};
  }
  private async check(revision:number,signal:AbortSignal):Promise<VoiceReply>{
    const pending=this.unresolved;if(!pending){const tasks=this.deps.tasks?.list().filter(t=>['needs-check','sending','awaiting-confirmation'].includes(t.status))??[];return{text:tasks.length?'Есть отправленные задания с неизвестным результатом. Выберите «Проверить запуск» у задания в очереди помощника.':'Неподтверждённых запусков нет',...(tasks.length?{plan:tasks}:{})};}
    if(pending.taskId)return this.resolveTask(pending.taskId,revision,signal);
    const p=this.printer(pending.printerId);
    if(target(p)!==pending.target||this.deps.client(p.id)!==pending.client)throw new Error('Соединение или настройки изменились. Проверьте печать в карточке принтера');
    const confirmed=await this.phase('status',()=>this.deps.check(p,pending.path));
    if(confirmed){
      if(pending.taskId){const saved=this.deps.tasks?.reconcile(pending.taskId,{confirmed:true,target:pending.target,remotePath:pending.path});if(!saved?.ok)throw new Error(saved?.error||'Не удалось сохранить подтверждение запуска');}
      this.unresolved=undefined;
    }
    return{text:confirmed?`${p.name}: запуск файла «${pending.path}» подтверждён.`:'Принтер пока не подтвердил запуск. Повторная команда не отправлялась.',unconfirmed:!confirmed};
  }
}
