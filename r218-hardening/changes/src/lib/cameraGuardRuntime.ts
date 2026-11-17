import { useEffect, useRef, useState } from 'react';
import type { PrinterModel } from '../types';
import type { MoonrakerClient } from './moonraker';
import { secureInvoke } from './auth';
import { dbSet } from './db';
import { nativeNotify } from './native';
import { recordNotification, showAppNotification } from './appNotifications';
import { diagnosticWarning } from './diagnosticLog';
import { analyzeCameraFrame, disposeCameraDetector } from './cameraDetector';
import { CAMERA_GUARD_KEY, CAMERA_GUARD_LATCH_KEY, CameraGuardMachine, emptyCameraGuardSettings, restoreCameraGuardSettings, restoreCameraGuardLatches, type CameraFrameContext, type CameraGuardEvent, type CameraGuardMode, type CameraGuardSettings, type CameraGuardStatus, type CameraGuardTrigger } from './cameraGuard';

export type CameraGuardController={ready:boolean;error:string;settings:CameraGuardSettings;statuses:Record<string,CameraGuardStatus>;activePrinterIds:string[];setMode:(id:string,mode:CameraGuardMode)=>void;retry:()=>void;submitFrame:(id:string,frame:ImageBitmap,context:CameraFrameContext)=>void;unavailable:(id:string,reason:string)=>void;getJobToken:(id:string)=>string|undefined};
type Options={printers:PrinterModel[];clients:Map<string,MoonrakerClient>;enabled:boolean};

