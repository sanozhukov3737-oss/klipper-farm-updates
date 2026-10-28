import type { PrinterModel } from '../types';
import type { FilamentInventory } from './filamentInventory';
import { materialSummary } from './filamentInventory';
import type { LocalLibraryEntry } from './native';
import type { GCodeValidation } from './gcodeValidation';
import { localLibraryScopeId } from './localLibraryScope';
import { assertModelDependentOperationAllowed } from './modelSafety';
import { uncertainPrintStart } from './printStartConfirmation';
import { normalizeVoice,parseVoiceCommand,voiceFileMatches,voiceFileNearMatch,voicePrinterMatches } from './voiceCommands';

export type VoiceCandidate={scopeId:string;entry:LocalLibraryEntry;printerId:string;printerName:string};
export type VoiceProposal={candidate:VoiceCandidate;sha256:string;report:GCodeValidation;target:string;client:unknown;expiresAt:number};
export type VoiceReply={text:string;choices?:VoiceCandidate[];proposal?:VoiceProposal;unconfirmed?:boolean};
export interface VoiceAssistantDependencies{
  printers:()=>PrinterModel[];canOperate:()=>boolean;client:(id:string)=>unknown;
  list:(scope:string)=>Promise<LocalLibraryEntry[]>;inventory:()=>Promise<FilamentInventory>;
  validate:(printer:PrinterModel,candidate:VoiceCandidate,signal:AbortSignal)=>Promise<{sha256:string;report:GCodeValidation}>;
  ready:(printer:PrinterModel)=>Promise<void>;
  upload:(printer:PrinterModel,proposal:VoiceProposal,signal:AbortSignal)=>Promise<string>;
  start:(printer:PrinterModel,path:string,report:GCodeValidation)=>Promise<void>;
  check:(printer:PrinterModel,path:string)=>Promise<boolean>;
  audit:(message:string)=>Promise<unknown>;
  now?:()=>number;
}
const target=(p:PrinterModel)=>JSON.stringify([p.id,p.host,p.profile,p.modelSelection?.mode,p.modelSelection?.selectedPreset,p.modelSelection?.confirmationRequired,p.modelSelection?.pendingPreset]);
const grams=(n:number)=>`${Math.round(n).toLocaleString('ru-RU')} грамм`;
export class VoiceAssistant{
  private proposal?:VoiceProposal;
  private candidates:VoiceCandidate[]=[];
  private unresolved?:{printerId:string;path:string;target:string;client:unknown};
  private controller?:AbortController;
  private busy=false;
  private disposed=false;
  private revision=0;
  constructor(private deps:VoiceAssistantDependencies){}
  private now(){return this.deps.now?.()??Date.now()}
  dispose(){this.disposed=true;this.cancel()}
  cancel(){this.revision++;this.proposal=undefined;this.candidates=[];this.controller?.abort()}
  private assertActive(revision:number){if(this.disposed||revision!==this.revision)throw new Error('Действие отменено')}
  private printer(id:string){const p=this.deps.printers().find(p=>p.id===id);if(!p)throw new Error('Принтер удалён. Выберите его заново');return p}
  private assertReady(p:PrinterModel){
    if(!this.deps.canOperate())throw new Error('Вашей учётной записи недоступен запуск печати');
    if(p.status.connectionState!=='online'||p.status.state!=='ready'||p.status.remoteControlSuspended)throw new Error(`${p.name} сейчас не готов к печати. Проверьте связь и состояние принтера`);
    assertModelDependentOperationAllowed(p);
    if(!this.deps.client(p.id))throw new Error('Связь с принтером ещё не установлена');
  }
  async handle(text:string):Promise<VoiceReply>{
    const intent=parseVoiceCommand(text);
    if(intent.kind==='cancel'){this.cancel();return{text:this.unresolved?'Действие отменено. Ранее отправленный запуск пока не подтверждён: проверьте его состояние.':'Действие отменено. Печать не запускаю'};}
    return this.run(async(revision,signal)=>{
      if(intent.kind==='confirm')return this.confirmPrint(revision,signal);
      if(intent.kind==='check')return this.check();
      if(intent.kind==='choose'){const candidate=this.candidates[intent.index];if(!candidate)throw new Error('Такого варианта нет. Назовите номер из списка');return this.prepare(candidate,revision,signal);}
      this.proposal=undefined;this.candidates=[];
      if(intent.kind==='stock')return this.stock(intent.query);
      if(intent.kind==='printers'){
        const printers=this.deps.printers(),free=printers.filter(p=>p.status.state==='ready'&&p.status.connectionState==='online'&&!p.status.remoteControlSuspended);
        const printing=printers.filter(p=>p.status.state==='printing'&&p.status.connectionState==='online');
        return{text:printers.length?`Свободны: ${free.map(p=>p.name).join(', ')||'нет'}. Печатают: ${printing.map(p=>p.name).join(', ')||'нет'}. Остальные: ${printers.length-free.length-printing.length}.`:'В ферме пока нет принтеров'};
      }
      if(intent.kind==='find'||intent.kind==='print')return this.find(intent.query,intent.printerHint,intent.kind==='print',revision,signal);
      return{text:'Скажите: «Найди корпус», «Напечатай корпус на K1 Max», «Сколько осталось пластика?» или «Какие принтеры свободны?». Для запуска скажите отдельно: «Подтверждаю печать».'};
    });
  }
  async choose(candidate:VoiceCandidate){
    return this.run(async(revision,signal)=>{
      if(!this.candidates.includes(candidate))throw new Error('Результаты поиска устарели. Найдите файл заново');
      return this.prepare(candidate,revision,signal);
    });
  }
  private async run(action:(revision:number,signal:AbortSignal)=>Promise<VoiceReply>):Promise<VoiceReply>{
    if(this.disposed)return{text:'Помощник закрыт'};
    if(this.busy)return{text:'Предыдущее действие ещё выполняется. Повторный запуск не отправляю'};
    this.busy=true;this.controller=new AbortController();const revision=this.revision;
    try{return await action(revision,this.controller.signal)}
    catch(error){return{text:error instanceof Error?error.message:String(error),unconfirmed:!!this.unresolved}}
    finally{this.busy=false;this.controller=undefined}
  }
  private async stock(query:string):Promise<VoiceReply>{
    const state=await this.deps.inventory();
    const hint=query.match(/(?:на|у)\s+(?:принтер(?:е|а)?\s+)?(.+)$/u)?.[1];
    if(hint){
      const printers=voicePrinterMatches(this.deps.printers(),hint);
      if(printers.length!==1)return{text:printers.length?'Под это название подходят несколько принтеров. Назовите точное имя карточки.':'Такой принтер не найден. Назовите имя его карточки.'};
      const p=printers[0],binding=state.printers[p.id]?.binding,spool=state.spools.find(s=>s.id===binding?.spoolId);
      return{text:spool?`${p.name}: на катушке ${spool.material} осталось ${grams(spool.remainingWeight)} по учёту программы.`:`${p.name}: катушка не привязана, её остаток неизвестен.`};
    }
    const materials=materialSummary(state),material=materials.find(m=>normalizeVoice(query).split(' ').includes(normalizeVoice(m.material)));
    if(material)return{text:`${material.material}: осталось ${grams(material.totalGrams)} по учёту программы.`};
    return{text:`Общий запас пластика: ${grams(materials.reduce((s,m)=>s+m.totalGrams,0))}. ${materials.filter(m=>m.totalGrams>0).map(m=>`${m.material}: ${grams(m.totalGrams)}`).join('. ')}. Данные учёта программы.`};
  }
  private async find(query:string,hint:string,print:boolean,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    if(!query)return{text:'Назовите файл, который нужно найти'};
    const printers=voicePrinterMatches(this.deps.printers(),hint);
    if(!printers.length)return{text:'Такой принтер не найден. Назовите точное имя его карточки'};
    const scopes=new Map<string,PrinterModel[]>();
    for(const p of printers){const scope=localLibraryScopeId(p);scopes.set(scope,[...(scopes.get(scope)??[]),p])}
    const choices:VoiceCandidate[]=[],nearby:VoiceCandidate[]=[];let failures=0;
    for(const [scope,targets] of scopes){
      this.assertActive(revision);if(signal.aborted)throw new Error('Поиск отменён');
      try{const files=await this.deps.list(scope);
        for(const entry of files)if(/\.(?:gcode|gco|g)$/i.test(entry.path)){
          const matches=voiceFileMatches(entry.path,query)?choices:voiceFileNearMatch(entry.path,query)?nearby:undefined;
          if(matches)for(const p of targets)matches.push({scopeId:scope,entry,printerId:p.id,printerName:p.name});
        }
      }catch{failures++}
    }
    this.assertActive(revision);
    this.candidates=choices.slice(0,40);
    if(failures)return{text:'Часть библиотеки недоступна. Повторите поиск после проверки хранилища; автоматический выбор отключён.',choices:this.candidates};
    if(!choices.length&&nearby.length){
      this.candidates=nearby.slice(0,40);
      return{text:'Точного совпадения нет. Возможно, я неточно расслышал название. Показываю похожие файлы: выберите нужный ниже или назовите его номер.',choices:this.candidates};
    }
    if(print&&choices.length===1)return this.prepare(choices[0],revision,signal);
    return{text:choices.length?`Найдено вариантов: ${choices.length}. Выберите файл и принтер ниже или скажите «Выбери первый», «Выбери второй».${choices.length>40?' Показаны первые 40: уточните название.':''}`:'В «Моей флешке» подходящих файлов нет. Попробуйте часть названия.',choices:this.candidates};
  }
  private async prepare(candidate:VoiceCandidate,revision:number,signal:AbortSignal):Promise<VoiceReply>{
    if(this.unresolved)throw new Error('Предыдущий запуск ещё не подтверждён. Скажите «Проверь запуск»');
    const p=this.printer(candidate.printerId);this.assertReady(p);
    if(localLibraryScopeId(p)!==candidate.scopeId)throw new Error('Библиотека принтера изменилась. Повторите поиск');
    const fingerprint=target(p),client=this.deps.client(p.id);
    const {sha256,report}=await this.deps.validate(p,candidate,signal);
    this.assertActive(revision);
    if(target(this.printer(p.id))!==fingerprint||client!==this.deps.client(p.id))throw new Error('Настройки или соединение принтера изменились. Повторите поиск');
    if(!report.ok)return{text:`Файл не прошёл проверку: ${report.issues.filter(i=>i.level==='error').map(i=>i.message).join('. ')}`};
    this.assertReady(this.printer(p.id));
    this.proposal={candidate,sha256,report,target:fingerprint,client,expiresAt:this.now()+90_000};
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
    let p=validateTarget();await this.deps.ready(p);p=validateTarget();
    const path=await this.deps.upload(p,proposal,signal);
    p=validateTarget();await this.deps.ready(p);p=validateTarget();
    this.unresolved={printerId:p.id,path,target:proposal.target,client:proposal.client};
    try{await this.deps.start(p,path,proposal.report)}
    catch(error){if(uncertainPrintStart(error))return{text:'Команда отправлена, но запуск пока не подтверждён. Повторно не отправляю. Скажите «Проверь запуск».',unconfirmed:true};this.unresolved=undefined;throw error}
    this.unresolved=undefined;
    void this.deps.audit(`${proposal.candidate.entry.path} → ${path} → ${p.name}`).catch(()=>{});
    return{text:`Принтер ${p.name} подтвердил запуск файла «${proposal.candidate.entry.path}».`};
  }
  private async check():Promise<VoiceReply>{
    const pending=this.unresolved;if(!pending)return{text:'Неподтверждённых запусков нет'};
    const p=this.printer(pending.printerId);
    if(target(p)!==pending.target||this.deps.client(p.id)!==pending.client)throw new Error('Соединение или настройки изменились. Проверьте печать в карточке принтера');
    const confirmed=await this.deps.check(p,pending.path);
    if(confirmed)this.unresolved=undefined;
    return{text:confirmed?`${p.name}: запуск файла «${pending.path}» подтверждён.`:'Принтер пока не подтвердил запуск. Повторная команда не отправлялась.',unconfirmed:!confirmed};
  }
}
