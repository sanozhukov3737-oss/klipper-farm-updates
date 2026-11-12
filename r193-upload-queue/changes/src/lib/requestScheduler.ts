export type PrinterRequestPriority='emergency'|'control'|'upload'|'background';

const PRIORITY:Record<PrinterRequestPriority,number>={emergency:0,control:1,upload:2,background:3};

export class RequestCancelledError extends Error{
  constructor(message='Операция отменена'){
    super(message);
    this.name='AbortError';
  }
}

export interface PrinterRequestSchedulerSnapshot{
  active?:{priority:PrinterRequestPriority;label:string;startedAt:number};
  queued:number;
  queuedByPriority:Record<PrinterRequestPriority,number>;
  completed:number;
  failed:number;
  cancelled:number;
  maximumQueueDepth:number;
  lastDurationMs?:number;
  averageDurationMs?:number;
}

type Task<T>={
  sequence:number;
  priority:PrinterRequestPriority;
  label:string;
  coalesceKey?:string;
  controller:AbortController;
  worker:(signal:AbortSignal)=>Promise<T>;
  resolve:(value:T)=>void;
  reject:(reason:unknown)=>void;
  promise:Promise<T>;
  startedAt?:number;
  detachSignal?:()=>void;
};

// Потолок для фонового опроса. Живой принтер отвечает за секунды; если ответа
// нет дольше, соединение считается зависшим и очередь освобождается.
const BACKGROUND_TASK_TIMEOUT_MS=20_000;

const cancelled=(signal?:AbortSignal)=>signal?.aborted;

/**
 * One priority queue per physical printer. Emergency/control requests cancel
 * a lower-priority long operation at its next bounded yield; otherwise the
 * active native call is allowed to finish. Long operations receive an
 * AbortSignal and must yield between chunks.
 */
export class PrinterRequestScheduler{
  private queue:Task<unknown>[]=[];
  private active?:Task<unknown>;
  private sequence=0;
  private closed=false;
  private completed=0;
  private failed=0;
  private cancelledCount=0;
  private maximumQueueDepth=0;
  private totalDurationMs=0;
  private lastDurationMs?:number;

  run<T>(
    priority:PrinterRequestPriority,
    label:string,
    worker:(signal:AbortSignal)=>Promise<T>|T,
    options:{signal?:AbortSignal;coalesceKey?:string}={},
  ):Promise<T>{
    if(this.closed)return Promise.reject(new RequestCancelledError('Планировщик запросов остановлен'));
    if(cancelled(options.signal))return Promise.reject(new RequestCancelledError());
    if(options.coalesceKey){
      const existing=[this.active,...this.queue].find(task=>task?.coalesceKey===options.coalesceKey);
      if(existing)return existing.promise as Promise<T>;
    }
    const controller=new AbortController();
    let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
    const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail});
    const task:Task<T>={
      sequence:++this.sequence,
      priority,
      label:label.trim().slice(0,120)||'request',
      coalesceKey:options.coalesceKey,
      controller,
      worker:async signal=>await worker(signal),
      resolve,
      reject,
      promise,
    };
    if(options.signal){
      const abort=()=>controller.abort(options.signal?.reason);
      options.signal.addEventListener('abort',abort,{once:true});
      task.detachSignal=()=>options.signal?.removeEventListener('abort',abort);
    }
    this.queue.push(task as Task<unknown>);
    this.queue.sort((left,right)=>PRIORITY[left.priority]-PRIORITY[right.priority]||left.sequence-right.sequence);
    this.maximumQueueDepth=Math.max(this.maximumQueueDepth,this.queue.length+(this.active?1:0));
    // Отправку файла оператор запустил сам, поэтому она вытесняет висящий
    // фоновый опрос так же, как команда управления. Иначе на Forge-X файл
    // стоит за опросом телеметрии и «программа долго думает», а на принтере
    // ничего не появляется; перезапуск приложения помогал именно потому, что
    // создавал пустую очередь.
    if(this.active&&PRIORITY[priority]<PRIORITY[this.active.priority]
      &&(priority==='emergency'||priority==='control'||(priority==='upload'&&this.active.priority==='background'))){
      this.active.controller.abort(`Операция прервана командой ${label}`);
    }
    this.drain();
    return promise;
  }

  cancelQueued(predicate:(task:{priority:PrinterRequestPriority;label:string})=>boolean=()=>true,reason='Операция отменена'){
    let count=0;
    const kept:Task<unknown>[]=[];
    for(const task of this.queue){
      if(!predicate(task)){kept.push(task);continue}
      count++;
      task.detachSignal?.();
      task.controller.abort(reason);
      task.reject(new RequestCancelledError(reason));
      this.cancelledCount++;
    }
    this.queue=kept;
    return count;
  }

  cancelActive(predicate:(task:{priority:PrinterRequestPriority;label:string})=>boolean=()=>true,reason='Операция отменена'){
    if(!this.active||!predicate(this.active))return false;
    this.active.controller.abort(reason);
    return true;
  }

  close(reason='Соединение с принтером закрыто'){
    this.closed=true;
    this.cancelQueued(()=>true,reason);
    this.cancelActive(()=>true,reason);
  }

  reopen(){this.closed=false}

  snapshot():PrinterRequestSchedulerSnapshot{
    const queuedByPriority:Record<PrinterRequestPriority,number>={emergency:0,control:0,upload:0,background:0};
    for(const task of this.queue)queuedByPriority[task.priority]++;
    return{
      ...(this.active?.startedAt?{active:{priority:this.active.priority,label:this.active.label,startedAt:this.active.startedAt}}:{}),
      queued:this.queue.length,
      queuedByPriority,
      completed:this.completed,
      failed:this.failed,
      cancelled:this.cancelledCount,
      maximumQueueDepth:this.maximumQueueDepth,
      lastDurationMs:this.lastDurationMs,
      averageDurationMs:this.completed+this.failed?Math.round(this.totalDurationMs/(this.completed+this.failed)):undefined,
    };
  }

  private drain(){
    if(this.active||this.closed)return;
    const task=this.queue.shift();
    if(!task)return;
    this.active=task;
    task.startedAt=Date.now();
    // Фоновый опрос, который не ответил вовремя, больше не держит очередь:
    // иначе одно зависшее соединение останавливает все последующие запросы,
    // включая отправку файла.
    const watchdog = task.priority === 'background'
      ? window.setTimeout(() => task.controller.abort('Фоновый запрос не ответил вовремя'), BACKGROUND_TASK_TIMEOUT_MS)
      : undefined;
    void (async()=>{
      try{
        if(task.controller.signal.aborted)throw new RequestCancelledError();
        const result=await task.worker(task.controller.signal);
        if(task.controller.signal.aborted)throw new RequestCancelledError();
        this.completed++;
        task.resolve(result);
      }catch(error){
        if(task.controller.signal.aborted||error instanceof RequestCancelledError||(error instanceof Error&&error.name==='AbortError')){
          this.cancelledCount++;
          task.reject(error instanceof Error?error:new RequestCancelledError());
        }else{
          this.failed++;
          task.reject(error);
        }
      }finally{
        if(watchdog!==undefined)window.clearTimeout(watchdog);
        task.detachSignal?.();
        const duration=Math.max(0,Date.now()-(task.startedAt??Date.now()));
        this.lastDurationMs=duration;
        this.totalDurationMs+=duration;
        if(this.active===task)this.active=undefined;
        queueMicrotask(()=>this.drain());
      }
    })();
  }
}
