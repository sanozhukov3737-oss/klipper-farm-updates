import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Fan,
  FileCode2,
  FolderOpen,
  Gauge,
  Home,
  LayoutDashboard,
  Minus,
  Pause,
  Play,
  Plus,
  Printer as PrinterIcon,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Thermometer,
  X,
  Zap,
} from 'lucide-react';
import type { GCodeMetadata, HistoryJob, PrinterModel } from '../types';
import type { MoonrakerClient } from '../lib/moonraker';
/** Диагностика приходит из Rust как JSON: подпись собираем по проверенным полям,
    иначе повреждённый ответ показал бы «undefined мс». */
const diagnosticLabel=(value:unknown)=>{
  const record=value&&typeof value==='object'?value as Record<string,unknown>:{};
  const error=typeof record.error==='string'&&record.error?record.error:undefined;
  const latency=typeof record.latency==='number'&&Number.isFinite(record.latency)?record.latency:undefined;
  return error??(latency===undefined?'Moonraker отвечает':'Moonraker · '+latency+' мс');
};
import { printerDisplayName } from '../lib/printerName';
import { GCodePreview } from './GCodePreview';
import { JobPartPreview } from './JobPartPreview';
import { configuredPrinterCamera, isCrealityCamera, isK1C2025, isK1Max, PrinterCamera } from './PrinterCamera';
import { fallbackPrinterArtwork, printerArtwork } from '../lib/printerArtwork';
import { printerConnectionReasonLabel, printerIsConnecting, printerIsReachable, printerWorkingChannel } from '../lib/printerHealth';
import { printerHasActiveJob } from '../lib/printerJob';
import { appConfirm } from '../lib/appDialogs';
import { compactTelemetryLabel, confirmedTemperature, jobFreshness, telemetryFreshness, telemetryLabel } from '../lib/printerTelemetry';
import { useLiveNow } from '../lib/liveClock';
import { showAppNotification } from '../lib/appNotifications';
import { PrinterLightControl } from './PrinterLightControl';
import type { PrinterLightState } from '../lib/printerLight';
import { afterPanelPaint } from '../lib/afterPanelPaint';
import utilityStyles from './ControlPanelUtilities.module.css';

type DetailDestination='dashboard'|'printers'|'files';
type BottomTab='console'|'objects'|'history';

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const duration=(seconds=0)=>{
  const total=Math.max(0,Math.round(seconds));
  if(!total)return '—';
  const hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60);
  return hours?`${hours}ч ${String(minutes).padStart(2,'0')}м`:`${Math.max(1,minutes)} мин`;
};

