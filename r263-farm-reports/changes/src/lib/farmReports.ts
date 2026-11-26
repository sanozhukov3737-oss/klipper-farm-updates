import type { HistoryJob, PrintRecord, PrinterModel } from '../types';
import type { MoonrakerClient } from './moonraker';
import { dbGet } from './db';

export type FarmReportPeriod='all'|'today'|'7d'|'30d';
export type FarmReportStatus='all'|'success'|'failed';
export type FarmHistoryRow=HistoryJob&{
  printer:string;
  printerId:string;
  timestamp:number;
  snapshotId?:string;
  material?:string;
  nozzle?:number;
  slicer?:string;
};

export type FarmReportStats={
  total:number;
  success:number;
  hours:number;
  filament:number;
  filamentKnown:boolean;
  failed:number;
  completed:number;
  // Cancelled is reported apart from failed: stopping a print is a decision the operator made, not a
  // defect, and folding the two together understated the success rate on any farm where operators
  // regularly stop work.
  cancelled:number;
};

export type FarmReportData={rows:FarmHistoryRow[];records:PrintRecord[]};

const mapLimit=async<T,R>(items:T[],limit:number,worker:(item:T,index:number)=>Promise<R>)=>{
  const output=new Array<R>(items.length);
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(Math.max(1,limit),items.length)},async()=>{
    while(cursor<items.length){
      const index=cursor++;
      output[index]=await worker(items[index],index);
    }
  }));
  return output;
};

const recordRow=(record:PrintRecord):FarmHistoryRow=>({
  job_id:record.id,
  filename:record.filename,
  status:record.status,
  print_duration:record.duration,
  filament_used:record.filamentUsed,
  printer:record.printerName,
  printerId:record.printerId,
  timestamp:record.ts,
  snapshotId:record.snapshotId,
  material:record.material,
  nozzle:record.nozzle,
  slicer:record.slicer,
});

export async function loadFarmReportData({
  printers,
  clients,
  historyLimit=250,
  concurrency=2,
  canQuery=()=>true,
}:{
  printers:PrinterModel[];
  clients:Map<string,MoonrakerClient>;
  historyLimit?:number|((printer:PrinterModel)=>number);
  concurrency?:number;
  canQuery?:(printer:PrinterModel)=>boolean;
}):Promise<FarmReportData>{
  const records=await dbGet<PrintRecord[]>('production.printRecords',[]);
  const available=printers.filter(printer=>clients.has(printer.id)&&canQuery(printer));
  const histories=await mapLimit(available,concurrency,async printer=>{
    const limit=typeof historyLimit==='function'?historyLimit(printer):historyLimit;
    return {printer,jobs:await clients.get(printer.id)!.history(limit).catch(()=>[])};
  });
  const used=new Set<string>();
  const rows:FarmHistoryRow[]=[];

  for(const {printer,jobs} of histories){
    for(const job of jobs){
      const timestamp=(job.end_time||job.start_time||0)*1000;
      const local=records
        .filter(record=>!used.has(record.id)&&record.printerId===printer.id&&record.filename===job.filename&&(!timestamp||Math.abs(record.ts-timestamp)<12*60*60_000))
        .sort((left,right)=>Math.abs(left.ts-timestamp)-Math.abs(right.ts-timestamp))[0];
      if(local)used.add(local.id);
      rows.push({
        ...job,
        printer:printer.name,
        printerId:printer.id,
        timestamp:timestamp||local?.ts||0,
        snapshotId:local?.snapshotId,
        material:local?.material,
        nozzle:local?.nozzle,
        slicer:local?.slicer,
      });
    }
  }

  for(const record of records){
    if(!used.has(record.id))rows.push(recordRow(record));
  }
  return {records,rows:rows.sort((left,right)=>right.timestamp-left.timestamp)};
}

export function filterFarmHistory(rows:FarmHistoryRow[],{
  period='30d',
  printerId='all',
  status='all',
  now=Date.now(),
}:{
  period?:FarmReportPeriod;
  printerId?:string;
  status?:FarmReportStatus;
  now?:number;
}={}){
  const from=period==='today'?new Date(now).setHours(0,0,0,0):period==='7d'?now-7*86_400_000:period==='30d'?now-30*86_400_000:0;
  return rows.filter(job=>(!from||job.timestamp>=from)
    &&(printerId==='all'||job.printerId===printerId)
    &&(status==='all'||status==='success'&&/complete/i.test(job.status??'')||status==='failed'&&!!job.status&&!/complete|in_progress|printing/i.test(job.status)));
}

export function calculateFarmReportStats(rows:FarmHistoryRow[]):FarmReportStats{
  const done=rows.filter(job=>/complete/i.test(job.status??''));
  const cancelled=rows.filter(job=>/cancel/i.test(job.status??''));
  // Anything finished that is neither complete nor cancelled counts as a failure: an error, a shutdown,
  // or a status the printer reported that the farm does not recognise as success.
  const failed=rows.filter(job=>job.status
    &&!/complete|cancel|in_progress|printing/i.test(job.status));
  // The success rate is measured over prints that reached an outcome under their own power. A cancelled
  // print reached neither, so counting it as a failure answered a question the operator never asked.
  const decided=done.length+failed.length;
  // Hours are the machine's running time, so every print that actually ran is included — a cancelled or
  // failed print still wore the nozzle and occupied the bed. This is the same rule the dashboard's daily
  // load uses, and the two used to disagree.
  const seconds=rows.reduce((total,job)=>{
    if(/in_progress|printing/i.test(job.status??''))return total;
    return total+(job.print_duration||job.total_duration||0);
  },0);
  const filamentKnown=done.some(job=>Number.isFinite(job.filament_used));
  const filament=done.reduce((total,job)=>total+(job.filament_used||0),0);
  return {
    total:rows.length,
    success:decided?Math.round(done.length/decided*100):0,
    hours:Math.round(seconds/3600),
    filament:Math.round(filament/1000*10)/10,
    filamentKnown,
    failed:failed.length,
    completed:done.length,
    cancelled:cancelled.length,
  };
}

export function farmHistoryStatusLabel(status?:string){
  if(/complete/i.test(status??''))return 'Завершено';
  if(/in_progress|printing/i.test(status??''))return 'Печать';
  if(/cancel/i.test(status??''))return 'Отменено';
  if(/error|failed/i.test(status??''))return 'Ошибка';
  return status||'—';
}

export function farmHistoryStatusTone(status?:string){
  if(/complete/i.test(status??''))return 'completed';
  if(/in_progress|printing/i.test(status??''))return 'printing';
  if(/cancel/i.test(status??''))return 'cancelled';
  if(/error|failed/i.test(status??''))return 'error';
  return 'unknown';
}
