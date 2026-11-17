import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, GripVertical, ListPlus, Pause, Play, RefreshCw, ShieldAlert, Trash2, Upload, X } from 'lucide-react';
import type { GCodeMetadata, PrinterModel, QueueJob, QueueStatus } from '../types';
import type { MoonrakerClient } from '../lib/moonraker';
import { validateGCode } from '../lib/gcodeValidation';
import { metadataCompatibility } from '../lib/gcodeCompatibility';
import { audit, dbGet, dbSet } from '../lib/db';
import { GCodeThumbnail } from './GCodeThumbnail';
import { appAlert } from '../lib/appDialogs';
import { diagnosticWarning } from '../lib/diagnosticLog';
import { useModalAccessibility } from '../lib/modalAccessibility';
import { FILE_PAGE_SIZE, ListPagination } from './ListPagination';

type Row={printer:PrinterModel;queue:QueueStatus};
const AUTO_KEY='production.queueAutomation';

export function QueuePanel({printers,clients,canOperate,onClose}:{printers:PrinterModel[];clients:Map<string,MoonrakerClient>;canOperate:boolean;onClose:()=>void}){
 useModalAccessibility(onClose,'.queuePanel','Очередь фермы');
 const [rows,setRows]=useState<Row[]>([]),[target,setTarget]=useState(printers[0]?.id??''),[filter,setFilter]=useState('all'),[busy,setBusy]=useState(false),[meta,setMeta]=useState<Record<string,GCodeMetadata>>({}),[auto,setAuto]=useState<Record<string,boolean>>({}),[hydrated,setHydrated]=useState(false),[drag,setDrag]=useState<{printerId:string;jobId:string}>(),[progress,setProgress]=useState<number>();
 const autoStarting=useRef(new Set<string>());
 const uploadClient=useRef<MoonrakerClient>();
 const autoCooldown=useRef(new Map<string,number>()),refreshInFlight=useRef(new Map<string,Promise<void>>()),mounted=useRef(true),mountEpoch=useRef(0);
 const [pages,setPages]=useState<Record<string,number>>({});
 const queueElements=useRef(new Map<string,HTMLElement>());
 const printersRef=useRef(printers),clientsRef=useRef(clients),metaRef=useRef(meta),autoRef=useRef(auto),rowsRef=useRef(rows),busyRef=useRef(busy);
 printersRef.current=printers;clientsRef.current=clients;metaRef.current=meta;autoRef.current=auto;rowsRef.current=rows;busyRef.current=busy;
 // Each printer publishes its queue independently. Metadata must never gate
 // another printer's status or make the close/filter controls wait.
 const refresh=useCallback(async(printerId?:string)=>{
  const epoch=mountEpoch.current,tasks:Promise<void>[]=[];
  for(const printer of printersRef.current){
   if(printerId&&printer.id!==printerId)continue;
   const client=clientsRef.current.get(printer.id);
   if(!client||refreshInFlight.current.has(printer.id))continue;
   const task=(async()=>{
    let queue:QueueStatus;
    try{queue=await client.queueStatus()}
    catch(error){diagnosticWarning('queue.refresh',error,{printerId:printer.id,operation:'background.queue'});queue={queued_jobs:[],queue_state:'unavailable'}}
    if(!mounted.current||epoch!==mountEpoch.current||clientsRef.current.get(printer.id)!==client)return;
    setRows(current=>{
     const next=new Map(current.map(row=>[row.printer.id,row]));next.set(printer.id,{printer,queue});
     return printersRef.current.flatMap(value=>next.has(value.id)?[next.get(value.id)!]:[]);
    });
   })();
   refreshInFlight.current.set(printer.id,task);tasks.push(task);
   void task.finally(()=>{if(refreshInFlight.current.get(printer.id)===task)refreshInFlight.current.delete(printer.id)}).catch(()=>{});
  }
  await Promise.all(tasks);
 },[]);
 useEffect(()=>{
  mounted.current=true;let stopped=false,timer:number|undefined;
  const loop=()=>{void refresh();if(!stopped)timer=window.setTimeout(loop,8_000)};
  loop();
  void dbGet<Record<string,boolean>>(AUTO_KEY,{}).then(settings=>{if(stopped)return;setAuto(settings);setHydrated(true)});
  return()=>{stopped=true;mounted.current=false;mountEpoch.current++;refreshInFlight.current.clear();if(timer)window.clearTimeout(timer)}
 },[refresh]);
 useEffect(()=>{if(hydrated)dbSet(AUTO_KEY,auto).catch(()=>{})},[auto,hydrated]);
 useEffect(()=>{
  if(!canOperate)return;let stopped=false,timer:number|undefined,inFlight=false;
  const tick=async()=>{
   if(inFlight||busyRef.current){if(!stopped)timer=window.setTimeout(tick,4_000);return}
   inFlight=true;
   try{
    const livePrinters=new Map(printersRef.current.map(printer=>[printer.id,printer] as const));
    for(const storedRow of rowsRef.current){
     const printer=livePrinters.get(storedRow.printer.id)??storedRow.printer,row={...storedRow,printer};
     if(!autoRef.current[printer.id]||printer.status.state!=='ready'||printer.status.connectionState!=='online'||!row.queue.queued_jobs.length||autoStarting.current.has(printer.id)||(autoCooldown.current.get(printer.id)??0)>Date.now())continue;
     const client=clientsRef.current.get(printer.id),next=row.queue.queued_jobs[0];if(!client)continue;
     autoStarting.current.add(printer.id);
     try{
      const report=await validateGCode(client,printer,next.filename);
      if(!report.ok){setAuto(value=>({...value,[printer.id]:false}));await audit('queue.auto_blocked',`${next.filename} → ${printer.name} · ${report.issues.filter(issue=>issue.level==='error').map(issue=>issue.message).join('; ')}`);continue}
      const currentPrinter=printersRef.current.find(value=>value.id===printer.id),confirmed=await client.queueStatus();
      if(!autoRef.current[printer.id]||busyRef.current||!currentPrinter||currentPrinter.status.state!=='ready'||currentPrinter.status.connectionState!=='online'||confirmed.queued_jobs[0]?.job_id!==next.job_id||!await client.isReady())continue;
      await client.queueStart();autoCooldown.current.set(printer.id,Date.now()+10_000);await audit('queue.auto_start',`${next.filename} → ${printer.name}`);await refresh(printer.id);
     }catch(error){diagnosticWarning('queue.auto_start',error,{printerId:printer.id,operation:'control.queue_start'})}finally{autoStarting.current.delete(printer.id)}
    }
   }finally{inFlight=false;if(!stopped)timer=window.setTimeout(tick,4_000)}
  };
  timer=window.setTimeout(tick,4_000);return()=>{stopped=true;if(timer)window.clearTimeout(timer)}
 },[canOperate,refresh]);
 const uploadQueue=async(file:File)=>{const c=clients.get(target),p=printers.find(x=>x.id===target);if(!c||!p||!canOperate||busyRef.current)return;busyRef.current=true;uploadClient.current=c;setBusy(true);setProgress(0);try{const path=await c.upload(file,setProgress),report=await validateGCode(c,p,path);if(!report.ok){await appAlert(`Файл загружен, но не добавлен в очередь:\n${report.issues.map(x=>x.message).join('\n')}`,{title:'Проверка G-code'});return}await c.enqueue([path]);await audit('print.queue_add',`${path} → ${p.name}`);await refresh(p.id);if(report.metadata)setMeta(x=>({...x,[`${target}:${path}`]:report.metadata!}))}catch(error){if(!(error instanceof Error&&error.name==='AbortError'))await appAlert(String(error),{title:'Загрузка не завершена'});}finally{if(uploadClient.current===c)uploadClient.current=undefined;busyRef.current=false;setBusy(false);window.setTimeout(()=>setProgress(undefined),700)}};
 const reorder=async(printer:PrinterModel,jobs:QueueJob[],sourceId:string,targetIndex:number)=>{if(!canOperate||busyRef.current)return;const sourceIndex=jobs.findIndex(job=>job.job_id===sourceId);if(sourceIndex<0||sourceIndex===targetIndex)return;const ordered=[...jobs],[moved]=ordered.splice(sourceIndex,1);ordered.splice(targetIndex,0,moved);busyRef.current=true;setBusy(true);try{await clients.get(printer.id)?.enqueue(ordered.map(job=>job.filename),true);await audit('queue.reorder',`${printer.name} · ${ordered.map(job=>job.filename).join(' → ')}`);await refresh(printer.id)}finally{busyRef.current=false;setBusy(false)}};
 const startQueue=async(printer:PrinterModel,queue:QueueStatus)=>{if(!canOperate||!queue.queued_jobs.length||busyRef.current)return;const client=clients.get(printer.id),next=queue.queued_jobs[0];if(!client)return;busyRef.current=true;setBusy(true);try{const report=await validateGCode(client,printer,next.filename);if(!report.ok){await audit('queue.start_blocked',`${next.filename} → ${printer.name}`);await appAlert(`Запуск очереди заблокирован:\n${report.issues.filter(issue=>issue.level==='error').map(issue=>issue.message).join('\n')}`,{title:'Безопасный запуск'});return}const live=printersRef.current.find(value=>value.id===printer.id),confirmed=await client.queueStatus();if(!live||live.status.state!=='ready'||live.status.connectionState!=='online'||confirmed.queued_jobs[0]?.job_id!==next.job_id)throw new Error('Состояние принтера или очереди изменилось — обновите очередь');await client.queueStart();await audit('queue.manual_start',`${next.filename} → ${printer.name}`);await refresh(printer.id)}catch(error){await appAlert(String(error),{title:'Очередь не запущена'})}finally{busyRef.current=false;setBusy(false)}};
 const pauseQueue=async(printerId:string)=>{if(!canOperate||busyRef.current)return;const client=clients.get(printerId);if(!client)return;busyRef.current=true;setBusy(true);try{await client.queuePause();await refresh(printerId)}catch(error){await appAlert(String(error),{title:'Очередь не приостановлена'})}finally{busyRef.current=false;setBusy(false)}};
 const removeJob=async(printerId:string,jobId:string)=>{if(!canOperate||busyRef.current)return;const client=clients.get(printerId);if(!client)return;busyRef.current=true;setBusy(true);try{await client.queueRemove([jobId]);await refresh(printerId)}catch(error){await appAlert(String(error),{title:'Задание не удалено'})}finally{busyRef.current=false;setBusy(false)}};
 const drop=(event:DragEvent,printer:PrinterModel,jobs:QueueJob[],index:number)=>{event.preventDefault();if(drag?.printerId===printer.id)void reorder(printer,jobs,drag.jobId,index);setDrag(undefined)};
 const liveRows=useMemo(()=>rows.map(row=>({...row,printer:printers.find(printer=>printer.id===row.printer.id)??row.printer})),[rows,printers]);
 const shown=useMemo(()=>filter==='all'?liveRows:liveRows.filter(row=>row.printer.id===filter),[liveRows,filter]);
 const pageFor=(printerId:string,count:number)=>Math.min(pages[printerId]??0,Math.max(0,Math.ceil(count/FILE_PAGE_SIZE)-1));
 // Only the currently displayed jobs need metadata. Abort queued reads when
 // changing pages or closing; validation before every start remains unchanged.
 const metadataKey=JSON.stringify(shown.map(({printer,queue})=>[printer.id,queue.queued_jobs.slice(pageFor(printer.id,queue.queued_jobs.length)*FILE_PAGE_SIZE,(pageFor(printer.id,queue.queued_jobs.length)+1)*FILE_PAGE_SIZE).map(job=>job.filename)]));
 useEffect(()=>{
  const controller=new AbortController();
  const requested=JSON.parse(metadataKey) as Array<[string,string[]]>;
  for(const [printerId,filenames] of requested){
   const client=clientsRef.current.get(printerId);if(!client)continue;
   void (async()=>{
    for(const filename of new Set(filenames)){
     if(controller.signal.aborted)return;
     const key=`${printerId}:${filename}`;if(metaRef.current[key])continue;
     const metadata=await client.metadata(filename,controller.signal).catch(()=>undefined);
     if(controller.signal.aborted)return;
     if(metadata)setMeta(current=>({...current,[key]:metadata}));
    }
   })();
  }
  return()=>controller.abort('Страница очереди закрыта');
 },[metadataKey]);

 return <div className="modalBackdrop"><section className="panel queuePanel"><div className="panelHead"><div><h2>Очередь фермы</h2><p>Перетаскивание, проверка совместимости и автоматический запуск на свободном принтере</p></div><div className="headerActions"><button onClick={()=>void refresh()}><RefreshCw/>Обновить</button><button className="round" aria-label="Закрыть" onClick={onClose}><X/></button></div></div>
 <div className="toolPanelBody">
  <div className="queueUpload"><div><select aria-label="Принтер для загрузки" value={target} disabled={!!uploadClient.current} onChange={e=>setTarget(e.target.value)}>{printers.map(p=><option key={p.id} value={p.id}>{p.name} · {p.host}</option>)}</select><select aria-label="Фильтр принтеров" value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">Все принтеры</option>{printers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div><label className={`button primary ${!canOperate?'disabled':''}`}><Upload/>{busy?'Загрузка...':'Загрузить в очередь'}<input hidden disabled={busy||!canOperate} type="file" accept=".gcode,.gco" onChange={e=>e.target.files?.[0]&&uploadQueue(e.target.files[0])}/></label>{progress!==undefined&&<span className="queueUploadProgress"><i style={{width:`${progress}%`}}/>{progress}%{uploadClient.current&&<button type="button" title="Отменить загрузку" onClick={()=>uploadClient.current?.cancelUpload()}><X/></button>}</span>}</div>
  <div className="queueRows">{shown.map(({printer,queue})=><article key={printer.id} className="queuePrinter" ref={element=>{if(element)queueElements.current.set(printer.id,element);else queueElements.current.delete(printer.id)}}><div className="queueHead"><div><strong>{printer.name}</strong><span>{queue.queued_jobs.length} заданий · очередь {queue.queue_state}</span></div><div><label className="queueAuto"><input type="checkbox" disabled={!canOperate} checked={!!auto[printer.id]} onChange={event=>setAuto(value=>({...value,[printer.id]:event.target.checked}))}/> Автозапуск</label><button disabled={!canOperate||busy||!queue.queued_jobs.length} title="Проверить первое задание и запустить" aria-label="Проверить первое задание и запустить" onClick={()=>startQueue(printer,queue)}><Play/></button><button title="Приостановить очередь" aria-label="Приостановить очередь" disabled={!canOperate||busy} onClick={()=>pauseQueue(printer.id)}><Pause/></button></div></div>{queue.queued_jobs.length?queue.queued_jobs.slice(pageFor(printer.id,queue.queued_jobs.length)*FILE_PAGE_SIZE,(pageFor(printer.id,queue.queued_jobs.length)+1)*FILE_PAGE_SIZE).map((job,pageIndex)=>{const index=pageFor(printer.id,queue.queued_jobs.length)*FILE_PAGE_SIZE+pageIndex;const metadata=meta[`${printer.id}:${job.filename}`],compat=metadataCompatibility(printer,metadata);return <div className="queueJob" draggable={canOperate} key={job.job_id} onDragStart={()=>setDrag({printerId:printer.id,jobId:job.job_id})} onDragOver={event=>event.preventDefault()} onDrop={event=>drop(event,printer,queue.queued_jobs,index)}><GripVertical className="queueGrip"/><div className="queueThumb"><GCodeThumbnail client={clients.get(printer.id)} filename={job.filename} metadata={metadata} fallback={<ListPlus/>} alt={`Предпросмотр ${job.filename}`}/></div><div><b>{index+1}. {job.filename}</b><span>{metadata?.filament_type??'G-code'} {metadata?.estimated_time?`· ~${Math.round(metadata.estimated_time/60)} мин`:''}</span><small className={`queueCompat ${compat.level}`}>{compat.level==='compatible'?<CheckCircle2/>:<ShieldAlert/>}{compat.level==='compatible'?'Совместим':compat.level==='blocked'?'Заблокирован':'Требует проверки'}</small></div><div className="queueOrder"><button disabled={!canOperate||index===0} onClick={()=>reorder(printer,queue.queued_jobs,job.job_id,index-1)}><ArrowUp/></button><button disabled={!canOperate||index===queue.queued_jobs.length-1} onClick={()=>reorder(printer,queue.queued_jobs,job.job_id,index+1)}><ArrowDown/></button><button className="danger" disabled={!canOperate||busy} onClick={()=>removeJob(printer.id,job.job_id)}><Trash2/></button></div></div>}):<p className="queueEmpty">{queue.queue_state==='unavailable'?'Очередь недоступна. Обновите данные после восстановления связи.':'Очередь пуста. Выберите этот принтер и добавьте G-code.'}</p>}<ListPagination count={queue.queued_jobs.length} page={pageFor(printer.id,queue.queued_jobs.length)} onPageChange={page=>{setPages(current=>({...current,[printer.id]:page}));queueElements.current.get(printer.id)?.scrollIntoView({block:'start'})}} label={`Страницы очереди ${printer.name}`}/></article>)}{!shown.length&&<div className="queueEmptyState"><ListPlus/><b>{printers.length?'Ожидание данных очередей':'Добавьте принтер'}</b><span>{printers.length?'Здесь появятся задания после получения данных от принтеров. Данные можно запросить кнопкой «Обновить».':'После подключения принтера здесь можно будет управлять его очередью.'}</span></div>}</div>
 </div></section></div>;
}
