import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Printer,
  Ruler,
  X,
} from 'lucide-react';
import type { PrinterModel } from '../types';
import type { FilamentInventory } from '../lib/filamentInventory';
import { readFilamentInventory, subscribeFilamentInventory } from '../lib/filamentInventoryStore';
import { FleetPrinterCard } from './FleetPrinterCard';
import { FilamentReplaceDialog } from './FilamentReplaceDialog';
import type { MoonrakerClient } from '../lib/moonraker';
import { printerDisplayName } from '../lib/printerName';
import { printerConnectionReasonLabel, printerIsReachable } from '../lib/printerHealth';
import { printerHasActiveJob } from '../lib/printerJob';
import { jobFreshness, lastResponseLabel } from '../lib/printerTelemetry';
import { useLiveNow } from '../lib/liveClock';
import { calculateFarmReportStats, filterFarmHistory, loadFarmReportData, type FarmHistoryRow } from '../lib/farmReports';
import dashboardStyles from './FleetLive.module.css';

const stateLabel=(printer:PrinterModel,now:number)=>{
  const status=printer.status;
  if(status.remoteControlSuspended)return 'Автономная печать';
  if(status.connectionState==='connecting')return 'Подключение';
  if(status.connectionState==='offline')return 'Нет связи';
  if(status.connectionState==='degraded')return printerConnectionReasonLabel(status);
  if(status.state==='error')return 'Ошибка';
  const freshness=jobFreshness(status,now);
  if((freshness==='live'||freshness==='stale')&&status.state==='paused')return 'На паузе';
  if((freshness==='live'||freshness==='stale')&&printerHasActiveJob(status))return 'Печатает';
  return 'Готов';
};
const sameData=(current:unknown,next:unknown)=>JSON.stringify(current)===JSON.stringify(next);
const reportReady=(printer:PrinterModel)=>!printer.status.remoteControlSuspended&&printer.status.connectionState!=='degraded'&&printerIsReachable(printer.status);
const sameDashboardPrinters=(current:PrinterModel[],next:PrinterModel[])=>current.length===next.length&&current.every((printer,index)=>{
  const candidate=next[index];
  return printer.id===candidate.id&&printer.name===candidate.name&&printer.host===candidate.host&&printer.imageData===candidate.imageData&&printer.profile?.preset===candidate.profile?.preset
    &&printer.catalogModelId===candidate.catalogModelId&&printer.modelSelection?.selectedPreset===candidate.modelSelection?.selectedPreset
    &&printer.modelSelection?.lastDetection?.model===candidate.modelSelection?.lastDetection?.model
    &&printer.modelSelection?.lastDetection?.decision===candidate.modelSelection?.lastDetection?.decision
    &&printer.modelSelection?.lastDetection?.fingerprint===candidate.modelSelection?.lastDetection?.fingerprint
    &&printer.status.state===candidate.status.state&&printer.status.connectionState===candidate.status.connectionState&&printer.status.remoteControlSuspended===candidate.status.remoteControlSuspended
    &&printer.status.filename===candidate.status.filename&&printer.status.connectionMessage===candidate.status.connectionMessage&&printer.status.message===candidate.status.message
    &&Math.round((printer.status.progress||0)*100)===Math.round((candidate.status.progress||0)*100)
    &&Math.round(printer.status.printDuration||0)===Math.round(candidate.status.printDuration||0)
    &&printer.status.currentLayer===candidate.status.currentLayer&&printer.status.totalLayers===candidate.status.totalLayers
    &&Math.round(printer.status.nozzle)===Math.round(candidate.status.nozzle)&&Math.round(printer.status.bed)===Math.round(candidate.status.bed)
    &&Math.round((printer.status.telemetryUpdatedAt||0)/1000)===Math.round((candidate.status.telemetryUpdatedAt||0)/1000)
    &&Math.round((printer.status.jobUpdatedAt||0)/1000)===Math.round((candidate.status.jobUpdatedAt||0)/1000)
    &&printer.status.connectionReason===candidate.status.connectionReason&&printer.status.connectionProtocol===candidate.status.connectionProtocol&&printer.status.connectionPort===candidate.status.connectionPort
    &&Math.round((printer.status.lastSeen||0)/1000)===Math.round((candidate.status.lastSeen||0)/1000);
});