export function ControlPanel({
  printer,
  client,
  onClose,
  onNavigate,
  onSettings,
}:{
  printer:PrinterModel;
  client?:MoonrakerClient;
  onClose:()=>void;
  onNavigate?:(destination:DetailDestination)=>void;
  onSettings?:()=>void;
}){
  const now=useLiveNow();
  const [step,setStep]=useState(10);
  const [speed,setSpeed]=useState(Math.round((printer.status.speedFactor??1)*100));
  const [fan,setFan]=useState(Math.round((printer.status.fanSpeed??0)*100));
  const [fanBusy,setFanBusy]=useState(false);
  const [fanFeedback,setFanFeedback]=useState('');
  const fanEditing=useRef(false),fanDirty=useRef(false),fanLock=useRef(false),fanGeneration=useRef(0);
  const fanObserved=useRef(printer.status.fanSpeed);
  const [light,setLight]=useState<PrinterLightState>();
  const [lightBusy,setLightBusy]=useState(false);
  const [lightRefresh,setLightRefresh]=useState(0);
  const lightLock=useRef(false),lightEpoch=useRef(0),lightRevision=useRef(0);
  const [nozzleTarget,setNozzleTarget]=useState(Math.round(printer.status.nozzleTarget));
  const [bedTarget,setBedTarget]=useState(Math.round(printer.status.bedTarget));
  const [macros,setMacros]=useState<string[]>([]);
  const [history,setHistory]=useState<HistoryJob[]>([]);
  const [historyLoading,setHistoryLoading]=useState(false);
  const [historyError,setHistoryError]=useState('');
  const [error,setError]=useState('');
  const [consoleLine,setConsoleLine]=useState('');
  const [consoleLines,setConsoleLines]=useState<string[]>([]);
  const [bottomTab,setBottomTab]=useState<BottomTab>('console');
  const [thumbnail,setThumbnail]=useState<string>();
  const [thumbnailLoading,setThumbnailLoading]=useState(false);
  const [metadata,setMetadata]=useState<GCodeMetadata>();
  const [diagnostics,setDiagnostics]=useState<unknown>();
  const [windowVisible,setWindowVisible]=useState(()=>!document.hidden);
  const [paintedPrinter,setPaintedPrinter]=useState<string>();
  const detailReady=paintedPrinter===printer.id;
  useEffect(()=>afterPanelPaint(()=>setPaintedPrinter(printer.id)),[printer.id]);

  useEffect(()=>{setSpeed(Math.round((printer.status.speedFactor??1)*100))},[printer.status.speedFactor]);
  useEffect(()=>{
    fanObserved.current=printer.status.fanSpeed;
    if(!fanEditing.current&&!fanLock.current)setFan(Math.round((printer.status.fanSpeed??0)*100));
  },[printer.status.fanSpeed]);
  useEffect(()=>{
    fanGeneration.current++;fanEditing.current=false;fanDirty.current=false;fanLock.current=false;
    fanObserved.current=printer.status.fanSpeed;
    setFan(Math.round((printer.status.fanSpeed??0)*100));setFanBusy(false);setFanFeedback('');
    return()=>{fanGeneration.current++;fanEditing.current=false;fanDirty.current=false};
  },[printer.id,printer.host,client]);
  useEffect(()=>{setNozzleTarget(Math.round(printer.status.nozzleTarget))},[printer.status.nozzleTarget]);
  useEffect(()=>{setBedTarget(Math.round(printer.status.bedTarget))},[printer.status.bedTarget]);
  useEffect(()=>{
    setMacros([]);
    if(!client||!detailReady)return;
    const controller=new AbortController();
    client.macros(controller.signal).then(value=>{if(!controller.signal.aborted)setMacros(value)}).catch(()=>{});
    return()=>controller.abort();
  },[client,detailReady]);
  useEffect(()=>{
    setHistory([]);
    setHistoryLoading(false);setHistoryError('');
    if(!client||!detailReady||bottomTab!=='history')return;
    const controller=new AbortController();
    setHistoryLoading(true);
    client.history(30,controller.signal).then(value=>{if(!controller.signal.aborted)setHistory(value)}).catch(reason=>{if(!controller.signal.aborted)setHistoryError(String(reason instanceof Error?reason.message:reason))}).finally(()=>{if(!controller.signal.aborted)setHistoryLoading(false)});
    return()=>controller.abort();
  },[client,detailReady,bottomTab]);
  useEffect(()=>{
    const controller=new AbortController();
    setThumbnail(undefined);
    setMetadata(undefined);
    const filename=printer.status.filename;
    setThumbnailLoading(false);
    if(!client||!filename||!detailReady)return;
    setThumbnailLoading(true);
    void (async()=>{
      const meta=await client.metadata(filename,controller.signal).catch(error=>{if(controller.signal.aborted)throw error;return undefined});
      if(controller.signal.aborted)return;
      setMetadata(meta);
      const image=await client.thumbnailDataUrl(filename,meta,undefined,{allowEmbeddedGcode:false,signal:controller.signal});
      if(!controller.signal.aborted)setThumbnail(image);
    })().catch(()=>{}).finally(()=>{if(!controller.signal.aborted)setThumbnailLoading(false)});
    return()=>controller.abort();
  },[client,printer.status.filename,detailReady]);
  useEffect(()=>{
    if(!client)return;
    const off=client.onResponse(line=>setConsoleLines(lines=>[...lines,line].slice(-250)));
    return()=>off();
  },[client]);
  useEffect(()=>{
    const onVisibility=()=>setWindowVisible(!document.hidden);
    document.addEventListener('visibilitychange',onVisibility);
    return()=>document.removeEventListener('visibilitychange',onVisibility);
  },[]);

  const run=(fn:()=>Promise<unknown>)=>{
    setError('');
    if(!client){setError('Moonraker ещё не подключён');return;}
    fn().catch(reason=>setError(String(reason?.message??reason)));
  };
  const confirmRun=async(message:string,fn:()=>Promise<unknown>,danger=false)=>{if(await appConfirm(message,{title:danger?'Опасная команда':'Подтверждение команды',confirmLabel:'Выполнить',danger}))run(fn)};
  const navigate=(destination:DetailDestination)=>onNavigate?onNavigate(destination):onClose();
  const progress=clamp(Math.round((printer.status.progress||0)*100),0,100);
  const displayName=printerDisplayName(printer);
  const estimated=metadata?.estimated_time??printer.status.totalDuration??0;
  const remaining=Math.max(0,estimated-(printer.status.printDuration||0));
  const jobState=jobFreshness(printer.status,now),jobConfirmed=jobState==='live'||jobState==='stale';
  const jobActive=jobConfirmed&&printerHasActiveJob(printer.status);
  const printing=jobActive&&printer.status.state==='printing';
  const paused=jobActive&&printer.status.state==='paused';
  const telemetryState=telemetryFreshness(printer.status,now),telemetryVisible=telemetryState==='live'||telemetryState==='stale';
  const online=printerIsReachable(printer.status);
  const cancelFanEdit=()=>{
    fanEditing.current=false;fanDirty.current=false;
    if(!fanLock.current)setFan(Math.round((fanObserved.current??0)*100));
  };
  const commitFan=async(value:number)=>{
    if(!fanDirty.current||fanLock.current)return;
    fanDirty.current=false;fanEditing.current=false;
    if(!client||!online||printer.status.remoteControlSuspended){
      cancelFanEdit();setError('Управление вентилятором недоступно: нет подтверждённого подключения к принтеру.');return;
    }
    const generation=fanGeneration.current;
    fanLock.current=true;setFanBusy(true);setFanFeedback('Проверяем состояние вентилятора…');setError('');
    try{
      const confirmed=await client.setFan(value);
      if(generation!==fanGeneration.current)return;
      fanObserved.current=confirmed.percent/100;setFan(confirmed.percent);
      setFanFeedback(`Подтверждено принтером: ${confirmed.percent}%`);
    }catch(reason){
      if(generation!==fanGeneration.current)return;
      setFan(Math.round((fanObserved.current??0)*100));setFanFeedback('Изменение не подтверждено.');
      setError(String(reason instanceof Error?reason.message:reason));
    }finally{
      if(generation===fanGeneration.current){fanLock.current=false;setFanBusy(false)}
    }
  };
  useEffect(()=>{
    const epoch=++lightEpoch.current;
    let disposed=false,inFlight=false;
    lightLock.current=false;setLightBusy(false);setLight(undefined);
    if(!client||!online||!windowVisible||!detailReady)return;
    const refresh=async()=>{
      if(inFlight||lightLock.current)return;
      inFlight=true;const revision=lightRevision.current;
      try{const state=await client.lightStatus();if(!disposed&&!lightLock.current&&revision===lightRevision.current)setLight(state)}
      catch(reason){if(!disposed&&!lightLock.current&&revision===lightRevision.current)setLight(previous=>({...previous,supported:previous?.supported??false,detail:'Не удалось определить подсветку: '+String(reason instanceof Error?reason.message:reason)}))}
      finally{inFlight=false}
    };
    void refresh();const timer=window.setInterval(refresh,15_000);
    return()=>{disposed=true;window.clearInterval(timer);if(lightEpoch.current===epoch)lightEpoch.current++};
  },[client,online,windowVisible,printer.id,lightRefresh,detailReady]);
  const setPrinterLight=async(on:boolean)=>{
    if(!client||!online||lightLock.current)return;
    const epoch=lightEpoch.current;
    lightRevision.current++;lightLock.current=true;setLightBusy(true);setError('');
    try{
      const state=await client.light(on);
      if(lightEpoch.current===epoch){setLight(state);showAppNotification('Подсветка',state.on===undefined?state.detail??'Команда принята. Состояние не передаётся.':`${printer.name}: подсветка ${state.on?'включена':'выключена'}`,state.on===undefined?'info':'success')}
    }catch(reason){if(lightEpoch.current===epoch){const message=String(reason instanceof Error?reason.message:reason);setError(message);showAppNotification('Подсветка не переключена',message,'danger')}}
    finally{if(lightEpoch.current===epoch){lightLock.current=false;setLightBusy(false)}}
  };
  const connecting=printerIsConnecting(printer.status);
  const serviceLocked=jobActive;
  const stateLabel=connecting?'Подключение к Moonraker':printer.status.connectionState==='degraded'?printerConnectionReasonLabel(printer.status):printer.status.connectionState==='offline'?'Нет связи':printer.status.state==='error'?printerConnectionReasonLabel(printer.status):paused?'Печать на паузе':jobActive?'Сейчас печатает':online?'Готов к печати':'Нет связи';
  const printerImage=printerArtwork(printer);
  const cameraIdentity=JSON.stringify([printer.id,printer.host,isK1C2025(printer),isK1Max(printer)]);
  const cameraInput=JSON.stringify(printer.webcams);
  const [cameraDetected,setCameraDetected]=useState<string>();
  const [cameraFailed,setCameraFailed]=useState<string>();
  const [discoveredCameras,setDiscoveredCameras]=useState<{identity:string;input:string;webcams:PrinterModel['webcams']}>();
  const cameraPrinter=discoveredCameras?.identity===cameraIdentity&&discoveredCameras.input===cameraInput?{...printer,webcams:discoveredCameras.webcams}:printer;
  const configuredCamera=configuredPrinterCamera(cameraPrinter);
  const cameraKey=JSON.stringify([cameraIdentity,configuredCamera?.stream_url??'builtin']);
  const cameraCandidate=!!configuredCamera||isCrealityCamera(printer);
  const cameraAvailable=cameraCandidate&&cameraDetected===cameraKey;
  const cameraProbing=detailReady&&online&&windowVisible&&!cameraAvailable&&cameraCandidate&&cameraFailed!==cameraKey;
  useEffect(()=>{setCameraFailed(undefined)},[cameraKey,online]);
  useEffect(()=>{
    if(!online||!windowVisible)return;
    const timer=window.setInterval(()=>setCameraFailed(undefined),30_000);
    return()=>window.clearInterval(timer);
  },[online,windowVisible,cameraKey]);
  useEffect(()=>{
    if(!online||!windowVisible||!client||!detailReady)return;
    const controller=new AbortController();
    let disposed=false,inFlight=false;
    const refresh=async()=>{
      if(inFlight)return;inFlight=true;
      try{const webcams=await client.webcams(controller.signal);if(!disposed&&Array.isArray(webcams))setDiscoveredCameras({identity:cameraIdentity,input:cameraInput,webcams})}catch{/* Unavailable discovery is not proof of an absent camera. */}finally{inFlight=false}
    };
    void refresh();const timer=window.setInterval(refresh,60_000);
    return()=>{disposed=true;controller.abort();window.clearInterval(timer)};
  },[online,windowVisible,client,cameraIdentity,cameraInput,detailReady]);
  const cameraName=configuredCamera?.name|| (isK1C2025(printer)?'Камера K1C 2025':isK1Max(printer)?'Камера K1 Max':'Камера');
  const layer=`${printer.status.currentLayer??'—'}${printer.status.totalLayers?` / ${printer.status.totalLayers}`:''}`;
  const channel=printerWorkingChannel(printer.status);
  const loadMacro=useMemo(()=>macros.find(name=>/^(LOAD_FILAMENT|FILAMENT_LOAD|M701)$/i.test(name)),[macros]);
  const unloadMacro=useMemo(()=>macros.find(name=>/^(UNLOAD_FILAMENT|FILAMENT_UNLOAD|M702)$/i.test(name)),[macros]);
  const featuredMacros=useMemo(()=>macros.filter(name=>![loadMacro,unloadMacro].includes(name)).slice(0,4),[macros,loadMacro,unloadMacro]);

  return <div className="kfDetailBackdrop">
    <section className="kfDetailShell kfPrinterDetailEnter">
      <aside className="kfDetailSidebar">
        <div className="kfDetailBrand"><span>K</span><strong>KLIPPER FARM</strong></div>
        <nav aria-label="Навигация Klipper Farm">
          <button onClick={()=>navigate('dashboard')}><LayoutDashboard/>Панель</button>
          <button className="active" onClick={()=>navigate('printers')}><PrinterIcon/>Принтеры</button>
          <button onClick={()=>navigate('files')}><FolderOpen/>Файлы</button>
          {onSettings&&<button onClick={onSettings}><Settings2/>Настройки</button>}
        </nav>
        <div className="kfDetailConnection">
          <i className={online?'online':'offline'}/>
          <div><b>{printerConnectionReasonLabel(printer.status)}</b><span>{printer.host}{channel?` · ${channel}`:''}</span></div>
        </div>
        <button className="kfDetailBack" onClick={onClose}><ArrowLeft/>К списку принтеров</button>
      </aside>

      <main className="kfDetailMain">
        <header className="kfDetailHeader">
          <div className="kfDetailBreadcrumb">
            <span>Принтеры</span><b>/</b><strong>{displayName}</strong>
            <em className={online?'online':'offline'}><i/>{printerConnectionReasonLabel(printer.status)}</em>
          </div>
          <div className="kfDetailHeaderActions">
            <button disabled={!printing&&!paused} onClick={()=>run(()=>paused?client!.resume():client!.pause())}>{paused?<Play/>:<Pause/>}{paused?'Продолжить':'Пауза'}</button>
            <button className="stop" disabled={!printing&&!paused} onClick={()=>void confirmRun('Остановить текущую печать?',()=>client!.cancel(),true)}><Square/>Остановить</button>
            <button className="close" title="Закрыть" onClick={onClose}><X/></button>
          </div>
        </header>

        {error&&<div className="kfDetailError"><Zap/>{error}<button onClick={()=>setError('')}><X/></button></div>}

        <div className="kfDetailGrid">
          <aside className="kfDetailControls">
            <section className="kfCyberPanel kfDetailTemperatures">
              <header><Thermometer/><b>Температуры</b><span className={`telemetryHeaderState ${telemetryState}`} title={compactTelemetryLabel(printer.status,now)}>{compactTelemetryLabel(printer.status,now)}</span></header>
              <div className="kfDetailTempCard nozzle">
                <div><span>Сопло</span><strong>{confirmedTemperature(printer.status.nozzle,printer.status,now)} <small>/ {confirmedTemperature(printer.status.nozzleTarget,printer.status,now)}</small></strong></div>
                <div className="kfDetailTempBar"><i style={{width:`${telemetryVisible?clamp(printer.status.nozzle/3,0,100):0}%`}}/></div>
                <div className="kfDetailTarget"><button onClick={()=>setNozzleTarget(value=>clamp(value-5,0,320))}><Minus/></button><input aria-label="Целевая температура сопла" type="number" min="0" max="320" value={nozzleTarget} onChange={event=>setNozzleTarget(clamp(Number(event.target.value),0,320))}/><button onClick={()=>setNozzleTarget(value=>clamp(value+5,0,320))}><Plus/></button><button className="apply" onClick={()=>run(()=>client!.setNozzle(nozzleTarget))}>Задать</button></div>
              </div>
              <div className="kfDetailTempCard bed">
                <div><span>Стол</span><strong>{confirmedTemperature(printer.status.bed,printer.status,now)} <small>/ {confirmedTemperature(printer.status.bedTarget,printer.status,now)}</small></strong></div>
                <div className="kfDetailTempBar"><i style={{width:`${telemetryVisible?clamp(printer.status.bed/1.2,0,100):0}%`}}/></div>
                <div className="kfDetailTarget"><button onClick={()=>setBedTarget(value=>clamp(value-5,0,130))}><Minus/></button><input aria-label="Целевая температура стола" type="number" min="0" max="130" value={bedTarget} onChange={event=>setBedTarget(clamp(Number(event.target.value),0,130))}/><button onClick={()=>setBedTarget(value=>clamp(value+5,0,130))}><Plus/></button><button className="apply" onClick={()=>run(()=>client!.setBed(bedTarget))}>Задать</button></div>
              </div>
            </section>

            <section className="kfCyberPanel kfDetailMovement">
              <header><Gauge/><b>Движение</b><span>{step} мм</span></header>
              <div className="kfDetailJogWrap">
                <div className="kfDetailJogXY">
                  <span/><button title="Y+" onClick={()=>run(()=>client!.jog('Y',step))}><ArrowUp/></button><span/>
                  <button title="X−" onClick={()=>run(()=>client!.jog('X',-step))}><ArrowLeft/></button><button className="home" title="Домой" onClick={()=>run(()=>client!.home('ALL'))}><Home/></button><button title="X+" onClick={()=>run(()=>client!.jog('X',step))}><ArrowRight/></button>
                  <span/><button title="Y−" onClick={()=>run(()=>client!.jog('Y',-step))}><ArrowDown/></button><span/>
                </div>
                <div className="kfDetailJogZ"><button onClick={()=>run(()=>client!.jog('Z',step))}>Z<Plus/></button><button onClick={()=>run(()=>client!.home('Z'))}><Home/>Z</button><button onClick={()=>run(()=>client!.jog('Z',-step))}>Z<Minus/></button></div>
              </div>
              <div className="kfDetailSteps"><span>Шаг</span>{[0.1,1,10,50].map(value=><button key={value} className={step===value?'active':''} onClick={()=>setStep(value)}>{value}</button>)}</div>
            </section>

            <section className={`kfCyberPanel kfDetailUtilities ${utilityStyles.utilities}`}>
              <label><span><Gauge/>Скорость <b>{speed}%</b></span><input type="range" min="10" max="300" value={speed} onChange={event=>setSpeed(Number(event.target.value))} onPointerUp={()=>run(()=>client!.setSpeed(speed))}/></label>
              <label title={fanFeedback||'Обдув модели · состояние подтверждается принтером'}><span><Fan/>Вентилятор <b aria-live="polite">{fanBusy?'…':fanEditing.current||fanObserved.current!==undefined?`${fan}%`:'—'}</b></span><input aria-label="Вентилятор" type="range" min="0" max="100" value={fan} disabled={!client||!online||!!printer.status.remoteControlSuspended||fanBusy} aria-busy={fanBusy} aria-valuetext={fanBusy?`Проверяем ${fan}%`:`${fan}%`} onPointerDown={()=>{fanEditing.current=true}} onChange={event=>{fanEditing.current=true;fanDirty.current=true;setFan(Number(event.target.value))}} onPointerUp={event=>void commitFan(Number(event.currentTarget.value))} onPointerCancel={cancelFanEdit} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))fanEditing.current=true}} onKeyUp={event=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key))void commitFan(Number(event.currentTarget.value))}} onBlur={event=>void commitFan(Number(event.currentTarget.value))}/></label>
              <PrinterLightControl light={light} online={online} busy={lightBusy} onToggle={on=>void setPrinterLight(on)} onRetry={()=>setLightRefresh(value=>value+1)}/>
            </section>
          </aside>

          <section className="kfCyberPanel kfDetailHero">
            <header><div className="kfDetailIdentity"><i className={jobActive?'active':''}/><span>{stateLabel}</span><h1>{displayName}</h1></div><span className="kfDetailHost">{printer.host}</span></header>
            <div className="kfDetailHeroStage">
              <div className="kfDetailProgressHalo" style={{'--progress':`${jobConfirmed?progress*3.6:0}deg`} as CSSProperties}>
                <div><strong>{jobConfirmed?progress:'—'}{jobConfirmed&&<small>%</small>}</strong><span>{!jobConfirmed?'Данные задания недоступны':jobActive?`Осталось ${duration(remaining)}`:'Ожидание задания'}</span></div>
              </div>
              <img src={printerImage} alt={displayName} onError={event=>{event.currentTarget.src=fallbackPrinterArtwork}}/>
              <div className="kfDetailHeroMetrics">
                <div><span>Слой</span><b>{layer}</b></div>
                <div><span>Скорость</span><b>{speed}%</b></div>
                <div><span>Высота Z</span><b>{printer.status.position?.[2]?.toFixed?.(2)??'—'} мм</b></div>
              </div>
            </div>
            <div className="kfDetailCurrentJob">
                <div className="kfDetailJobPreview"><JobPartPreview filename={jobConfirmed?printer.status.filename:undefined} thumbnail={jobConfirmed?thumbnail:undefined} loading={thumbnailLoading}/></div>
              <div><span>Текущее задание</span><strong>{!jobConfirmed?'Данные задания недоступны':printer.status.filename||'Нет активной печати'}</strong><small>{jobConfirmed?(metadata?.filament_type??'G-code'):'Ожидаем подтверждённую телеметрию'}{jobConfirmed&&metadata?.layer_height?` · слой ${metadata.layer_height} мм`:''}</small></div>
              <div className="kfDetailJobProgress"><span><b>{jobConfirmed?`${progress}%`:'—'}</b><em>Слой {jobConfirmed?layer:'—'}</em></span><i><b style={{width:`${jobConfirmed?progress:0}%`}}/></i></div>
            </div>
          </section>

          <aside className="kfDetailRight">
            {(cameraAvailable||cameraProbing)&&<section className={`kfCyberPanel kfDetailCamera${cameraProbing?' probing':''}`} aria-hidden={cameraProbing||undefined}>
              <header><Camera/><b>{cameraName}</b><span className={online?'online':'offline'}>{online?'LIVE':'OFFLINE'}</span></header>
              <div className="kfDetailCameraStage"><PrinterCamera key={cameraKey} printer={cameraPrinter} active={detailReady&&windowVisible&&online} onAvailability={available=>{if(available){setCameraDetected(cameraKey);setCameraFailed(undefined)}else{setCameraFailed(cameraKey);setCameraDetected(undefined)}}}/></div>
            </section>}

            <section className="kfCyberPanel kfDetailMacros">
              <header><Zap/><b>Макросы</b><span>{macros.length}</span></header>
              <div className="kfDetailMacroGrid">
                <button disabled={serviceLocked} title={serviceLocked?'Недоступно во время печати':''} onClick={()=>void confirmRun('Выполнить парковку осей G28?',()=>client!.serviceCommand('G28'))}><Home/><span>Калибровка</span></button>
                <button disabled={serviceLocked} title={serviceLocked?'Недоступно во время печати':''} onClick={()=>void confirmRun('Запустить построение сетки стола?',()=>client!.serviceCommand('G28\nBED_MESH_CALIBRATE'))}><Gauge/><span>Сетка стола</span></button>
                <button disabled={!loadMacro} onClick={()=>loadMacro&&run(()=>client!.runMacro(loadMacro))}><ArrowUp/><span>Загрузить<br/>филамент</span></button>
                <button disabled={!unloadMacro} onClick={()=>unloadMacro&&run(()=>client!.runMacro(unloadMacro))}><ArrowDown/><span>Выгрузить<br/>филамент</span></button>
              </div>
              {!!featuredMacros.length&&<div className="kfDetailDetectedMacros">{featuredMacros.map(name=><button key={name} onClick={()=>run(()=>client!.runMacro(name))}>{name}</button>)}</div>}
              <div className="kfDetailSystemActions">
                <button onClick={()=>void confirmRun('Перезапустить Klipper?',()=>client!.restart())}><RefreshCw/>Перезапуск Klipper</button>
                <button className="danger" onClick={()=>void confirmRun('Выполнить аварийную остановку принтера?',()=>client!.emergencyStop(),true)}><Zap/>Экстренная остановка</button>
              </div>
              <button className="kfDetailDiagnostics" onClick={()=>client?.diagnostics().then(setDiagnostics).catch(reason=>setDiagnostics({error:String(reason)}))}>{diagnostics?diagnosticLabel(diagnostics):'Проверить соединение'}</button>
            </section>
          </aside>

          <section className="kfCyberPanel kfDetailConsole">
            <header className="kfDetailConsoleTabs">
              <button className={bottomTab==='console'?'active':''} onClick={()=>setBottomTab('console')}>Консоль</button>
              <button className={bottomTab==='objects'?'active':''} onClick={()=>setBottomTab('objects')}>Траектория</button>
              <button className={bottomTab==='history'?'active':''} onClick={()=>setBottomTab('history')}>История</button>
              <span>MOONRAKER TERMINAL</span>
            </header>
            {bottomTab==='console'&&<>
              <div className="kfDetailConsoleBody">
                <div className="kfDetailConsoleLines">
                  <span><i>●</i> Klipper state: {printer.status.state}</span>
                  <span><i>●</i> File selected: {printer.status.filename||'—'}</span>
                  <span><i>●</i> Last telemetry: Hotend {Math.round(printer.status.nozzle)}°C · Bed {Math.round(printer.status.bed)}°C · {telemetryLabel(printer.status,now)}</span>
                  <span><i>●</i> Connection: {printerConnectionReasonLabel(printer.status)} · {channel||'канал уточняется'} · {printer.host}</span>
                  {consoleLines.map((line,index)=><span key={index}>{line}</span>)}
                </div>
                <div className="kfDetailQuickCommands"><span>Быстрые команды</span><button onClick={()=>run(()=>client!.gcode(`M104 S${nozzleTarget}`))}>M104 S{nozzleTarget}</button><button onClick={()=>run(()=>client!.gcode(`M140 S${bedTarget}`))}>M140 S{bedTarget}</button><button disabled={serviceLocked} onClick={()=>run(()=>client!.serviceCommand('G28'))}>G28</button><button onClick={()=>run(()=>client!.gcode('M106 S255'))}>M106 S255</button></div>
              </div>
              <form onSubmit={event=>{event.preventDefault();if(!consoleLine.trim())return;run(()=>client!.gcode(consoleLine.trim()));setConsoleLine('');}}><input value={consoleLine} onChange={event=>setConsoleLine(event.target.value)} placeholder="Введите команду Klipper…"/><button><Send/>Отправить</button></form>
            </>}
            {bottomTab==='objects'&&<div className="kfDetailObjectPreview"><GCodePreview client={client} filename={printer.status.filename}/></div>}
            {bottomTab==='history'&&<div className="kfDetailHistory">{history.slice(0,16).map((job,index)=><div key={job.job_id??index}><FileCode2/><span><b>{job.filename}</b><small>{job.status??'—'}</small></span><strong>{duration(job.print_duration)}</strong></div>)}{historyLoading&&<p role="status">Загрузка истории…</p>}{historyError&&<p role="alert">Не удалось получить историю: {historyError}</p>}{!history.length&&!historyLoading&&!historyError&&<p>История Moonraker пока пуста</p>}</div>}
          </section>
        </div>
      </main>
    </section>
  </div>;
}
