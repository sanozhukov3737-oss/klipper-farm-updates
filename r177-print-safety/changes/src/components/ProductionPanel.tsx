import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Coins, Database, FileBox, Play, Plus, QrCode, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import type { CostSettings, GCodeMetadata, LibraryFile, PrinterModel, ScheduledJob, Spool, SpoolmanSpool } from '../types';
import type { MoonrakerClient } from '../lib/moonraker';
import { FilamentInventoryPanel } from './FilamentInventoryPanel';
import { readFilamentInventory, subscribeFilamentInventory } from '../lib/filamentInventoryStore';
import { dbGet, dbSet, migrateLocal, audit } from '../lib/db';
import { printStartOptionsFromValidation, validateGCode } from '../lib/gcodeValidation';
import { GCodeThumbnail } from './GCodeThumbnail';
import { printerIsReachable } from '../lib/printerHealth';
import { appAlert, appConfirm, appPrompt } from '../lib/appDialogs';
import { diagnosticWarning } from '../lib/diagnosticLog';
import { useModalAccessibility } from '../lib/modalAccessibility';
import styles from './ProductionPanel.module.css';
const SCHED_KEY='production.schedule', COST_KEY='production.cost', LIBRARY_KEY='production.libraryCache';
type LibraryPrinterCache={updatedAt:number;files:LibraryFile[]};
type LibraryCache={version:1;printers:Record<string,LibraryPrinterCache>};
const EMPTY_LIBRARY_CACHE:LibraryCache={version:1,printers:{}};
const normalizeLibraryCache=(value:Partial<LibraryCache>|undefined):LibraryCache=>({version:1,printers:value?.printers&&typeof value.printers==='object'?value.printers:{}});
const cachedLibraryMetadata=(metadata?:GCodeMetadata):GCodeMetadata|undefined=>metadata?{
 filename:metadata.filename,estimated_time:metadata.estimated_time,filament_total:metadata.filament_total,filament_weight_total:metadata.filament_weight_total,
 filament_type:metadata.filament_type,filament_name:metadata.filament_name,layer_height:metadata.layer_height,object_height:metadata.object_height,
 nozzle_diameter:metadata.nozzle_diameter,first_layer_extr_temp:metadata.first_layer_extr_temp,first_layer_bed_temp:metadata.first_layer_bed_temp,
 printer_vendor:metadata.printer_vendor,printer_model:metadata.printer_model,slicer:metadata.slicer,
 thumbnails:metadata.thumbnails?.slice(0,8).map(({width,height,size,thumbnail_path,relative_path})=>({width,height,size,thumbnail_path,relative_path})),
}:undefined;
const boundedLibraryFiles=(rows:LibraryFile[])=>{const output:LibraryFile[]=[];let size=2;for(const row of rows){const item={...row,metadata:cachedLibraryMetadata(row.metadata)},encoded=JSON.stringify(item).length+1;if(size+encoded>1_200_000)break;output.push(item);size+=encoded}return output};
const libraryFromCache=(cache:LibraryCache,printers:PrinterModel[])=>printers.flatMap(printer=>(cache.printers[printer.id]?.files??[]).map(file=>({...file,printerId:printer.id,printerName:printer.name}))).sort((a,b)=>a.path.localeCompare(b.path));
const productionBackgroundReady=(printer:PrinterModel)=>!printer.status.remoteControlSuspended&&printer.status.connectionState!=='degraded'&&printerIsReachable(printer.status);
const mapLimit=async<T,R>(items:T[],limit:number,worker:(item:T)=>Promise<R>)=>{const output:R[]=[];let cursor=0;await Promise.all(Array.from({length:Math.min(Math.max(1,limit),items.length)},async()=>{while(cursor<items.length){const index=cursor++;output[index]=await worker(items[index])}}));return output};
const money=(n:number,c:string)=>`${n.toFixed(2)} ${c}`;
const costMoney=(n:number,c:string)=>`${n.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})} ${c}`;
type ProductionTab='library'|'schedule'|'spools'|'spoolman'|'cost';
export function ProductionPanel({printers,clients,onClose,canOperate=true,initialTab='library',embedded=false}:{printers:PrinterModel[];clients:Map<string,MoonrakerClient>;onClose:()=>void;canOperate?:boolean;initialTab?:ProductionTab;embedded?:boolean}){
 useModalAccessibility(onClose,'.productionPanel','Производство',!embedded);
 const [tab,setTab]=useState<ProductionTab>(initialTab);
 const [library,setLibrary]=useState<LibraryFile[]>([]),[busy,setBusy]=useState(false),[usingCache,setUsingCache]=useState(false),[librarySyncedAt,setLibrarySyncedAt]=useState<number>();
 const [uploadingPrinterId,setUploadingPrinterId]=useState<string>();
 const [spools,setSpools]=useState<Spool[]>([]);
 const [schedule,setSchedule]=useState<ScheduledJob[]>([]);
 const [cost,setCost]=useState<CostSettings>({electricityPerKwh:.25,printerWatts:250,laborPerHour:0,currency:'€'});
 const [hydrated,setHydrated]=useState(false); const [spoolmanPrinter,setSpoolmanPrinter]=useState(printers[0]?.id??''),[spoolmanRows,setSpoolmanRows]=useState<SpoolmanSpool[]>([]),[spoolmanActive,setSpoolmanActive]=useState<number|null>(null),[spoolmanConnected,setSpoolmanConnected]=useState(false);
 const refreshInFlight=useRef<Promise<void>>();
 useEffect(()=>{(async()=>{setSchedule(await migrateLocal(SCHED_KEY,['klipper-schedule-v06'],[]));setCost(await migrateLocal(COST_KEY,['klipper-cost-v06'],{electricityPerKwh:.25,printerWatts:250,laborPerHour:0,currency:'€'}));setHydrated(true)})()},[]);
 useEffect(()=>{let active=true;const publish=(state:Awaited<ReturnType<typeof readFilamentInventory>>)=>{if(active)setSpools(state.spools)};const unsubscribe=subscribeFilamentInventory(publish);void readFilamentInventory().then(publish).catch(error=>diagnosticWarning('filament.cost_inventory',error));return()=>{active=false;unsubscribe()}},[]);
 useEffect(()=>{if(hydrated)dbSet(SCHED_KEY,schedule).catch(()=>{})},[schedule,hydrated]);
 useEffect(()=>{if(hydrated)dbSet(COST_KEY,cost).catch(()=>{})},[cost,hydrated]);
 const refresh=(forceMetadata=false)=>{
  if(refreshInFlight.current)return refreshInFlight.current;
  const task=(async()=>{
   setBusy(true);
   try{
    const stored=normalizeLibraryCache(await dbGet<Partial<LibraryCache>>(LIBRARY_KEY,EMPTY_LIBRARY_CACHE)),next:LibraryCache={version:1,printers:{...stored.printers}};
    const available=printers.filter(productionBackgroundReady);let refreshed=0;
    await mapLimit(available,2,async p=>{
     const c=clients.get(p.id);if(!c)return;
     try{
      const entries=await c.fileEntries(),cachedByPath=new Map<string,LibraryFile>((stored.printers[p.id]?.files??[]).map(file=>[file.path,file] as const));
      const rows=await mapLimit(entries,c.prefersConservativeBackgroundMode()?1:2,async entry=>{
       const cached=cachedByPath.get(entry.path);let metadata=cached?.metadata;
       if(forceMetadata||!metadata)try{metadata=await c.metadata(entry.path)}catch(error){diagnosticWarning('production.metadata',error,{printerId:p.id,operation:'background.metadata'})}
       return{printerId:p.id,printerName:p.name,path:entry.path,metadata};
      });
      next.printers[p.id]={updatedAt:Date.now(),files:boundedLibraryFiles(rows)};refreshed++;
     }catch(error){diagnosticWarning('production.library',error,{printerId:p.id,operation:'background.files'})}
    });
    const ids=new Set(printers.map(p=>p.id));for(const id of Object.keys(next.printers))if(!ids.has(id))delete next.printers[id];
    if(refreshed)await dbSet(LIBRARY_KEY,next).catch(()=>{});
    const out=libraryFromCache(next,printers);setLibrary(out);setUsingCache(refreshed<printers.length&&out.length>0);setLibrarySyncedAt(Math.max(0,...Object.values(next.printers).map(row=>row.updatedAt))||undefined);
   }finally{setBusy(false)}
  })();
  refreshInFlight.current=task;
  void task.finally(()=>{if(refreshInFlight.current===task)refreshInFlight.current=undefined}).catch(()=>{});
  return task;
 };
 useEffect(()=>{let active=true;(async()=>{const cached=normalizeLibraryCache(await dbGet<Partial<LibraryCache>>(LIBRARY_KEY,EMPTY_LIBRARY_CACHE));if(!active)return;const rows=libraryFromCache(cached,printers);setLibrary(rows);setUsingCache(rows.length>0);setLibrarySyncedAt(Math.max(0,...Object.values(cached.printers).map(row=>row.updatedAt))||undefined);await refresh(false)})();return()=>{active=false}},[]);
 const addSchedule=async()=>{const filename=await appPrompt('Путь G-code, например parts/case.gcode','',{title:'Новое расписание'});if(!filename)return;const dt=await appPrompt('Дата и время запуска YYYY-MM-DDTHH:MM',new Date(Date.now()+3600000).toISOString().slice(0,16),{title:'Новое расписание'});if(!dt)return;const t=new Date(dt).getTime();if(Number.isNaN(t))return await appAlert('Неверная дата',{title:'Расписание не создано'});setSchedule(x=>[...x,{id:crypto.randomUUID(),filename,scheduledAt:t,repeat:'once',enabled:true}]);audit('schedule.create',`${filename} · ${new Date(t).toISOString()}`)};
 const estimate=(f:LibraryFile)=>{const m=f.metadata;const grams=m?.filament_weight_total??0;const spool=spools.find(s=>!s.printerId||s.printerId===f.printerId);const material=spool&&spool.initialWeight?grams*(spool.price/spool.initialWeight):0;const hours=(m?.estimated_time??0)/3600;const electricity=hours*(cost.printerWatts/1000)*cost.electricityPerKwh;const labor=hours*cost.laborPerHour;return{grams,material,electricity,labor,total:material+electricity+labor}};
 const totals=useMemo(()=>library.reduce((a,f)=>{const x=estimate(f);return{grams:a.grams+x.grams,material:a.material+x.material,electricity:a.electricity+x.electricity,labor:a.labor+x.labor,total:a.total+x.total}}, {grams:0,material:0,electricity:0,labor:0,total:0}),[library,spools,cost]);
 const uploadTo=async(file:File,printerId:string)=>{const c=clients.get(printerId),printer=printers.find(p=>p.id===printerId);if(!c||!printer||!printerIsReachable(printer.status))return;setBusy(true);setUploadingPrinterId(printerId);try{await c.upload(file);await refresh(true)}catch(error){if(!(error instanceof Error&&error.name==='AbortError'))await appAlert(String(error),{title:'Загрузка не завершена'})}finally{setUploadingPrinterId(undefined);setBusy(false)}};
 const checkedStart=async(f:LibraryFile,c?:MoonrakerClient)=>{if(!(await confirmSpoolStock(f)))return;const printer=printers.find(p=>p.id===f.printerId);if(!c||!printer||!printerIsReachable(printer.status))return await appAlert('Принтер недоступен в локальной сети. Файл сохранён в кеше, запуск станет доступен после восстановления LAN.');if(printer.status.state!=='ready'||printer.status.connectionState!=='online')return await appAlert('Moonraker доступен, но Klipper ещё не готов к безопасному запуску.');const report=await validateGCode(c,printer,f.path);const text=report.issues.map(x=>`${x.level==='error'?'⛔':x.level==='warning'?'⚠':'✓'} ${x.message}`).join('\n');if(!report.ok)return await appAlert(`Запуск заблокирован:\n\n${text}`,{title:'Безопасный запуск'});if(await appConfirm(`${text}\n\nЗапустить ${f.path} на ${f.printerName}?`,{title:'Запуск печати',confirmLabel:'Запустить'})){await c.start(f.path,printStartOptionsFromValidation(report));await audit('print.validated_start',`${f.path} → ${f.printerName}`)}};
 const uploadPrinter=printers.find(printer=>printerIsReachable(printer.status)&&!printer.status.remoteControlSuspended);
 // Предупреждение о нехватке пластика: вес из G-code сравниваем с остатком катушки,
 // привязанной к принтеру. Программа уже считает оба числа, но перед стартом не сверяла —
 // нехватка обнаруживалась только на середине печати.
 const confirmSpoolStock=async(f:LibraryFile):Promise<boolean>=>{
  const needed=Number(f.metadata?.filament_weight_total??0);
  if(!(needed>0))return true;
  const spool=spools.find(s=>s.printerId===f.printerId);
  if(!spool||!(spool.remainingWeight>0))return true;
  if(spool.remainingWeight>=needed)return true;
  return await appConfirm(
   `На катушке ${spool.material} осталось ${Math.round(spool.remainingWeight)} г, а для печати нужно ${Math.round(needed)} г. Начать всё равно?`,
   {title:'Недостаточно пластика'});
 };

 const content = <section className={embedded ? `productionPanel ${styles.page}` : "panel productionPanel"} aria-label={embedded ? "Файлы и производство" : undefined} role={embedded ? "region" : undefined}>{!embedded && <div className="panelHead"><div><h2>Файлы и производство</h2><p>Библиотека G-code, расписание, запас пластика и себестоимость.</p></div><button className="round" onClick={onClose}><X/></button></div>}
 <nav className="prodTabs"><button className={tab==='library'?'active':''} onClick={()=>setTab('library')}><FileBox/>Библиотека</button><button className={tab==='schedule'?'active':''} onClick={()=>setTab('schedule')}><CalendarDays/>Планировщик</button><button className={tab==='spools'?'active':''} onClick={()=>setTab('spools')}><QrCode/>Пластик</button><button className={tab==='spoolman'?'active':''} onClick={()=>setTab('spoolman')}><Database/>Spoolman</button><button className={tab==='cost'?'active':''} onClick={()=>setTab('cost')}><Coins/>Себестоимость</button></nav>
 {tab==='library'&&<><div className="prodToolbar"><div><button disabled={busy} onClick={()=>refresh(true)}><RefreshCw className={busy?'spin':''}/>{busy?'Обновление…':'Обновить'}</button>{uploadPrinter&&<label className="button"><Upload/>Загрузить на {uploadPrinter.name}<input hidden disabled={!!uploadingPrinterId} type="file" accept=".gcode,.gco" onChange={e=>e.target.files?.[0]&&uploadTo(e.target.files[0],uploadPrinter.id)}/></label>}{uploadingPrinterId&&<button className="danger" onClick={()=>clients.get(uploadingPrinterId)?.cancelUpload()}><X/>Отменить загрузку</button>}</div><span className={usingCache?'prodCacheState cached':'prodCacheState live'}>{usingCache?'Локальный кеш':'LAN синхронизирован'}{librarySyncedAt?` · ${new Date(librarySyncedAt).toLocaleTimeString('ru-RU')}`:''} · {library.length} файлов · {totals.grams.toFixed(0)} г</span></div><div className="libraryGrid">{library.map(f=>{const x=estimate(f),c=clients.get(f.printerId),printer=printers.find(p=>p.id===f.printerId),reachable=!!printer&&printerIsReachable(printer.status)&&!printer.status.remoteControlSuspended;return <article className={reachable?'live':'cached'} key={`${f.printerId}:${f.path}`}><div className="libThumb"><GCodeThumbnail client={reachable?c:undefined} filename={f.path} metadata={f.metadata} fallback={<FileBox/>} alt={`Предпросмотр ${f.path}`}/></div><div className="libFileInfo"><b title={f.path}>{f.path.split('/').filter(Boolean).at(-1)??f.path}</b><span>{f.printerName}{reachable?' · LAN':' · локальный кеш'}</span><small>{f.metadata?.filament_type??'—'} · Ø{f.metadata?.nozzle_diameter??'?'} · {f.metadata?.estimated_time?`${(f.metadata.estimated_time/3600).toFixed(1)} ч`:'время неизвестно'}</small></div><strong className="libFileCost" title="Оценочная себестоимость">{f.metadata?.estimated_time||f.metadata?.filament_weight_total?money(x.total,cost.currency):'—'}</strong><div className="libActions"><button disabled={!reachable||printer?.status.state!=='ready'||printer?.status.connectionState!=='online'} aria-label={`Проверить и запустить ${f.path}`} title={reachable?'Проверить и запустить по локальной сети':'Доступно после восстановления локальной сети'} onClick={()=>checkedStart(f,c)}><Play/></button><button disabled={!reachable} className="danger" aria-label={`Удалить ${f.path}`} title={reachable?'Удалить с принтера':'Кеш доступен только для просмотра'} onClick={async()=>{if(reachable&&await appConfirm(`Удалить ${f.path}?`,{title:'Удаление G-code',confirmLabel:'Удалить',danger:true})){await c?.deleteFile(f.path);await refresh(true)}}}><Trash2/></button></div></article>})}{!library.length&&!busy&&<div className="emptySmart productionEmpty" role="status"><FileBox/><div><b>Нет файлов G-code</b><span>Файлы G-code не найдены ни в Moonraker, ни в локальном кеше.</span></div></div>}</div></>}
 {tab==='schedule'&&<><div className="prodToolbar"><button className="primary" onClick={addSchedule}><Plus/>Запланировать</button><span>Запуск выполняется, когда приложение открыто и принтер доступен.</span></div><div className="scheduleList">{[...schedule].sort((a,b)=>a.scheduledAt-b.scheduledAt).map(j=><div key={j.id}><input type="checkbox" checked={j.enabled} onChange={e=>setSchedule(x=>x.map(q=>q.id===j.id?{...q,enabled:e.target.checked}:q))}/><div><b>{j.filename}</b><span>{new Date(j.scheduledAt).toLocaleString()} · {j.printerId?printers.find(p=>p.id===j.printerId)?.name:'любой READY'}</span></div><select value={j.printerId??''} onChange={e=>setSchedule(x=>x.map(q=>q.id===j.id?{...q,printerId:e.target.value||undefined}:q))}><option value="">Любой принтер</option>{printers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><select value={j.repeat} onChange={e=>setSchedule(x=>x.map(q=>q.id===j.id?{...q,repeat:e.target.value as ScheduledJob['repeat']}:q))}><option value="once">Один раз</option><option value="daily">Каждый день</option><option value="weekly">Каждую неделю</option></select><button className="danger" onClick={()=>setSchedule(x=>x.filter(q=>q.id!==j.id))}><Trash2/></button></div>)}</div></>}
 {tab==='spools'&&<FilamentInventoryPanel printers={printers} canOperate={canOperate}/>}

 {tab==='spoolman'&&<>
  <div className="prodToolbar">
   <select aria-label="Принтер Spoolman" value={spoolmanPrinter} onChange={e=>setSpoolmanPrinter(e.target.value)}>{printers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
   <button onClick={async()=>{
    const c=clients.get(spoolmanPrinter);if(!c)return;
    try{
     const st=await c.spoolmanStatus();
     setSpoolmanConnected(!!st.spoolman_connected);
     setSpoolmanActive(st.spool_id??null);
     setSpoolmanRows(await c.spoolmanSpools());
    }catch(e){await appAlert(`Spoolman недоступен: ${String(e)}`,{title:'Spoolman'})}
   }}><RefreshCw/>Обновить Spoolman</button>
   <span>{spoolmanConnected?'● подключён':'○ не подключён'} · активная катушка: {spoolmanActive??'нет'}</span>
  </div>
  <div className="spoolmanGrid">
   {spoolmanRows.map(s=><article key={s.id}>
    <div className="spoolColor" style={{background:s.filament?.color_hex?`#${s.filament.color_hex}`:undefined}}/>
    <div><b>#{s.id} {s.filament?.vendor?.name??''} {s.filament?.name??''}</b><span>{s.filament?.material??'—'} · остаток {(s.remaining_weight??0).toFixed(0)} г</span></div>
    <button className={spoolmanActive===s.id?'primary':''} onClick={async()=>{
     const c=clients.get(spoolmanPrinter);if(!c)return;
     const nextSpool=spoolmanActive===s.id?null:s.id;
     await c.setActiveSpool(nextSpool);
     setSpoolmanActive(nextSpool);
     await audit('spoolman.active',`printer=${spoolmanPrinter} spool=${s.id}`);
    }}>{spoolmanActive===s.id?'Активна':'Использовать'}</button>
   </article>)}
   {!spoolmanRows.length&&<div className="emptySmart">Настройте [spoolman] в moonraker.conf и нажмите «Обновить Spoolman».</div>}
  </div>
 </>}
 {tab==='cost'&&<div className={styles.costLayout}>
  <section className={styles.costSettings} aria-label="Параметры расчёта себестоимости">
   <header className={styles.costHeading}><h3>Параметры расчёта</h3><p>Общие тарифы для файлов в библиотеке.</p></header>
   <div className={styles.costFields}>
    <label className={styles.costField}><span>Электричество</span><div className={styles.costInput}><input aria-label="Электричество за кВт⋅ч" type="number" step="0.01" value={cost.electricityPerKwh} onChange={e=>setCost({...cost,electricityPerKwh:+e.target.value})}/><span>{cost.currency} / кВт⋅ч</span></div></label>
    <label className={styles.costField}><span>Средняя мощность принтера</span><div className={styles.costInput}><input aria-label="Средняя мощность принтера, Вт" type="number" value={cost.printerWatts} onChange={e=>setCost({...cost,printerWatts:+e.target.value})}/><span>Вт</span></div></label>
    <label className={styles.costField}><span>Работа оператора</span><div className={styles.costInput}><input aria-label="Работа оператора за час" type="number" step="0.01" value={cost.laborPerHour} onChange={e=>setCost({...cost,laborPerHour:+e.target.value})}/><span>{cost.currency} / ч</span></div></label>
    <label className={styles.costField}><span>Валюта</span><div className={styles.costInput}><input aria-label="Валюта" value={cost.currency} onChange={e=>setCost({...cost,currency:e.target.value})}/></div></label>
   </div>
   <p className={styles.costHint}>Сумма пересчитывается при изменении параметров.</p>
  </section>
  <section className={styles.costSummary} aria-label="Стоимость текущей библиотеки">
   <header className={styles.costTotalHeading}><span className={styles.costIcon}><Coins aria-hidden="true"/></span><div><h3>Стоимость библиотеки</h3><p>{library.length} файлов · {totals.grams.toLocaleString('ru-RU',{maximumFractionDigits:0})} г пластика</p></div></header>
   <div className={styles.costTotal}><strong>{totals.total.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong><span>{cost.currency}</span></div>
   <dl className={styles.costBreakdown}><div><dt>Пластик</dt><dd>{costMoney(totals.material,cost.currency)}</dd></div><div><dt>Электричество</dt><dd>{costMoney(totals.electricity,cost.currency)}</dd></div><div><dt>Работа оператора</dt><dd>{costMoney(totals.labor,cost.currency)}</dd></div></dl>
   <p className={styles.costHint}>Оценка для всех файлов библиотеки, а не фактические расходы.</p>
  </section>
  <p className={styles.costExplanation}>Пластик — по весу из файла и цене назначенной катушки. Электричество и работа — по расчётному времени печати.</p>
 </div>}
 </section>;
 return embedded ? content : <div className="modalBackdrop">{content}</div>;
}
