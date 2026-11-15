import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AlertTriangle, Camera, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Layers3, Maximize2, Minimize2, Monitor, Pause, Play, Printer, Thermometer, Wrench, X } from 'lucide-react';
import type { PrinterModel } from '../types';
import { PrinterCamera, hasPrinterCamera } from './PrinterCamera';
import { PrinterTemperatureSparkline } from './PrinterTemperatureSparkline';
import { FilamentSpoolThumbnail } from './FilamentSpoolThumbnail';
import { confirmedTemperature, jobFreshness, telemetryFreshness } from '../lib/printerTelemetry';
import { printerArtwork, fallbackPrinterArtwork } from '../lib/printerArtwork';
import { printerLayerLabel } from '../lib/printerFinish';
import { usePrinterVisualActivity } from '../lib/usePrinterVisualActivity';
import type { MaintenanceState } from '../lib/maintenance';
import type { FilamentInventory } from '../lib/filamentInventory';
import { readFilamentInventory, subscribeFilamentInventory } from '../lib/filamentInventoryStore';
import { tvFilamentCurrentStats, tvFilamentInventoryStats, tvFilamentInventoryClockBoundaries, tvFilamentInventoryTimeKey, type TvFilamentInventoryStats } from '../lib/tvSpotlight';
import { useLiveNow } from '../lib/liveClock';
import { createTvFullscreenSession } from '../lib/tvFullscreen';
import { TV_STATES, TV_STATE_LABELS, tvDueTasks, tvDuration, tvFreshness, tvNotices, tvPrinterState, tvProgress, tvRemainingSeconds, tvSummary } from '../lib/tvDashboard';
import './TvDashboard.css';

type CameraWatch=Record<string,{label:string;tone:'neutral'|'success'|'warning'|'danger'}>;
type Props={printers:PrinterModel[];onClose:()=>void;maintenance?:MaintenanceState;cameraWatch?:CameraWatch;onOpenCameraWatch?:()=>void};
const summaryLabels={printing:'печатает',ready:'готово',paused:'пауза',error:'ошибки',offline:'нет связи',unknown:'нет данных'};
const SLIDE_MS=10_000;

const weekNumberFormat=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});

type TvPrinterProps={printer:PrinterModel;index:number;count:number;now:number;cameras:boolean;documentVisible:boolean;inventory?:FilamentInventory;maintenance?:MaintenanceState;watch?:CameraWatch[string];failedCameraSource?:string;onCameraFailure:(source:string)=>void;onCameraRetry:()=>void};

const TvInventoryInsights=memo(function TvInventoryInsights({stats}:{stats:TvFilamentInventoryStats}){
  const weekMaximum=Math.max(1,...stats.weeklyDays.map(day=>day.grams??0));
  return <aside className="tvInsightRail" aria-label="Материал и расход за неделю">
        <section className="tvSpoolFeature" aria-label="Установленная катушка">
          <header><span>НА ПРИНТЕРЕ</span><b>{stats.materialLabel}</b></header>
          <div className="tvSpoolFeatureVisual">{stats.boundSpool?<><FilamentSpoolThumbnail spool={stats.boundSpool} diameter={stats.spoolDiameter} label={`${stats.boundSpool.material} · учтённый остаток ${stats.spoolLabel}`}/><span className="tvApprovedSpoolPending" aria-hidden="true"><Layers3/><small>{stats.spoolLabel}</small></span></>:<div className="tvNoSpool"><Layers3/><span>{stats.materialLabel==='Пластик не выбран'?'Катушка не выбрана':'Пластик из общего запаса'}</span></div>}</div>
        </section>
        <section className="tvWeekUsage" aria-label="Расход за семь дней">
          <header><span>ЗА НЕДЕЛЮ</span><strong>{stats.weeklyLabel}</strong></header>
          <div className="tvWeekChart" role="list" aria-label="Расход пластика по дням">{stats.weeklyDays.map(day=>{
            const amount=day.grams===null?'Нет данных':`${weekNumberFormat.format(day.grams)} г`;
            return <div key={day.key} className="tvWeekDay" role="listitem" data-known={day.grams===null?'false':'true'} data-today={day.today?'true':'false'} data-grams={day.grams??undefined} aria-label={`${day.key}: ${amount}`} title={`${day.key}: ${amount}`}><div className="tvWeekBarTrack"><i style={{height:`${day.grams===null?0:day.grams/weekMaximum*100}%`}}/>{day.grams===null&&<span>—</span>}</div><span>{day.label}</span></div>;
          })}</div>
          <small className="tvWeekHint">{stats.weeklyHint}</small>
        </section>
      </aside>;
});