/** Lives in FarmApp rather than the TV/camera window. Frames never queue behind old inference work. */
export function useCameraGuard(options:Options):CameraGuardController{
  const current=useRef(options);current.current=options;
  const machine=useRef(new CameraGuardMachine()),live=useRef(false),readyRef=useRef(false),loadGeneration=useRef(0),requested=useRef(emptyCameraGuardSettings()),settingsRevision=useRef(0),writes=useRef(Promise.resolve());
  const inFlight=useRef(new Map<string,{abort:AbortController;sourceEpoch:string;jobToken:string}>());
  const latchWrites=useRef(Promise.resolve()),latchTarget=useRef('');
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[settings,setSettings]=useState(emptyCameraGuardSettings),[statuses,setStatuses]=useState<Record<string,CameraGuardStatus>>({}),[activePrinterIds,setActivePrinterIds]=useState<string[]>([]),[reload,setReload]=useState(0);
  const published=useRef('');
  const persistLatches=()=>{
    if(!readyRef.current||!live.current)return Promise.resolve();
    const snapshot=machine.current.storedLatches(),encoded=JSON.stringify(snapshot);
    if(encoded===latchTarget.current)return latchWrites.current;
    latchTarget.current=encoded;
    latchWrites.current=latchWrites.current.catch(()=>{}).then(async()=>{
      try{await dbSet(CAMERA_GUARD_LATCH_KEY,snapshot)}catch(reason){if(latchTarget.current===encoded)latchTarget.current='';throw reason}
    });
    return latchWrites.current;
  };
  const notify=async(printerId:string,action:string,title:string,body:string,token:string)=>{
    showAppNotification(title,body,'danger',{dedupeKey:`camera:${token}:${action}`,expiresAfterMs:15_000});
    void nativeNotify(title,body).catch(reason=>diagnosticWarning('camera_guard.native_notification',reason,{printerId}));
    try{await recordNotification(action,`${current.current.printers.find(printer=>printer.id===printerId)?.name??printerId} · ${body}`)}catch(reason){diagnosticWarning('camera_guard.notification',reason,{printerId})}
  };
  const events=(items:CameraGuardEvent[])=>{
    for(const item of items){
      const name=current.current.printers.find(printer=>printer.id===item.printerId)?.name??'Принтер';
      if(item.kind==='paused')void notify(item.printerId,'camera.paused',`${name}: печать приостановлена`,'Камера обнаружила признаки сбоя. Проверьте модель перед продолжением.',item.jobToken);
      else void notify(item.printerId,'camera.pause_failed',`${name}: проверьте печать`,item.reason||'Автопауза не подтверждена. Повторная команда автоматически не отправляется.',item.jobToken);
    }
  };
  const publish=()=>{
    if(!live.current)return;
    const now=Date.now();machine.current.observe(current.current.printers,now);events(machine.current.drainEvents());
    void persistLatches().catch(reason=>diagnosticWarning('camera_guard.incident_save',reason));
    const next=machine.current.statuses(now),active=readyRef.current&&current.current.enabled?machine.current.activePrinterIds(now):[];
    const encoded=JSON.stringify([next,active]);if(encoded!==published.current){published.current=encoded;setStatuses(next);setActivePrinterIds(active)}
  };
  const abortAll=()=>{for(const item of inFlight.current.values())item.abort.abort();inFlight.current.clear()};
  useEffect(()=>{
    const generation=++loadGeneration.current;
    settingsRevision.current++;machine.current=new CameraGuardMachine();published.current='';
    live.current=true;readyRef.current=false;setReady(false);abortAll();
    if(!options.enabled){machine.current.setSettings(emptyCameraGuardSettings());setSettings(emptyCameraGuardSettings());disposeCameraDetector();publish();return()=>{live.current=false;abortAll();disposeCameraDetector()}}
    let stopped=false;
    void (async()=>{
      try{
        const [raw,rawLatches]=await Promise.all([secureInvoke<string|null>('db_get_json',{key:CAMERA_GUARD_KEY}),secureInvoke<string|null>('db_get_json',{key:CAMERA_GUARD_LATCH_KEY})]);
        const restored=restoreCameraGuardSettings(raw===null?null:JSON.parse(raw));
        const restoredLatches=restoreCameraGuardLatches(rawLatches===null?null:JSON.parse(rawLatches));
        if(stopped||generation!==loadGeneration.current)return;
        requested.current=restored;machine.current.restoreLatches(restoredLatches);latchTarget.current=JSON.stringify(restoredLatches);machine.current.setSettings(restored);setSettings(restored);readyRef.current=true;setReady(true);setError('');publish();
      }catch(reason){if(!stopped){setError('Не удалось загрузить защиту камеры. Автопауза выключена.');diagnosticWarning('camera_guard.load',reason)}}
    })();
    const timer=window.setInterval(publish,1_000);
    return()=>{stopped=true;live.current=false;readyRef.current=false;abortAll();disposeCameraDetector();window.clearInterval(timer);machine.current.setSettings(emptyCameraGuardSettings())};
  },[options.enabled,reload]);
  useEffect(()=>{publish()},[options.printers,options.enabled,ready]);
  const persist=(next:CameraGuardSettings)=>{
    const revision=++settingsRevision.current,generation=loadGeneration.current;
    requested.current=next;
    writes.current=writes.current.catch(()=>{}).then(async()=>{
      try{
        await dbSet(CAMERA_GUARD_KEY,next);
        if(!live.current||generation!==loadGeneration.current||revision!==settingsRevision.current)return;
        machine.current.setSettings(next);setSettings(next);setError('');publish();
        if(!Object.values(next.printers).some(item=>item.mode!=='off')){abortAll();disposeCameraDetector()}
      }catch(reason){
        if(live.current&&generation===loadGeneration.current&&revision===settingsRevision.current)setError('Режим защиты не сохранён. Автопауза не включена; повторите сохранение.');
        diagnosticWarning('camera_guard.save',reason);
      }
    });
  };
  const applyTrigger=async(trigger:CameraGuardTrigger)=>{
    const printer=current.current.printers.find(item=>item.id===trigger.printerId),name=printer?.name??'Принтер';
    try{await persistLatches()}catch{if(trigger.mode==='pause')machine.current.fail(trigger.printerId,'Срабатывание защиты не сохранено. Команда паузы не отправлена.',trigger.incidentToken);else setError('Не удалось сохранить срабатывание защиты камеры.');publish();return}
    machine.current.observe(current.current.printers,Date.now());
    if(!live.current||!readyRef.current||!current.current.enabled||machine.current.mode(trigger.printerId)!==trigger.mode||machine.current.jobToken(trigger.printerId,Date.now())!==trigger.jobToken){
      machine.current.cancelQueued(trigger,'задание, режим или доступность принтера изменились');publish();return;
    }
    if(trigger.mode==='pause'&&!machine.current.canPause(trigger,Date.now())){
      machine.current.cancelQueued(trigger,'нет свежего кадра и состояния печати для безопасной команды');publish();return;
    }
    void notify(trigger.printerId,'camera.warning',`${name}: возможен сбой печати`,trigger.mode==='pause'?'На нескольких кадрах обнаружены признаки сбоя. Отправляем защищённую команду паузы.':'На нескольких кадрах обнаружены признаки сбоя. Проверьте печать.',trigger.jobToken);
    if(trigger.mode!=='pause')return;
    const client=current.current.clients.get(trigger.printerId);
    if(!client){machine.current.fail(trigger.printerId,'Нет подключения для команды паузы',trigger.incidentToken);publish();return}
    void client.guardedPause({filename:trigger.filename,minimumPrintDuration:trigger.duration},()=>{
      if(!live.current||!readyRef.current||!current.current.enabled||current.current.clients.get(trigger.printerId)!==client)return false;
      machine.current.observe(current.current.printers,Date.now());
      return machine.current.markPauseSent(trigger,Date.now());
    }).then(()=>{publish()}).catch(reason=>{
      machine.current.fail(trigger.printerId,`Пауза не подтверждена: ${String(reason instanceof Error?reason.message:reason).slice(0,220)}`,trigger.incidentToken);publish();
    });
  };
  return {ready,error,settings,statuses,activePrinterIds,
    getJobToken:id=>{machine.current.observe(current.current.printers,Date.now());return readyRef.current&&current.current.enabled?machine.current.jobToken(id,Date.now()):undefined},
    setMode:(id,mode)=>{
      if(!live.current||!readyRef.current||!current.current.enabled||!current.current.printers.some(printer=>printer.id===id)||!['off','notify','pause'].includes(mode))return;
      inFlight.current.get(id)?.abort.abort();
      const next:CameraGuardSettings={version:1,printers:{...requested.current.printers,[id]:{mode}}};
      // A disabling/degrading choice takes effect immediately; arming waits for a durable successful write.
      const previous=machine.current.mode(id);
      if(mode==='off'||previous==='pause'&&mode==='notify'){
        const safe={...machine.current.settings,printers:{...machine.current.settings.printers,[id]:{mode}}};machine.current.setSettings(safe);setSettings(safe);publish();
      }
      persist(next);
    },
    retry:()=>{if(readyRef.current)persist(requested.current);else setReload(value=>value+1)},
    unavailable:(id,reason)=>{inFlight.current.get(id)?.abort.abort();machine.current.unavailable(id,reason);publish()},
    submitFrame:(id,frame,context)=>{
      if(!live.current||!readyRef.current||!current.current.enabled){frame.close();return}
      machine.current.observe(current.current.printers,Date.now());
      const pending=inFlight.current.get(id);
      if(pending){if(pending.sourceEpoch!==context.sourceEpoch||pending.jobToken!==context.jobToken){pending.abort.abort();machine.current.unavailable(id,'Камера переподключается')}frame.close();publish();return}
      const ticket=machine.current.beginFrame(id,context,Date.now());
      if(!ticket){frame.close();publish();return}
      const abort=new AbortController(),work={abort,sourceEpoch:context.sourceEpoch,jobToken:context.jobToken};inFlight.current.set(id,work);
      void (async()=>{
        try{
          // analyzeCameraFrame takes ownership and transfers the bitmap to its worker.
          const result=await analyzeCameraFrame(frame,abort.signal);
          if(abort.signal.aborted||!live.current||!readyRef.current||!current.current.enabled)return;
          machine.current.observe(current.current.printers,Date.now());
          const trigger=machine.current.completeFrame(ticket,result.score,Date.now());
          if(trigger)void applyTrigger(trigger);
        }catch(reason){
          if(!abort.signal.aborted&&live.current){machine.current.unavailable(id,`Проверка камеры недоступна: ${String(reason instanceof Error?reason.message:reason).slice(0,170)}`);diagnosticWarning('camera_guard.analysis',reason,{printerId:id})}
        }finally{if(inFlight.current.get(id)===work)inFlight.current.delete(id);publish()}
      })();
    },
  };
}