function FleetDashboardView({
  printers,
  clients,
  onOpen,
  onPrinters,
  onScan,
  onReports,
  canOperate = false,
  onWarehouse,
}:{
  printers:PrinterModel[];
  clients:Map<string,MoonrakerClient>;
  onOpen:(id:string)=>void;
  onPrinters:()=>void;
  onScan:()=>void;
  onReports:()=>void;
  canOperate?:boolean;
  onWarehouse?:()=>void;
}){
  const now=useLiveNow();
  const [inventory,setInventory]=useState<FilamentInventory>();
  const [filamentPrinterId,setFilamentPrinterId]=useState<string>();
  const filamentPrinter=printers.find(printer=>printer.id===filamentPrinterId);
  const [printerFilter,setPrinterFilter]=useState<'all'|'active'|'attention'>('all');
  const [reportRows,setReportRows]=useState<FarmHistoryRow[]>([]);
  const [reportLoading,setReportLoading]=useState(true);
  const [dismissedAttention,setDismissedAttention]=useState<Set<string>>(()=>new Set());
  const attentionRecovery=useRef(new Map<string,number>());
  const reportLoaded=useRef(false);
  const attention=useMemo(()=>printers.filter(printer=>!printer.status.remoteControlSuspended&&(printer.status.connectionState==='offline'||printer.status.connectionState==='degraded'||printer.status.state==='error')),[printers]);
  const visibleAttention=attention.filter(printer=>!dismissedAttention.has(printer.id));
  useEffect(()=>{
    let active=true;
    const unsubscribe=subscribeFilamentInventory(state=>{if(active)setInventory(state)});
    void readFilamentInventory().then(state=>{if(active)setInventory(state)}).catch(()=>{});
    return()=>{active=false;unsubscribe()};
  },[]);
  useEffect(()=>{
    const recovered=new Set<string>();
    for(const printer of printers){
      if(printer.status.connectionState==='online'&&printer.status.state!=='error'){
        if(!attentionRecovery.current.has(printer.id))attentionRecovery.current.set(printer.id,now);
        if(now-attentionRecovery.current.get(printer.id)!>=30_000)recovered.add(printer.id);
      }else attentionRecovery.current.delete(printer.id);
    }
    const ids=new Set(printers.map(printer=>printer.id));
    setDismissedAttention(current=>{
      const kept=new Set([...current].filter(id=>ids.has(id)&&!recovered.has(id)));
      return kept.size===current.size?current:kept;
    });
    for(const id of attentionRecovery.current.keys())if(!ids.has(id))attentionRecovery.current.delete(id);
  },[printers,now]);

  useEffect(()=>{
    let disposed=false;
    let inFlight=false;
    const refresh=async()=>{
      if(inFlight)return;
      inFlight=true;
      if(!disposed&&!reportLoaded.current)setReportLoading(true);
      try{
        const data=await loadFarmReportData({
          printers,
          clients,
          historyLimit:printer=>clients.get(printer.id)?.prefersConservativeBackgroundMode()?80:250,
          concurrency:2,
          canQuery:reportReady,
        });
        if(!disposed)setReportRows(current=>sameData(current,data.rows)?current:data.rows);
      }finally{
        inFlight=false;
        if(!disposed){reportLoaded.current=true;setReportLoading(false)}
      }
    };
    refresh();
    const timer=window.setInterval(refresh,300_000);
    window.addEventListener('klipper-print-records-updated',refresh);
    return()=>{disposed=true;window.clearInterval(timer);window.removeEventListener('klipper-print-records-updated',refresh)};
  },[clients,printers.map(printer=>`${printer.id}:${printer.name}:${reportReady(printer)?'ready':'hold'}`).join('|')]);

  const jobs=useMemo(()=>filterFarmHistory(reportRows,{period:'30d'}),[reportRows]);
  const stats=useMemo(()=>calculateFarmReportStats(jobs),[jobs]);
  const dailyLoad=useMemo(()=>{
    const days=Array.from({length:14},(_,index)=>{
      const date=new Date();
      date.setHours(0,0,0,0);
      date.setDate(date.getDate()-(13-index));
      return {key:date.toISOString().slice(0,10),label:date.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'}),hours:0};
    });
    const byKey=new Map(days.map(day=>[day.key,day]));
    jobs.forEach(job=>{
      const day=byKey.get(new Date(job.timestamp).toISOString().slice(0,10));
      if(day)day.hours+=(job.print_duration||job.total_duration||0)/3600;
    });
    const max=Math.max(1,...days.map(day=>day.hours));
    return days.map(day=>({...day,percent:Math.max(day.hours?8:2,Math.round(day.hours/max*100))}));
  },[jobs]);
  const linePoints=useMemo(()=>dailyLoad.map((day,index)=>`${dailyLoad.length<2?0:index/(dailyLoad.length-1)*100},${38-day.percent*.32}`).join(' '),[dailyLoad]);

  return <section className={`infoDashboard ${dashboardStyles.dashboard}`} aria-label="Информационная панель фермы">
    {visibleAttention.length>0&&<div className="infoAttention" role="status" aria-label="Уведомление о состоянии принтера">
      <button className="infoAttentionOpen" onClick={()=>onOpen(visibleAttention[0].id)} title={`Открыть ${printerDisplayName(visibleAttention[0])}`}>
        <AlertTriangle/>
        <span className="infoAttentionText"><strong>{printerDisplayName(visibleAttention[0])}: {stateLabel(visibleAttention[0],now)}</strong><span>{visibleAttention[0].status.connectionMessage||visibleAttention[0].status.message||lastResponseLabel(visibleAttention[0].status.lastSeen,now)}</span></span>
        {visibleAttention.length>1&&<em>Ещё проблем: {visibleAttention.length-1}</em>}
        <ChevronRight/>
      </button>
      <button className="infoAttentionClose" onClick={()=>setDismissedAttention(current=>new Set([...current,...attention.map(printer=>printer.id)]))} title="Скрыть уведомление" aria-label="Скрыть уведомление"><X/></button>
    </div>}

    <section className="infoPrintersSection">
      <header><div><h2>Состояние принтеров</h2><p>Вся ферма перед глазами</p></div><button onClick={onPrinters}>Все принтеры <ChevronRight/></button></header>
      <div className={dashboardStyles.filters} role="group" aria-label="Показать принтеры">
        <button aria-pressed={printerFilter==='all'} onClick={()=>setPrinterFilter('all')}>Все <b>{printers.length}</b></button>
        <button aria-pressed={printerFilter==='active'} onClick={()=>setPrinterFilter('active')}>С заданиями <b>{printers.filter(printer=>printerHasActiveJob(printer.status)).length}</b></button>
        <button aria-pressed={printerFilter==='attention'} onClick={()=>setPrinterFilter('attention')}>Требуют внимания <b>{attention.length}</b></button>
      </div>
      <div className={`infoPrinterGrid ${dashboardStyles.grid}`}>
        {printers.map((printer,index)=>{
          if(printerFilter==='active'&&!printerHasActiveJob(printer.status)||printerFilter==='attention'&&!attention.some(item=>item.id===printer.id))return null;
          const binding=inventory?.printers[printer.id]?.binding;
          const spool=binding?.spoolId?inventory?.spools.find(item=>item.id===binding.spoolId):undefined;
          return <FleetPrinterCard key={printer.id} printer={printer} index={index} now={now} onOpen={onOpen} spool={spool} spoolDiameter={inventory?.materials[binding?.material ?? '']?.diameter} material={binding?.material} onReplaceFilament={canOperate?setFilamentPrinterId:undefined}/>;
        })}
        {!printers.length&&<div className="infoEmpty"><Printer/><strong>Принтеров пока нет</strong><span>Добавьте оборудование, чтобы увидеть состояние фермы.</span><button onClick={onScan}>Найти в сети</button></div>}
        {printers.length>0&&printerFilter!=='all'&&!printers.some(printer=>printerFilter==='active'?printerHasActiveJob(printer.status):attention.some(item=>item.id===printer.id))&&<div className={dashboardStyles.emptyFilter}>В этой группе сейчас нет принтеров.</div>}
      </div>
    </section>

    {canOperate&&filamentPrinter&&<FilamentReplaceDialog key={filamentPrinter.id} printer={filamentPrinter} printers={printers} canOperate={canOperate} onClose={()=>setFilamentPrinterId(undefined)} onWarehouse={onWarehouse?()=>{setFilamentPrinterId(undefined);onWarehouse()}:undefined}/>}

    <section className="infoReport">
      <header><div><h2>За 30 дней</h2><p>{reportLoading?'Обновляем статистику…':'Производительность всей фермы'}</p></div><button onClick={onReports}>Полный отчёт <ChevronRight/></button></header>
      <div className="infoReportBody">
        <div className="infoMetrics">
          <article className="success"><CheckCircle2/><span>Успешность</span><strong>{stats.total?`${stats.success}%`:'—'}</strong><small>{stats.completed} завершено</small></article>
          <article className="hours"><Clock3/><span>Часы печати</span><strong>{stats.hours}</strong><small>общее время</small></article>
          <article className="filament"><Ruler/><span>Филамент</span><strong>{stats.filamentKnown?`${stats.filament.toLocaleString('ru-RU')} м`:'—'}</strong><small>по данным G-code</small></article>
          <article className="jobs"><BarChart3/><span>Заданий</span><strong>{stats.total}</strong><small>{stats.failed} ошибок / отмен</small></article>
        </div>
        <div className="infoTrend" aria-label="Загрузка фермы за 14 дней">
          <div><strong>Загрузка фермы</strong><span>Последние 14 дней</span></div>
          <svg className="infoLineChart" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="График загрузки фермы">
            <line x1="0" y1="10" x2="100" y2="10"/><line x1="0" y1="22" x2="100" y2="22"/><line x1="0" y1="34" x2="100" y2="34"/>
            <polygon points={`0,40 ${linePoints} 100,40`}/>
            <polyline points={linePoints}/>
          </svg>
          <div className="infoLineLabels">{dailyLoad.map((day,index)=><span key={day.key}>{index===0||index===dailyLoad.length-1||index===Math.floor(dailyLoad.length/2)?day.label:''}</span>)}</div>
        </div>
      </div>
    </section>
  </section>;
}

export const FleetDashboard=memo(FleetDashboardView,(current,next)=>
  current.clients===next.clients&&current.canOperate===next.canOperate&&sameDashboardPrinters(current.printers,next.printers)
);