const TvInventoryTotals=memo(function TvInventoryTotals({stats}:{stats:TvFilamentInventoryStats}){
  return <>      <div className="tvStat" data-stat="today"><span>Сегодня</span><strong>{stats.todayLabel}</strong><small>{stats.todayHint}</small></div>
      <div className="tvStat" data-stat="total"><span>Всего учтено</span><strong>{stats.totalLabel}</strong><small>{stats.totalHint}</small></div>
      <div className="tvStat tvSpoolStat" data-stat="spool" style={{'--spool-color':stats.spoolColor||'var(--tv-muted)'} as CSSProperties}><span>{stats.spoolColor&&<i className="tvSpoolChip"/>}{stats.boundSpool?'Остаток катушки':stats.materialLabel==='Пластик не выбран'?'Катушка':stats.materialLabel}</span><strong>{stats.spoolLabel}</strong><small>{stats.spoolHint}</small>{stats.spoolFraction!==undefined&&<div className="tvSpoolLevel" aria-label="Учтённый остаток катушки"><i style={{width:`${stats.spoolFraction*100}%`}}/></div>}</div></>;
});

function TvWallClock(){
  const now=useLiveNow();
  return <div className="tvDashboardClock"><strong>{new Date(now).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</strong><span>{new Date(now).toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}</span></div>;
}

function TvRemainingTime({printer}:{printer:PrinterModel}){
  const now=useLiveNow(),state=tvPrinterState(printer,now),remaining=tvRemainingSeconds(printer,now),progress=tvProgress(printer,now),active=state==='printing'||state==='paused';
  const label=remaining!==undefined?tvDuration(remaining):state==='paused'?'На паузе':active&&progress===100?'Завершение':active?'Уточняется':state==='ready'?'Готов к работе':'—';
  return <div className="tvTimeMetric"><span><Clock3/>Осталось</span><strong>{remaining!==undefined?'≈ ':''}{label}</strong>{remaining!==undefined&&<small>до ≈ {new Date(now+remaining*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</small>}</div>;
}

function TvPrinterLayer({printer}:{printer:PrinterModel}){
  const now=useLiveNow(),state=tvPrinterState(printer,now),active=state==='printing'||state==='paused',layer=active?printerLayerLabel(printer.status,now):undefined;
  return <span className="tvSpotlightLayer">{layer?<><Layers3/>{layer}</>:active?'Выполняется текущее задание':tvFreshness(printer,now).label}</span>;
}

function TvPrinterFreshness({printer}:{printer:PrinterModel}){
  const freshness=tvFreshness(printer,useLiveNow());
  return <span className={`tvFreshness ${freshness.tone}`}><i/>{freshness.label}</span>;
}

function TvCurrentFilamentStat({printer,inventory}:{printer:PrinterModel;inventory?:FilamentInventory}){
  const stats=tvFilamentCurrentStats(printer,inventory,useLiveNow());
  return <div className="tvStat" data-stat="current"><span>Эта печать</span><strong>{stats.currentLabel}</strong><small>{stats.currentHint}</small></div>;
}

/** Only clock-driven validity/calendar changes reach the heavy printer frame. */
function TvPrinterClock(props:Omit<TvPrinterProps,'now'>){
  const now=useLiveNow();
  const boundaries=useMemo(()=>tvFilamentInventoryClockBoundaries(props.printer.id,props.inventory),[props.printer.id,props.inventory]);
  const key=`${tvPrinterState(props.printer,now)}:${jobFreshness(props.printer.status,now)}:${telemetryFreshness(props.printer.status,now)}:${tvFilamentInventoryTimeKey(boundaries,now)}`;
  const frameNow=useMemo(()=>now,[props.printer,props.inventory,key]);
  return <TvPrinter {...props} now={frameNow}/>;
}

function TvFarmOverview({printers,maintenance,cameraWatch}:{printers:PrinterModel[];maintenance?:MaintenanceState;cameraWatch?:CameraWatch}){
  const now=useLiveNow(),notices=tvNotices(printers,now,maintenance),counts=tvSummary(printers,now);
  for(const printer of printers){const watch=cameraWatch?.[printer.id];if(watch&&(watch.tone==='warning'||watch.tone==='danger'))notices.push({id:`camera:${printer.id}`,printerId:printer.id,printerName:printer.name,label:'Контроль камеры',detail:watch.label,tone:watch.tone,priority:watch.tone==='danger'?0:3});}
  notices.sort((a,b)=>a.priority-b.priority);
  return <>    <section className="tvFarmStatus" aria-label="Сводка фермы">{TV_STATES.map(state=><div key={state} className={`state-${state}`}><i/><strong>{counts[state]}</strong><span>{summaryLabels[state]}</span></div>)}</section>
    <section className={`tvAttention${notices.length?'':' all-clear'}`} aria-label="Требует внимания"><div className="tvAttentionTitle">{notices.length?<AlertTriangle/>:<CheckCircle2/>}<strong>{notices.length?`Требует внимания · ${notices.length}`:'Всё спокойно'}</strong></div>{notices.length?<div className="tvNoticeList">{notices.map(notice=><article key={notice.id} className={`tone-${notice.tone}`} title={`${notice.printerName} · ${notice.label}: ${notice.detail}`}><strong><b className="tvNoticePrinterName">{notice.printerName}</b><span>{notice.label}</span></strong><p>{notice.detail}</p></article>)}</div>:<p>{printers.length?'Принтеры доступны, предупреждений нет':'Добавьте принтеры в основном окне программы'}</p>}</section></>;
}

function TvPrinterSelectors({printers,currentId,onSelect}:{printers:PrinterModel[];currentId?:string;onSelect:(id:string)=>void}){
  const now=useLiveNow();
  return <div className="tvPrinterSelectors">{printers.map((printer,index)=><button key={printer.id} aria-label={`Показать ${printer.name}`} aria-current={printer.id===currentId?'true':undefined} className={`state-${tvPrinterState(printer,now)}`} onClick={()=>onSelect(printer.id)} title={printer.name}><i className="tvPrinterSelectorDot"/><small>{String(index+1).padStart(2,'0')}</small><span className="tvPrinterSelectorName">{printer.name}</span></button>)}</div>;
}

function TvSlideCountdown({running,visible,startedAt}:{running:boolean;visible:boolean;startedAt:number}){
  const now=useLiveNow(),fraction=running?Math.max(0,Math.min(1,(now-startedAt)/SLIDE_MS)):0;
  const seconds=Math.max(1,Math.ceil((SLIDE_MS-Math.max(0,now-startedAt))/1000));
  return <div className="tvSlideCountdown" aria-label={running?`Следующий принтер через ${seconds} с`:!visible?'Показ приостановлен':'Автопоказ на паузе'}><span>{running?`${seconds} с`:'Пауза'}</span><div><i style={{width:`${fraction*100}%`}}/></div></div>;
}

const TvPrinter=memo(function TvPrinter({printer,index,count,now,cameras,documentVisible,inventory,maintenance,watch,failedCameraSource,onCameraFailure,onCameraRetry}:TvPrinterProps){
  const [cameraAttempt,setCameraAttempt]=useState(0),[readyCameraSource,setReadyCameraSource]=useState<string>();
  const cameraSource=JSON.stringify([printer.id,printer.host,printer.name,printer.webcams,printer.profile?.preset]);
  const cameraFailed=failedCameraSource===cameraSource;
  const cameraViewKey=JSON.stringify([cameraSource,cameraAttempt]);
  const state=tvPrinterState(printer,now),freshness=tvFreshness(printer,now),progress=tvProgress(printer,now),due=tvDueTasks(printer.id,maintenance);
  const activity=usePrinterVisualActivity(printer.id);
  const boundaries=useMemo(()=>tvFilamentInventoryClockBoundaries(printer.id,inventory),[printer.id,inventory]);
  const inventoryTimeKey=tvFilamentInventoryTimeKey(boundaries,now);
  const stats=useMemo(()=>tvFilamentInventoryStats(printer.id,inventory,now),[printer.id,inventory,inventoryTimeKey]);
  const active=state==='printing'||state==='paused';
  const livePrinting=state==='printing'&&freshness.tone==='live'&&telemetryFreshness(printer.status,now)==='live'&&printer.status.connectionState==='online'&&!printer.status.remoteControlSuspended;
  const temperatureAvailable=state!=='offline'&&!printer.status.remoteControlSuspended;
  const filename=active?printer.status.filename||'Текущее задание':state==='ready'?'Свободен для нового задания':state==='offline'?'Принтер сейчас недоступен':state==='error'?printer.status.message||printer.status.connectionMessage||'Проверьте принтер':'Ожидаем свежие данные';
  const hasCamera=hasPrinterCamera(printer),// Камера ходит на собственный порт принтера, а не через Moonraker: неполная
    // связь с Moonraker не повод её скрывать.
    showCamera=cameras&&hasCamera&&!cameraFailed&&state!=='offline'&&(printer.status.connectionState==='online'||printer.status.connectionState==='degraded')&&!printer.status.remoteControlSuspended;
  useEffect(()=>{if(!showCamera||!documentVisible)setReadyCameraSource(undefined)},[showCamera,documentVisible]);
  const cameraReady=showCamera&&readyCameraSource===cameraViewKey;
  const elapsed=active&&Number.isFinite(printer.status.printDuration)&&printer.status.printDuration>0?tvDuration(printer.status.printDuration):'—';
  return <article className={`tvSpotlight state-${state}`} data-printer-id={printer.id} data-live-printing={livePrinting?'true':'false'} aria-label={`${printer.name}: ${TV_STATE_LABELS[state]}`}>
    <header className="tvSpotlightHead"><div><span className="tvSpotlightEyebrow">ПРИНТЕР {String(index+1).padStart(2,'0')} / {String(count).padStart(2,'0')}</span><h2 className="tvPrinterName">{printer.name}</h2><span className="tvSpotlightConnection">{printer.host}</span></div><span className={`tvPrinterStatus state-${state}`}><i/>{printer.status.remoteControlSuspended?'Проверяем устройство':TV_STATE_LABELS[state]}</span></header>
    <div className="tvSpotlightBody">
      <div className={`tvSpotlightVisual${cameraReady?' with-camera':''}`}>
        {showCamera&&<div className="tvSpotlightCamera" data-ready={cameraReady?'true':'false'}><PrinterCamera key={cameraAttempt} printer={printer} active={documentVisible} onAvailability={available=>{if(available)setReadyCameraSource(cameraViewKey);else{setReadyCameraSource(undefined);onCameraFailure(cameraSource)}}}/></div>}
        {!cameraReady&&<>
          <div className="tvSpotlightHalo" aria-hidden="true"/>
          <svg className="tvSpotlightOrbit" viewBox="0 0 400 400" aria-hidden="true"><circle cx="200" cy="200" r="180"/><circle className="tvSpotlightOrbitValue" cx="200" cy="200" r="180" pathLength="100" strokeDasharray={`${active?progress??0:0} 100`}/></svg>
          <img className="tvSpotlightArtwork" src={printerArtwork(printer)} alt={printer.name} draggable={false} onError={event=>{if(event.currentTarget.src!==new URL(fallbackPrinterArtwork,location.href).href)event.currentTarget.src=fallbackPrinterArtwork}}/>
        </>}
        <span className="tvSpotlightVisualCaption"><i/>{cameraReady?'Камера принтера':livePrinting?'Печать идёт':state==='paused'?'Печать приостановлена':state==='ready'?'Ожидает новое задание':state==='offline'?'Нет подключения':'Проверяем состояние'}</span>
      </div>
      <div className="tvSpotlightInfo">
      <div className="tvSpotlightDetails">
        <div className="tvSpotlightJob"><span>{state==='printing'?'СЕЙЧАС ПЕЧАТАЕТ':state==='paused'?'ТЕКУЩЕЕ ЗАДАНИЕ':state==='ready'?'ПРИНТЕР ГОТОВ':'СОСТОЯНИЕ'}</span><strong title={filename}>{filename}</strong></div>
        <div className="tvSpotlightProgress"><strong>{active&&progress!==undefined?progress:'—'}{active&&progress!==undefined&&<small>%</small>}</strong><div className="tvSpotlightTiming"><TvRemainingTime printer={printer}/><div className="tvTimeMetric"><span>В работе</span><strong>{elapsed}</strong></div></div></div>
        <div className="tvProgressTrack" role="progressbar" aria-label={`Прогресс ${printer.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={active?progress:undefined}><i style={{width:`${active?progress??0:0}%`}}/></div>
        <TvPrinterLayer printer={printer}/>
        <div className="tvTemperatures">{(['nozzle','bed'] as const).map(sensor=><div key={sensor}><Thermometer/><span>{sensor==='nozzle'?'Сопло':'Стол'}</span><strong>{temperatureAvailable?confirmedTemperature(printer.status[sensor],printer.status,now):'—'}</strong><PrinterTemperatureSparkline samples={activity.samples} sensor={sensor} label={sensor==='nozzle'?'Сопло':'Стол'} fresh={livePrinting}/></div>)}</div>
      </div>
      <TvInventoryInsights stats={stats}/>
      </div>
    </div>
    <section className="tvSpotlightStats" aria-label="Статистика пластика">
      <TvCurrentFilamentStat printer={printer} inventory={inventory}/>
      <TvInventoryTotals stats={stats}/>
    </section>
    <footer className="tvSpotlightFoot"><TvPrinterFreshness printer={printer}/>{due.length>0&&<span className="tvServiceDue" title={due.map(task=>task.title).join(' · ')}><Wrench/>Обслуживание · {due.length}</span>}{watch&&<span className={`tvCameraWatch tone-${watch.tone}`}><Camera/>{watch.label}</span>}{cameras&&cameraFailed&&<button className="tvCameraRetry" onClick={()=>{setReadyCameraSource(undefined);onCameraRetry();setCameraAttempt(value=>value+1)}}>Камера недоступна · повторить</button>}{cameras&&!hasCamera&&<span className="tvNoCamera">Камера не настроена</span>}</footer>
  </article>;
});

export function TvDashboard({printers,onClose,maintenance,cameraWatch,onOpenCameraWatch}:Props){
  const root=useRef<HTMLDivElement>(null),onCloseRef=useRef(onClose),fullscreenSession=useRef<ReturnType<typeof createTvFullscreenSession>>();
  onCloseRef.current=onClose;
  const [selection,setSelection]=useState(()=>({id:printers[0]?.id,startedAt:Date.now()}));
  const [cameras,setCameras]=useState(true),[fullscreen,setFullscreen]=useState(false),[documentVisible,setDocumentVisible]=useState(!document.hidden),[fullscreenMessage,setFullscreenMessage]=useState(''),[autoplay,setAutoplay]=useState(true);
  const [inventory,setInventory]=useState<FilamentInventory>();
  const [failedCameras,setFailedCameras]=useState<Record<string,string>>({});
  const idsKey=JSON.stringify(printers.map(printer=>printer.id));
  const ids=useMemo<string[]>(()=>JSON.parse(idsKey),[idsKey]);
  const previousIndex=useRef(0),foundIndex=printers.findIndex(printer=>printer.id===selection.id);
  const currentIndex=foundIndex>=0?foundIndex:Math.min(previousIndex.current,Math.max(0,printers.length-1));
  const current=printers[currentIndex];
  useEffect(()=>{previousIndex.current=currentIndex},[currentIndex]);
  useEffect(()=>{if(!ids.includes(selection.id??''))setSelection({id:ids[Math.min(previousIndex.current,Math.max(0,ids.length-1))],startedAt:Date.now()})},[ids,selection.id]);
  useEffect(()=>{
    let mounted=true,revision=0;
    const unsubscribe=subscribeFilamentInventory(next=>{revision++;if(mounted)setInventory(next)}),initialRevision=revision;
    void readFilamentInventory().then(next=>{if(mounted&&revision===initialRevision)setInventory(next)}).catch(()=>{});
    return()=>{mounted=false;unsubscribe()};
  },[]);
  useEffect(()=>{
    if(!autoplay||!documentVisible||ids.length<2)return;
    const timer=window.setTimeout(()=>setSelection(previous=>({id:ids[(Math.max(0,ids.indexOf(previous.id??''))+1)%ids.length],startedAt:Date.now()})),Math.max(0,SLIDE_MS-(Date.now()-selection.startedAt)));
    return()=>window.clearTimeout(timer);
  },[autoplay,documentVisible,ids,selection.id,selection.startedAt]);
  useEffect(()=>{
    const previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:undefined,previousOverflow=document.body.style.overflow,element=root.current;
    document.body.style.overflow='hidden';element?.focus();
    const session=element?createTvFullscreenSession(element,{nativeWindow:isTauri()?getCurrentWindow():undefined,onChange:setFullscreen,onExternalExit:()=>onCloseRef.current()}):undefined;
    fullscreenSession.current=session;
    const visibility=()=>{const visible=!document.hidden;setDocumentVisible(visible);if(visible)setSelection(previous=>({...previous,startedAt:Date.now()}))};
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onCloseRef.current()}
      if(event.key==='Tab'&&element){const controls=Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]),[tabindex="0"]'));const first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===element)){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
    };
    document.addEventListener('visibilitychange',visibility);document.addEventListener('keydown',key,true);
    return()=>{document.removeEventListener('visibilitychange',visibility);document.removeEventListener('keydown',key,true);document.body.style.overflow=previousOverflow;fullscreenSession.current=undefined;void session?.dispose().catch(()=>{});previousFocus?.focus()};
  },[]);
  const selectPrinter=useCallback((id:string)=>setSelection({id,startedAt:Date.now()}),[]);
  const currentId=current?.id;
  const cameraAttempts=useRef<Record<string,number>>({}),cameraTimers=useRef<Record<string,number>>({});
  const scheduleCameraRetry=useCallback((source:string)=>{
    if(!currentId||cameraTimers.current[currentId])return;
    const attempt=(cameraAttempts.current[currentId]??0)+1;
    cameraAttempts.current[currentId]=attempt;
    const delay=[5_000,10_000,20_000][attempt-1]??30_000;
    cameraTimers.current[currentId]=window.setTimeout(()=>{
      delete cameraTimers.current[currentId!];
      setFailedCameras(previous=>{const next={...previous};delete next[currentId!];return next});
    },delay);
  },[currentId]);
  useEffect(()=>()=>{for(const timer of Object.values(cameraTimers.current))window.clearTimeout(timer);cameraTimers.current={};},[]);
  // Раньше любой сбой камеры помечал её сломанной навсегда: сброс существовал,
  // но нигде не вызывался, и вернуть картинку можно было только перезапуском.
  // Камера на ТВ нужна постоянно, поэтому после сбоя пробуем снова, наращивая
  // паузу, и сбрасываем отметку при возврате связи или со сменой задания.
  const cameraFailure=useCallback((source:string)=>{
    if(!currentId)return;
    setFailedCameras(previous=>previous[currentId]===source?previous:{...previous,[currentId]:source});
    scheduleCameraRetry(source);
  },[currentId]);
  const cameraRetry=useCallback(()=>{if(currentId)setFailedCameras(previous=>{const next={...previous};delete next[currentId];return next})},[currentId]);
  // Номер попытки на принтер: 5, 10, 20, дальше 30 секунд. Бесконечно частый
  // повтор на недоступной камере бессмыслен, а полный отказ недопустим.
  // Возврат связи и новое задание — новый повод показать камеру: сбрасываем
  // и счётчик попыток, и отметку о сбое.
  const currentOnline=current?current.status.connectionState==='online'||current.status.connectionState==='degraded':false;
  const currentJobKey=current?`${current.id}:${current.status.filename??''}:${current.status.jobUpdatedAt??0}`:'';
  useEffect(()=>{
    if(!currentId||!currentOnline)return;
    cameraAttempts.current[currentId]=0;
    const timer=cameraTimers.current[currentId];
    if(timer)window.clearTimeout(timer);
    delete cameraTimers.current[currentId];
    setFailedCameras(previous=>{if(!(currentId in previous))return previous;const next={...previous};delete next[currentId];return next});
  },[currentId,currentOnline,currentJobKey]);
  const move=(direction:number)=>{if(ids.length)selectPrinter(ids[(currentIndex+direction+ids.length)%ids.length])};
  const toggleFullscreen=async()=>{const session=fullscreenSession.current;if(!session)return;setFullscreenMessage('');try{await session.toggle()}catch{if(fullscreenSession.current===session)setFullscreenMessage('Полный экран недоступен. Панель занимает всё окно программы.')}};
  const slideRunning=autoplay&&documentVisible&&printers.length>1;
  return <div ref={root} className={`tvDashboard${cameras?' tvShowCameras':''}`} role="dialog" aria-modal="true" aria-label="TV-панель фермы" tabIndex={-1}>
    <header className="tvDashboardHead"><div className="tvDashboardBrand"><Monitor/><div><h1>Ферма на экране</h1><span>{printers.length} принтеров · {printers.length>1?'смена каждые 10 секунд':'TV-панель'}</span></div></div><TvWallClock/><div className="tvDashboardActions"><button aria-label="Камеры" aria-pressed={cameras} onClick={()=>setCameras(value=>!value)}><Camera/><span>{cameras?'Камеры вкл.':'Камеры выкл.'}</span></button>{onOpenCameraWatch&&<button onClick={onOpenCameraWatch}><AlertTriangle/><span>Контроль камер</span></button>}<button onClick={()=>void toggleFullscreen()} aria-label={fullscreen?'Выйти из полного экрана':'На весь экран'} title={fullscreen?'Выйти из полного экрана':'На весь экран'}>{fullscreen?<Minimize2/>:<Maximize2/>}</button><button onClick={onClose} aria-label="Закрыть TV-панель" title="Закрыть TV-панель · Esc"><X/></button></div></header>
    <TvFarmOverview printers={printers} maintenance={maintenance} cameraWatch={cameraWatch}/>
    <main className="tvSpotlightStage" aria-label="Текущий принтер">{current?<TvPrinterClock key={current.id} printer={current} index={currentIndex} count={printers.length} cameras={cameras} documentVisible={documentVisible} inventory={inventory} maintenance={maintenance} watch={cameraWatch?.[current.id]} failedCameraSource={failedCameras[current.id]} onCameraFailure={cameraFailure} onCameraRetry={cameraRetry}/>:<div className="tvDashboardEmpty"><Printer/><h2>Пока нет принтеров</h2><p>После добавления принтеров здесь появятся их состояние и статистика.</p><button onClick={onClose}>Вернуться к принтерам</button></div>}</main>
    <footer className="tvDashboardFoot"><nav className="tvSlideNav" aria-label="Принтеры">{printers.length>1&&<button aria-label="Предыдущий принтер" onClick={()=>move(-1)}><ChevronLeft/></button>}<TvPrinterSelectors printers={printers} currentId={current?.id} onSelect={selectPrinter}/>{printers.length>1&&<button aria-label="Следующий принтер" onClick={()=>move(1)}><ChevronRight/></button>}</nav><div className="tvSlidePlayback">{printers.length>1&&<><button aria-label={autoplay?'Приостановить смену принтеров':'Продолжить смену принтеров'} onClick={()=>{setAutoplay(value=>!value);setSelection(previous=>({...previous,startedAt:Date.now()}))}}>{autoplay?<Pause/>:<Play/>}</button><TvSlideCountdown running={slideRunning} visible={documentVisible} startedAt={selection.startedAt}/></>}<span className="tvEstimateNote">{fullscreenMessage||'Esc — закрыть · ≈ оценка'}</span></div></footer>
  </div>;
}
