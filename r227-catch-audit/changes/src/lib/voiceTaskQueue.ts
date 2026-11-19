import type { PrinterModel } from '../types';
import { localLibraryScopeId } from './localLibraryScope';

export type VoiceTaskStatus = 'draft'|'prepared'|'sending'|'awaiting-confirmation'|'started'|'failed'|'cancelled'|'needs-check';
export interface VoiceTaskStorage {getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
export type VoiceTaskDraft = {query:string;scopeId:string;path:string;printerId:string;printerName:string;sha256?:string;target?:string};
export type VoiceTask = VoiceTaskDraft & {id:string;batchId:string;copy:number;status:VoiceTaskStatus;createdAt:number;updatedAt:number;remotePath?:string;dispatchedAt?:number;error?:string};
export type VoiceTaskUpdate = {sha256?:string;target?:string;remotePath?:string;error?:string;confirmed?:boolean;confirmedNotStarted?:boolean};
export type VoiceTaskResult = {ok:boolean;task?:VoiceTask;error?:string};
export const VOICE_TASK_QUEUE_LIMIT=200;
export const VOICE_TASK_QUEUE_MAX_CHARACTERS=256*1024;
const PREFIX='klipper-voice-task-queue-v1:';
const statuses=new Set<VoiceTaskStatus>(['draft','prepared','sending','awaiting-confirmation','started','failed','cancelled','needs-check']);
const busyStatuses=new Set<VoiceTaskStatus>(['sending','awaiting-confirmation']);
const blockedStatuses=new Set<VoiceTaskStatus>(['sending','awaiting-confirmation','needs-check']);
const plain=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value)&&!!value.trim();
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const path=(value:unknown):value is string=>plain(value,4096)&&!/^(?:[\\/]|[a-z]:)/iu.test(value)&&!value.split(/[\\/]/u).some(part=>part==='.'||part==='..')&&/\.(?:gcode|gco|g)$/iu.test(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const timestamp=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const clone=(task:VoiceTask):VoiceTask=>({...task});
const validDraft=(value:unknown):value is VoiceTaskDraft=>{
  if(!value||typeof value!=='object')return false;const item=value as VoiceTaskDraft;
  return plain(item.query,300)&&plain(item.scopeId,200)&&path(item.path)&&plain(item.printerId,200)&&plain(item.printerName,200)
    &&(item.sha256===undefined||sha(item.sha256))&&(item.target===undefined||plain(item.target,8192));
};
const signature=(items:readonly VoiceTaskDraft[])=>JSON.stringify(items.map(item=>[item.query,item.scopeId,item.path,item.printerId,item.printerName,item.sha256??null,item.target??null]));
type Receipt={id:string;signature:string;itemIds:string[]};
type State={version:1;revision:number;tasks:VoiceTask[];receipts:Receipt[]};
type Read={state:State;available:boolean;error?:string};
const empty=():State=>({version:1,revision:0,tasks:[],receipts:[]});

/** Local review plan, never a Moonraker auto-start queue. There are deliberately
 * no upload/start callbacks. Every resumed task goes through the assistant's
 * current catalog, model, hash, readiness and separate confirmation checks. */
export class VoiceTaskQueue {
  private readonly key?:string;
  private listeners=new Set<()=>void>();
  private lastError?:string;
  constructor(private readonly storage:VoiceTaskStorage|undefined,profileId:string,private readonly now=()=>Date.now()){
    if(plain(profileId,128))try{this.key=PREFIX+encodeURIComponent(profileId)}catch{/* профиль не кодируется: ключ остаётся пустым, очередь работает в памяти */}
    this.recoverInterrupted();
  }
  subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  availability(){const current=this.read();return{available:current.available,error:this.lastError??current.error}}
  list(){return this.read().state.tasks.map(clone)}
  get(id:string){const item=this.read().state.tasks.find(task=>task.id===id);return item?clone(item):undefined}
  addPlan(drafts:readonly VoiceTaskDraft[],requestId:string):{ok:boolean;tasks:VoiceTask[];created:boolean;error?:string}{
    const current=this.read();
    if(!current.available)return{ok:false,tasks:[],created:false,error:current.error};
    if(!identifier(requestId)||!Array.isArray(drafts)||!drafts.length||drafts.length>99||!drafts.every(validDraft))return{ok:false,tasks:[],created:false,error:'Некорректный план печати'};
    const stamp=signature(drafts),existing=current.state.receipts.find(item=>item.id===requestId);
    if(existing){
      if(existing.signature!==stamp)return{ok:false,tasks:[],created:false,error:'Этот запрос уже сохранён с другим планом'};
      return{ok:true,tasks:current.state.tasks.filter(item=>item.batchId===requestId).map(clone),created:false};
    }
    if(current.state.tasks.length+drafts.length>VOICE_TASK_QUEUE_LIMIT||current.state.receipts.length>=VOICE_TASK_QUEUE_LIMIT)return{ok:false,tasks:[],created:false,error:'План заполнен. Удалите завершённые задания или очистите проверенный план'};
    const time=this.time(),tasks=drafts.map((draft,index):VoiceTask=>({...draft,id:`${requestId}:${index+1}`,batchId:requestId,copy:index+1,status:'draft',createdAt:time,updatedAt:time}));
    current.state.tasks.push(...tasks);current.state.receipts.push({id:requestId,signature:stamp,itemIds:tasks.map(item=>item.id)});
    if(!this.write(current.state))return{ok:false,tasks:[],created:false,error:this.lastError};
    return{ok:true,tasks:tasks.map(clone),created:true};
  }
  setStatus(id:string,status:VoiceTaskStatus,details:VoiceTaskUpdate={}):VoiceTaskResult{
    const current=this.read();if(!current.available)return{ok:false,error:current.error};
    const task=current.state.tasks.find(item=>item.id===id);if(!task)return{ok:false,error:'Задание удалено или не найдено'};
    if(!statuses.has(status))return{ok:false,error:'Неизвестный этап задания'};
    const error=(message:string):VoiceTaskResult=>({ok:false,task:clone(task),error:message});
    if(task.status==='started'||task.status==='cancelled')return error('Задание уже завершено. Повторный запуск не разрешён');
    if(task.status==='needs-check')return error('Сначала проверьте ранее отправленный запуск');
    if(details.error!==undefined&&!plain(details.error,600))return error('Некорректное описание ошибки');
    if(details.remotePath!==undefined&&!path(details.remotePath))return error('Некорректное имя отправленного файла');
    if(status==='prepared'){
      if(!['draft','prepared','failed'].includes(task.status)||!sha(details.sha256)||!plain(details.target,8192))return error('Нужна новая проверка файла и принтера');
      if(task.sha256&&task.sha256!==details.sha256)return error('Файл изменился после составления плана. Выберите его заново');
      if(task.target&&task.target!==details.target)return error('Принтер или его настройки изменились. Составьте план заново');
      task.sha256=details.sha256;task.target=details.target;delete task.remotePath;delete task.dispatchedAt;
    }else if(status==='sending'){
      if(task.status!=='prepared'||!task.sha256||!task.target)return error('Задание не подготовлено или уже отправляется');
      if(current.state.tasks.some(item=>item.id!==id&&item.printerId===task.printerId&&blockedStatuses.has(item.status)))return error('На этом принтере есть непроверенная отправка. Повторный запуск запрещён');
    }else if(status==='awaiting-confirmation'){
      if(task.status!=='sending'||!details.remotePath)return error('Передача файла ещё не подтверждена');
      // Durable uncertain boundary: the caller persists this before deps.start.
      // History recovery must match this exact path and dispatch time.
      task.remotePath=details.remotePath;task.dispatchedAt=this.time();
    }else if(status==='started'){
      if(task.status!=='awaiting-confirmation'||details.confirmed!==true||!task.remotePath)return error('Принтер ещё не подтвердил запуск');
      if(details.remotePath&&details.remotePath!==task.remotePath)return error('Подтверждён другой файл');
    }else if(status==='needs-check'){
      if(task.status!=='awaiting-confirmation')return error('Команда запуска не отправлялась');
    }else if(status==='failed'||status==='cancelled'){
      if(task.status==='awaiting-confirmation'&&details.confirmedNotStarted!==true)return error('Результат запуска неизвестен. Нужна проверка состояния');
    }else if(status==='draft'){
      if(!['draft','prepared','failed'].includes(task.status))return error('Нельзя сбросить выполняемую отправку');
    }
    task.status=status;task.updatedAt=this.time();
    if(details.error)task.error=details.error;else delete task.error;
    if(!this.write(current.state))return{ok:false,error:this.lastError};
    return{ok:true,task:clone(task)};
  }
  /** Called only after an actual read-only printer check. A negative/empty
   * response alone never proves that a late print-start cannot arrive. */
  reconcile(id:string,result:{confirmed:boolean;remotePath?:string;target?:string;confirmedNotStarted?:boolean}):VoiceTaskResult{
    const current=this.read();if(!current.available)return{ok:false,error:current.error};
    const task=current.state.tasks.find(item=>item.id===id);if(!task)return{ok:false,error:'Задание не найдено'};
    if(task.status!=='needs-check'&&task.status!=='awaiting-confirmation')return{ok:false,task:clone(task),error:'Нет непроверенного запуска'};
    if(!task.target||result.target!==task.target)return{ok:false,task:clone(task),error:'Соединение или настройки принтера изменились. Проверьте его карточку'};
    if(result.remotePath!==undefined&&(!path(result.remotePath)||task.remotePath&&result.remotePath!==task.remotePath))return{ok:false,task:clone(task),error:'Подтверждён другой файл'};
    if(result.confirmed){
      if(!task.remotePath||result.remotePath!==task.remotePath)return{ok:false,task:clone(task),error:'Нужно подтверждение точного отправленного файла'};
      task.status='started';delete task.error;
    }else if(result.confirmedNotStarted===true){task.status='failed';task.error='Проверка подтвердила, что запуск не состоялся. Нужна новая подготовка'}
    else return{ok:true,task:clone(task)};
    task.updatedAt=this.time();if(!this.write(current.state))return{ok:false,error:this.lastError};return{ok:true,task:clone(task)};
  }
  remove(id:string):VoiceTaskResult{
    const current=this.read();if(!current.available)return{ok:false,error:current.error};
    const task=current.state.tasks.find(item=>item.id===id);if(!task)return{ok:false,error:'Задание не найдено'};
    if(blockedStatuses.has(task.status))return{ok:false,task:clone(task),error:'Сначала проверьте результат отправки'};
    current.state.tasks=current.state.tasks.filter(item=>item.id!==id);
    if(!this.write(current.state))return{ok:false,error:this.lastError};return{ok:true,task:clone(task)};
  }
  reset():{ok:boolean;error?:string}{
    const current=this.read();if(!current.available)return{ok:false,error:current.error};
    if(current.state.tasks.some(item=>blockedStatuses.has(item.status)))return{ok:false,error:'В плане есть непроверенная отправка. Сначала проверьте запуск'};
    return this.write(empty())?{ok:true}:{ok:false,error:this.lastError};
  }
  private time(){const value=this.now();return timestamp(value)?value:Date.now()}
  private recoverInterrupted(){
    const current=this.read();if(!current.available)return;let changed=false;
    for(const task of current.state.tasks){
      let recovered=false;
      if(task.status==='sending'){task.status='failed';task.error='Передача прервана до команды печати; нужна новая проверка';recovered=true}
      else if(task.status==='awaiting-confirmation'){task.status='needs-check';task.error='Сеанс прерван после подготовки команды печати. Проверьте состояние принтера перед любым повтором';recovered=true}
      else if(task.status==='prepared'){task.status='draft';task.error='После перезапуска требуется новая проверка файла и принтера';recovered=true}
      if(recovered){changed=true;task.updatedAt=this.time()}
    }
    if(changed)this.write(current.state);
  }
  private read():Read{
    const state=empty(),unavailable=(error:string):Read=>({state,available:false,error});
    if(!this.storage||!this.key)return unavailable('Сохранение плана для этого профиля недоступно');
    let raw:string|null;try{raw=this.storage.getItem(this.key)}catch{return unavailable('Не удалось прочитать сохранённый план')}
    if(!raw)return{state,available:true};
    if(raw.length>VOICE_TASK_QUEUE_MAX_CHARACTERS)return unavailable('Сохранённый план превышает допустимый размер');
    try{
      const parsed=JSON.parse(raw) as State;
      if(parsed?.version!==1||!Number.isSafeInteger(parsed.revision)||parsed.revision<0||!Array.isArray(parsed.tasks)||!Array.isArray(parsed.receipts)||parsed.tasks.length>VOICE_TASK_QUEUE_LIMIT||parsed.receipts.length>VOICE_TASK_QUEUE_LIMIT)throw new Error();
      const ids=new Set<string>(),batches=new Set<string>();
      for(const row of parsed.receipts){if(!identifier(row?.id)||!plain(row.signature,VOICE_TASK_QUEUE_MAX_CHARACTERS)||!Array.isArray(row.itemIds)||!row.itemIds.length||row.itemIds.length>99||!row.itemIds.every(id=>plain(id,160))||batches.has(row.id))throw new Error();batches.add(row.id)}
      for(const task of parsed.tasks){
        if(!validDraft(task)||!plain(task.id,160)||!identifier(task.batchId)||!Number.isSafeInteger(task.copy)||task.copy<1||task.copy>99||!statuses.has(task.status)||!timestamp(task.createdAt)||!timestamp(task.updatedAt)||ids.has(task.id)||!parsed.receipts.some(row=>row.id===task.batchId&&row.itemIds.includes(task.id)))throw new Error();
        if(task.remotePath!==undefined&&!path(task.remotePath)||task.error!==undefined&&!plain(task.error,600))throw new Error();
        if(task.dispatchedAt!==undefined&&!timestamp(task.dispatchedAt))throw new Error();
        if(['prepared','sending','awaiting-confirmation','started','needs-check'].includes(task.status)&&(!task.sha256||!task.target))throw new Error();
        if(['awaiting-confirmation','started'].includes(task.status)&&!task.remotePath)throw new Error();
        ids.add(task.id);
      }
      return{state:parsed,available:true};
    }catch{return unavailable('Сохранённый план повреждён. Автоматический повтор запрещён')}
  }
  private write(state:State){
    if(!this.storage||!this.key){this.lastError='Сохранение плана недоступно';return false}
    state.revision++;const raw=JSON.stringify(state);
    if(raw.length>VOICE_TASK_QUEUE_MAX_CHARACTERS){this.lastError='План слишком большой. Сократите число заданий';return false}
    try{this.storage.setItem(this.key,raw);this.lastError=undefined;for(const listener of this.listeners)try{listener()}catch{/* подписчик не должен ломать запись: данные уже сохранены */}return true}
    catch{this.lastError='Не удалось сохранить план. Отправка не разрешена';return false}
  }
}

/** Allocation accepts already reviewed/validated candidates from the caller.
 * Matching a library scope is necessary, not sufficient evidence of G-code
 * compatibility; the returned items remain drafts for fresh preparation. */
export function allocateVoiceTasks(quantity:number,candidates:readonly VoiceTaskDraft[],printers:readonly PrinterModel[]):VoiceTaskDraft[]{
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>99)return[];
  const source=candidates[0];
  if(!source||candidates.some(item=>item.scopeId!==source.scopeId||item.path!==source.path))return[];
  const available=candidates.filter(item=>validDraft(item)&&printers.some(printer=>printer.id===item.printerId&&localLibraryScopeId(printer)===item.scopeId));
  const unique=available.filter((item,index)=>available.findIndex(other=>other.printerId===item.printerId&&other.scopeId===item.scopeId&&other.path===item.path)===index);
  if(!unique.length)return[];
  const ready=(item:VoiceTaskDraft)=>{const printer=printers.find(value=>value.id===item.printerId)!;return printer.status.state==='ready'&&printer.status.connectionState==='online'&&!printer.status.remoteControlSuspended};
  const ordered=[...unique].sort((a,b)=>Number(ready(b))-Number(ready(a)));
  return Array.from({length:quantity},(_,index)=>({...ordered[index%ordered.length]}));
}
export function voiceTaskProgress(task:VoiceTask){
  const labels:Record<VoiceTaskStatus,string>={draft:'Запланировано',prepared:'Проверено — подтвердите запуск',sending:'Передаём проверенный файл','awaiting-confirmation':'Ожидаем подтверждение принтера',started:'Принтер подтвердил запуск',failed:'Отправка не завершена',cancelled:'Задание отменено','needs-check':'Нужно проверить прежний запуск'};
  const details:Record<VoiceTaskStatus,string>={draft:'Перед запуском проверим актуальный файл и принтер',prepared:'Нужно отдельное подтверждение запуска',sending:'Ожидаем завершения передачи файла','awaiting-confirmation':'Повторный запуск запрещён до проверки результата',started:'Остальные задания ждут отдельной подготовки и подтверждения',failed:'Проверьте причину и заново подготовьте задание',cancelled:'Это задание больше не ожидает запуска','needs-check':'Проверьте состояние принтера перед любым повтором'};
  return{label:labels[task.status],detail:task.error??details[task.status],busy:busyStatuses.has(task.status),canPrepare:['draft','prepared','failed'].includes(task.status),canRemove:!blockedStatuses.has(task.status),needsCheck:task.status==='needs-check'};
}
