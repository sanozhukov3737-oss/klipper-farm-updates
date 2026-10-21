import type { FilamentFinish, Spool } from '../types';

/** Grams are bookkeeping units. Automatic mass is calculated from reported extrusion. */
export const FILAMENT_INVENTORY_KEY='production.filamentInventory';
export const FILAMENT_LEDGER_LIMIT=10_000;
const MAX_GRAMS=1_000_000_000;
export const FILAMENT_DEFAULTS:Record<string,{density:number;diameter:number}>={
  PLA:{density:1.24,diameter:1.75},PETG:{density:1.27,diameter:1.75},ABS:{density:1.04,diameter:1.75},ASA:{density:1.07,diameter:1.75},TPU:{density:1.21,diameter:1.75},
};
export type MaterialStock={material:string;looseGrams:number;reserveGrams:number;usedGrams:number;density:number;diameter:number;reserveNotified:boolean};
export type PrinterMaterialBinding={id:string;material:string;spoolId?:string;effectiveAt:number;endedAt?:number;baselinePending:boolean;baselineAt?:number;activeBaseline?:{jobKey:string;startTime:number;usedMm:number;at:number}};
export type FilamentTrackingStatus='unbound'|'baseline-pending'|'tracking'|'pending'|'no-history'|'error';
export type PrinterFilamentUsage={binding?:PrinterMaterialBinding;bindings:PrinterMaterialBinding[];trackingAt?:number;reconcileSince?:number;serverFloorAt?:number;historyClockAmbiguous?:boolean;status:FilamentTrackingStatus;error?:string;usedGrams:number;calculatedGrams:number;manualGrams:number;pendingJobs:number;lastMilestoneKg:number;byMaterial:Record<string,number>};
export type FilamentJobObservation={printerId:string;printerName?:string;jobId:string;filename:string;startTime:number;endTime?:number;status:string;usedMm?:number;material?:string;metadataWeightGrams?:number;metadataLengthMm?:number};
export type FilamentPending={id:string;jobKey:string;printerId:string;printerName?:string;filename:string;reason:string;usedMm?:number;startTime:number;endTime?:number;material?:string;resolved?:boolean;resolution?:'manual'|'dismissed';resolvedAt?:number;note?:string};
type ProcessedJob={printerId:string;startTime:number;endTime?:number;usedMm?:number;chargedGrams:number;gramsPerMm?:number;outcome:'charged'|'pending'|'excluded'|'manual'|'dismissed';bindingId?:string};
export type FilamentUsageDay={day:string;printerId:string;material:string;calculatedGrams:number;manualGrams:number};
export type FilamentInventory={schemaVersion:1;nextId:number;materials:Record<string,MaterialStock>;spools:Spool[];printers:Record<string,PrinterFilamentUsage>;pending:FilamentPending[];processedJobs:Record<string,ProcessedJob>;createdAt:number;usageHistory?:{startedAt:number;days:FilamentUsageDay[]}};
export type FilamentNotice={action:'filament.milestone'|'filament.reserve';details:string;title:string;body:string};
export type FilamentCommand=
 |{type:'add-stock';material:string;grams:number;reserveGrams?:number}
 |{type:'set-reserve';material:string;reserveGrams:number}
 |{type:'configure-material';material:string;density:number;diameter:number}
 |{type:'add-spools';material:string;count:number;weightGrams:number;name?:string;color?:string;finish?:FilamentFinish;source:'existing-stock'|'purchase';printerId?:string;price?:number;currency?:string}
 |{type:'edit-spool';spoolId:string;remainingGrams:number;color?:string;finish?:FilamentFinish}
 |{type:'spool-appearance';spoolId:string;color?:string;finish?:FilamentFinish}
 |{type:'remove-spool';spoolId:string}
 |{type:'bind-printer';printerId:string;material:string;spoolId?:string;expectedBindingId?:string|null}
 |{type:'unbind-printer';printerId:string}
 |{type:'manual-writeoff';printerId:string;printerName?:string;material:string;grams:number;spoolId?:string;note?:string}
 |{type:'history-baseline';printerId:string;bindingId:string;at:number;jobs:FilamentJobObservation[];active?:{filename:string;usedMm?:number;startedAt?:number}}
 |{type:'history-reconciled';printerId:string;bindingId:string;from?:number;jobs:FilamentJobObservation[]}
 |{type:'observe-job';job:FilamentJobObservation}
 |{type:'set-printer-status';printerId:string;status:'tracking'|'no-history'|'error';message?:string}
 |{type:'resolve-pending';pendingId:string;grams:number;material:string;spoolId?:string;note?:string}
 |{type:'dismiss-pending';pendingId:string;note?:string};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const grams=(value:unknown,allowZero=false)=>{if(!finite(value)||value<(allowZero?0:Number.MIN_VALUE)||value>MAX_GRAMS)throw new Error('Укажите корректный вес пластика.');return value};
const text=(value:unknown,label:string,max=200)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Некорректное поле: ${label}.`);return value.trim()};
export function normalizeFilamentMaterial(value:string){const material=text(value,'материал',60).toUpperCase().replace(/\s+/g,' ');return material==='PET-G'?'PETG':material}
const timestamp=(value:unknown)=>{if(!finite(value)||value<=0||value>8.64e15)throw new Error('Некорректное время учёта.');return value};
const validateFinish=(value:unknown)=>{if(value!==undefined&&!['normal','silk','matte'].includes(value as string))throw new Error('Выберите поверхность: обычная, Silk или матовая.');};
const emptyPrinter=():PrinterFilamentUsage=>({bindings:[],status:'unbound',usedGrams:0,calculatedGrams:0,manualGrams:0,pendingJobs:0,lastMilestoneKg:0,byMaterial:{}});
const stock=(material:string):MaterialStock=>({material,looseGrams:0,reserveGrams:0,usedGrams:0,...(FILAMENT_DEFAULTS[material]??{density:1.24,diameter:1.75}),reserveNotified:false});
export function filamentDayKey(at:number){const date=new Date(at);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
export function emptyFilamentInventory(now=Date.now()):FilamentInventory{return {schemaVersion:1,nextId:1,materials:Object.fromEntries(Object.keys(FILAMENT_DEFAULTS).map(material=>[material,stock(material)])),spools:[],printers:{},pending:[],processedJobs:{},createdAt:now,usageHistory:{startedAt:now,days:[]}}}
export function materialSummary(state:FilamentInventory){
  return Object.values(state.materials).map(row=>({...row,totalGrams:row.looseGrams+state.spools.filter(spool=>normalizeFilamentMaterial(spool.material)===row.material).reduce((sum,spool)=>sum+spool.remainingWeight,0)})).sort((a,b)=>{
    const names=Object.keys(FILAMENT_DEFAULTS),aIndex=names.indexOf(a.material),bIndex=names.indexOf(b.material);
    return (aIndex<0?99:aIndex)-(bIndex<0?99:bIndex)||a.material.localeCompare(b.material);
  });
}
export function filamentJobKey(job:Pick<FilamentJobObservation,'printerId'|'jobId'|'startTime'>){
  if(!job.printerId?.trim()||!job.jobId?.trim()||!finite(job.startTime)||job.startTime<=0)return undefined;
  return JSON.stringify([job.printerId,job.jobId,job.startTime]);
}
export function calculatedFilamentGrams(usedMm:number,material:Pick<MaterialStock,'density'|'diameter'>){
  if(!finite(usedMm)||usedMm<0)return undefined;
  const result=usedMm*Math.PI*(material.diameter/2)**2*material.density/1000;
  return finite(result)&&result<=MAX_GRAMS?result:undefined;
}
/** Strict restoration prevents a read/format failure from silently resetting live stock. */
export function restoreFilamentInventory(input:unknown):FilamentInventory{
  if(!input||typeof input!=='object')throw new Error('Не удалось прочитать сохранённый учёт пластика.');
  const state=input as FilamentInventory;
  if(state.schemaVersion!==1||!Number.isSafeInteger(state.nextId)||state.nextId<1||!state.materials||Array.isArray(state.materials)||!state.printers||Array.isArray(state.printers)||!state.processedJobs||Array.isArray(state.processedJobs)||!Array.isArray(state.spools)||!Array.isArray(state.pending)||!finite(state.createdAt))throw new Error('Формат учёта пластика повреждён. Сохранённые данные не изменены.');
  if(Object.keys(state.processedJobs).length>FILAMENT_LEDGER_LIMIT||state.pending.length>FILAMENT_LEDGER_LIMIT)throw new Error('Журнал учёта пластика переполнен. Сохранённые данные не изменены.');
  for(const [key,row] of Object.entries(state.materials)){
    if(!row||normalizeFilamentMaterial(key)!==key||row.material!==key||typeof row.reserveNotified!=='boolean'||!finite(row.density)||row.density<.1||row.density>10||!finite(row.diameter)||row.diameter<.5||row.diameter>4)throw new Error('Повреждены параметры материала.');
    grams(row.looseGrams,true);grams(row.reserveGrams,true);grams(row.usedGrams,true);
  }
  const spoolIds=new Set<string>();
  for(const spool of state.spools){validateLegacySpool(spool);if(spoolIds.has(spool.id))throw new Error('Повторяется идентификатор катушки.');spoolIds.add(spool.id);if(!state.materials[normalizeFilamentMaterial(spool.material)])throw new Error('Не найден материал катушки.');}
  const assignedSpools=new Set<string>();
  for(const [id,printer] of Object.entries(state.printers)){
    text(id,'принтер');if(!printer||!Array.isArray(printer.bindings)||!printer.byMaterial||!['unbound','baseline-pending','tracking','pending','no-history','error'].includes(printer.status)||!Number.isInteger(printer.pendingJobs)||printer.pendingJobs<0||!Number.isSafeInteger(printer.lastMilestoneKg)||printer.lastMilestoneKg<0)throw new Error('Повреждён счётчик принтера.');
    for(const amount of [printer.usedGrams,printer.calculatedGrams,printer.manualGrams,...Object.values(printer.byMaterial)])grams(amount,true);
    for(const binding of printer.bindings){text(binding.id,'привязка');timestamp(binding.effectiveAt);if(typeof binding.baselinePending!=='boolean'||!state.materials[binding.material])throw new Error('Повреждена привязка пластика.');if(binding.endedAt!==undefined&&binding.endedAt<binding.effectiveAt)throw new Error('Повреждён интервал привязки.');if(binding.activeBaseline&&(!finite(binding.activeBaseline.usedMm)||binding.activeBaseline.usedMm<0||!binding.activeBaseline.jobKey))throw new Error('Повреждён исходный расход задания.');}
    if(printer.binding){if(!printer.bindings.some(binding=>binding.id===printer.binding?.id))throw new Error('Не найдена текущая привязка.');if(printer.binding.spoolId){if(assignedSpools.has(printer.binding.spoolId))throw new Error('Одна катушка назначена нескольким принтерам.');assignedSpools.add(printer.binding.spoolId);if(!spoolIds.has(printer.binding.spoolId))throw new Error('Не найдена назначенная катушка.');}}
  }
  for(const entry of Object.values(state.processedJobs)){if(!entry||!['charged','pending','excluded','manual','dismissed'].includes(entry.outcome)||!finite(entry.startTime)||!finite(entry.chargedGrams)||entry.chargedGrams<0||(entry.usedMm!==undefined&&(!finite(entry.usedMm)||entry.usedMm<0)))throw new Error('Повреждён журнал расхода пластика.');}
  for(const pending of state.pending){if(!pending||typeof pending.id!=='string'||typeof pending.jobKey!=='string'||!state.processedJobs[pending.jobKey]||!state.printers[pending.printerId]||typeof pending.reason!=='string')throw new Error('Повреждён журнал уточнений расхода.');}
  if(state.usageHistory!==undefined){
    const history=state.usageHistory;
    if(!history||!finite(history.startedAt)||history.startedAt<=0||!Array.isArray(history.days)||history.days.length>FILAMENT_LEDGER_LIMIT)throw new Error('Повреждена история расхода по дням.');
    const seen=new Set<string>();
    for(const row of history.days){
      if(!row||typeof row.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.day)||!Number.isFinite(Date.parse(row.day+'T00:00:00Z'))||new Date(row.day+'T00:00:00Z').toISOString().slice(0,10)!==row.day||!state.materials[row.material]||!state.printers[row.printerId])throw new Error('Повреждена запись дневного расхода.');
      grams(row.calculatedGrams,true);grams(row.manualGrams,true);
      const key=JSON.stringify([row.day,row.printerId,row.material]);if(seen.has(key))throw new Error('Повторяется запись дневного расхода.');seen.add(key);
    }
  }
  return state;
}
function validateLegacySpool(value:unknown):asserts value is Spool{
  const row=value as Spool;
  if(!row||typeof row!=='object'||!row.id||typeof row.id!=='string'||typeof row.name!=='string'||typeof row.material!=='string'||!finite(row.createdAt)||!finite(row.price)||row.price<0||typeof row.currency!=='string')throw new Error('Существующие катушки имеют неподдерживаемый формат. Данные сохранены.');
  normalizeFilamentMaterial(row.material);grams(row.initialWeight);grams(row.remainingWeight,true);
  validateFinish(row.finish);
}
export function migrateFilamentInventory(legacy:unknown,now=Date.now()):FilamentInventory{
  if(!Array.isArray(legacy))throw new Error('Не удалось прочитать существующие катушки. Данные сохранены.');
  const state=emptyFilamentInventory(now),ids=new Set<string>(),assigned=new Set<string>();
  for(const spool of legacy){
    validateLegacySpool(spool);if(ids.has(spool.id))throw new Error('Повторяются идентификаторы существующих катушек.');ids.add(spool.id);
    // Preserve every original field, name, weight, price, currency and legacy assignment.
    state.spools.push({...spool});const material=normalizeFilamentMaterial(spool.material);state.materials[material]??=stock(material);
    if(spool.printerId&&!assigned.has(spool.printerId)){
      assigned.add(spool.printerId);const binding:PrinterMaterialBinding={id:`legacy:${spool.id}`,material,spoolId:spool.id,effectiveAt:now,baselinePending:true};
      state.printers[spool.printerId]={...emptyPrinter(),binding,bindings:[binding],trackingAt:now,reconcileSince:now,status:'baseline-pending'};
    }
  }
  return restoreFilamentInventory(state);
}
const terminal=(status:string)=>/^(completed?|cancelled|canceled|error|failed|interrupted|klippy_shutdown|klippy_disconnect|server_exit)$/i.test(status);
const activeJob=(status:string)=>/^(in_progress|printing|paused)$/i.test(status);
export function reduceFilamentInventory(previous:FilamentInventory,command:FilamentCommand,now=Date.now()):{state:FilamentInventory;notices:FilamentNotice[]}{
  timestamp(now);
  // Reducers never mutate a subscriber's snapshot, including byte-faithful migrated spools.
  const state=JSON.parse(JSON.stringify(previous)) as FilamentInventory,notices:FilamentNotice[]=[];
  const ensureMaterial=(value:string)=>{const material=normalizeFilamentMaterial(value);return state.materials[material]??=stock(material)};
  const ensurePrinter=(id:string)=>state.printers[text(id,'принтер') ]??=emptyPrinter();
  const id=()=>`filament-${now.toString(36)}-${state.nextId++}`;
  const getSpool=(spoolId:string)=>{const spool=state.spools.find(row=>row.id===spoolId);if(!spool)throw new Error('Катушка не найдена.');return spool};
  const clearBinding=(printerId:string)=>{
    const printer=ensurePrinter(printerId);
    if(printer.binding){const old=printer.bindings.find(row=>row.id===printer.binding?.id);if(old)old.endedAt=Math.max(old.effectiveAt,now);}
    for(const spool of state.spools)if(spool.printerId===printerId)delete spool.printerId;
    delete printer.binding;printer.status=printer.pendingJobs?'pending':'unbound';delete printer.error;
  };
  const bind=(printerId:string,materialValue:string,spoolId?:string)=>{
    const material=ensureMaterial(materialValue).material,printer=ensurePrinter(printerId);
    if(spoolId){const spool=getSpool(spoolId);if(normalizeFilamentMaterial(spool.material)!==material)throw new Error('Материал катушки не совпадает с выбранным материалом.');if(printer.binding?.spoolId!==spoolId&&spool.remainingWeight<=0)throw new Error('Пустую катушку нельзя установить на принтер.');if(spool.printerId&&spool.printerId!==printerId||Object.entries(state.printers).some(([other,row])=>other!==printerId&&row.binding?.spoolId===spoolId))throw new Error('Эта катушка уже установлена на другом принтере.');}
    if(printer.binding?.material===material&&printer.binding.spoolId===spoolId)return;
    clearBinding(printerId);const binding:PrinterMaterialBinding={id:id(),material,spoolId,effectiveAt:now,baselinePending:true};
    printer.bindings.push(binding);printer.binding=binding;printer.trackingAt??=now;printer.reconcileSince??=now;printer.status='baseline-pending';
    if(spoolId)getSpool(spoolId).printerId=printerId;
  };
  const debit=(printerId:string,materialValue:string,amount:number,spoolId:string|undefined,source:'manual'|'calculated',printerName?:string,occurredAt=now)=>{
    grams(amount,true);const material=ensureMaterial(materialValue),printer=ensurePrinter(printerId);
    const available=spoolId?getSpool(spoolId).remainingWeight:material.looseGrams;
    if(spoolId&&normalizeFilamentMaterial(getSpool(spoolId).material)!==material.material)throw new Error('Материал катушки не совпадает с расходом.');
    if(amount>available+1e-7)throw new Error(spoolId?'На катушке недостаточно пластика. Уточните остаток или расход.':'В свободном запасе недостаточно пластика. Выберите катушку или пополните запас.');
    if(amount===0)return;
    // Validate the complete transaction before modifying stock or cumulative meters.
    grams(material.usedGrams+amount,true);grams(printer.usedGrams+amount,true);grams((printer.byMaterial[material.material]??0)+amount,true);grams(printer[source==='manual'?'manualGrams':'calculatedGrams']+amount,true);
    const history=state.usageHistory??{startedAt:now,days:[]},day=filamentDayKey(occurredAt);
    const daily=history.days.find(row=>row.day===day&&row.printerId===printerId&&row.material===material.material);
    if(!daily&&history.days.length>=FILAMENT_LEDGER_LIMIT)throw new Error('Дневной журнал расхода заполнен. Остатки не изменены.');
    const field=source==='manual'?'manualGrams':'calculatedGrams';
    const dailyAmount=grams((daily?.[field]??0)+amount,true);
    if(spoolId)getSpool(spoolId).remainingWeight=Math.max(0,available-amount);else material.looseGrams=Math.max(0,available-amount);
    material.usedGrams=grams(material.usedGrams+amount,true);printer.usedGrams=grams(printer.usedGrams+amount,true);printer.byMaterial[material.material]=(printer.byMaterial[material.material]??0)+amount;
    if(source==='manual')printer.manualGrams+=amount;else printer.calculatedGrams+=amount;
    // Daily totals are committed in the same SQLite transaction as the debit.
    // Old cumulative counters stay intact: their missing dates are never invented.
    state.usageHistory=history;
    if(daily)daily[field]=dailyAmount;else history.days.push({day,printerId,material:material.material,calculatedGrams:0,manualGrams:0,[field]:dailyAmount});
    const milestone=Math.floor((printer.usedGrams+1e-7)/1000);
    if(milestone>printer.lastMilestoneKg){printer.lastMilestoneKg=milestone;const name=printerName||printerId,title=`${name}: израсходовано ${milestone} кг пластика`,body=`Общий учтённый расход: ${(printer.usedGrams/1000).toLocaleString('ru-RU',{maximumFractionDigits:3})} кг.`;notices.push({action:'filament.milestone',title,body,details:`${name} · ${printerId} · ${body}`});}
  };
  const record=(job:FilamentJobObservation,key:string,outcome:ProcessedJob['outcome'],chargedGrams=0,bindingId?:string,gramsPerMm?:number)=>{
    if(!state.processedJobs[key]&&Object.keys(state.processedJobs).length>=FILAMENT_LEDGER_LIMIT)throw new Error('Журнал расхода заполнен. Новые списания остановлены; сохранённые итоги и остатки не изменены.');
    state.processedJobs[key]={printerId:job.printerId,startTime:finite(job.startTime)?job.startTime:0,endTime:job.endTime,usedMm:finite(job.usedMm)&&job.usedMm>=0?job.usedMm:undefined,chargedGrams,outcome,bindingId,gramsPerMm};
  };
  const pending=(job:FilamentJobObservation,key:string,reason:string)=>{
    if(state.processedJobs[key]?.outcome==='charged')throw new Error(`Уточнение уже учтённого задания: ${reason}`);
    const printer=ensurePrinter(job.printerId);record(job,key,'pending');
    if(!state.pending.some(row=>row.jobKey===key))state.pending.push({id:id(),jobKey:key,printerId:job.printerId,printerName:job.printerName,filename:job.filename,reason,usedMm:job.usedMm,startTime:job.startTime,endTime:job.endTime,material:job.material});
    printer.pendingJobs=state.pending.filter(row=>row.printerId===job.printerId&&!row.resolved).length;printer.status='pending';
  };
  switch(command.type){
    case 'add-stock': {const material=ensureMaterial(command.material);material.looseGrams=grams(material.looseGrams+grams(command.grams),true);if(command.reserveGrams!==undefined)material.reserveGrams=grams(command.reserveGrams,true);break;}
    case 'set-reserve':ensureMaterial(command.material).reserveGrams=grams(command.reserveGrams,true);break;
    case 'configure-material':{if(!finite(command.density)||command.density<.1||command.density>10||!finite(command.diameter)||command.diameter<.5||command.diameter>4)throw new Error('Плотность должна быть от 0,1 до 10 г/см³, диаметр — от 0,5 до 4 мм.');const material=ensureMaterial(command.material);material.density=command.density;material.diameter=command.diameter;break;}
    case 'add-spools':{
      if(!Number.isInteger(command.count)||command.count<1||command.count>1000)throw new Error('Количество катушек должно быть от 1 до 1000.');
      const weight=grams(command.weightGrams),total=grams(weight*command.count),material=ensureMaterial(command.material);
      if(command.source!=='existing-stock'&&command.source!=='purchase')throw new Error('Укажите источник катушек.');
      if(command.printerId&&command.count!==1)throw new Error('На принтер можно назначить одну катушку за раз.');
      if(command.price!==undefined&&(!finite(command.price)||command.price<0||command.price>MAX_GRAMS))throw new Error('Укажите корректную цену катушки.');
      if(command.color!==undefined&&!/^#[\da-f]{6}$/i.test(command.color))throw new Error('Выберите цвет катушки.');
      validateFinish(command.finish);
      if(command.source==='existing-stock'){if(total>material.looseGrams+1e-7)throw new Error('В свободном запасе недостаточно пластика для этих катушек.');material.looseGrams=Math.max(0,material.looseGrams-total);}
      const newIds:string[]=[];
      for(let index=0;index<command.count;index++){const spoolId=id();newIds.push(spoolId);state.spools.push({id:spoolId,name:command.name?.trim()?text(command.name,'название катушки')+(command.count>1?` ${index+1}`:''):`${material.material} ${weight/1000} кг`,material:material.material,...(command.color?{color:command.color}:{}),...(command.finish?{finish:command.finish}:{}),initialWeight:weight,remainingWeight:weight,price:command.price??0,currency:command.currency?.trim()||'₽',createdAt:now});}
      if(command.printerId)bind(command.printerId,material.material,newIds[0]);break;
    }
    case 'edit-spool':
    case 'spool-appearance':{if(command.color!==undefined&&!/^#[\da-f]{6}$/i.test(command.color))throw new Error('Выберите цвет катушки.');validateFinish(command.finish);const spool=getSpool(command.spoolId);if(command.type==='edit-spool')spool.remainingWeight=grams(command.remainingGrams,true);if(command.color!==undefined)spool.color=command.color;if(command.finish!==undefined)spool.finish=command.finish;break;}
    case 'remove-spool':{const spool=getSpool(command.spoolId);for(const [printerId,printer] of Object.entries(state.printers))if(printer.binding?.spoolId===spool.id)clearBinding(printerId);state.spools=state.spools.filter(row=>row.id!==spool.id);break;}
    case 'bind-printer':if(command.expectedBindingId!==undefined&&(state.printers[command.printerId]?.binding?.id??null)!==command.expectedBindingId)throw new Error('Пластик принтера уже изменён. Откройте выбор заново.');bind(command.printerId,command.material,command.spoolId);break;
    case 'unbind-printer':clearBinding(command.printerId);break;
    case 'manual-writeoff':debit(command.printerId,command.material,grams(command.grams),command.spoolId,'manual',command.printerName);break;
    case 'history-baseline':{
      const printer=ensurePrinter(command.printerId),binding=printer.bindings.find(row=>row.id===command.bindingId);
      if(!binding||!binding.baselinePending||printer.binding?.id!==binding.id)break;
      const at=timestamp(command.at);if(at<binding.effectiveAt||at>now+5_000)throw new Error('Исходная история относится к другой привязке пластика.');
      binding.baselineAt=at;binding.baselinePending=false;
      if(command.jobs.some(job=>job.printerId===command.printerId&&(job.startTime>at+5_000||finite(job.endTime)&&job.endTime>at+5_000)))printer.historyClockAmbiguous=true;
      const active=command.active,activeRows=command.jobs.filter(job=>job.printerId===command.printerId&&activeJob(job.status)),candidates=activeRows.filter(job=>job.filename===active?.filename&&!!filamentJobKey(job));
      for(const job of activeRows){
        const key=filamentJobKey(job);if(!key||state.processedJobs[key])continue;
        // A print begun after binding belongs entirely to the tracked stock.
        if(job.startTime>=binding.effectiveAt&&job.startTime<=at)continue;
        const firstBinding=printer.bindings[0]?.id===binding.id;
        if(firstBinding&&job.startTime<binding.effectiveAt&&active&&finite(active.usedMm)&&active.usedMm>=0&&candidates.length===1&&activeRows.length===1&&candidates[0]===job){
          binding.activeBaseline={jobKey:key,startTime:job.startTime,usedMm:active.usedMm,at};printer.reconcileSince=Math.min(printer.reconcileSince??binding.effectiveAt,job.startTime);
        }else pending(job,key,'Во время смены или включения учёта уже выполнялось задание, но его привязка и начальный расход не подтверждены. Требуется ручное уточнение.');
      }
      const serverStarts=command.jobs.filter(job=>job.printerId===command.printerId&&finite(job.startTime)&&job.startTime>0).map(job=>job.startTime);
      if(serverStarts.length){const latest=Math.max(...serverStarts);printer.serverFloorAt??=latest;printer.reconcileSince=Math.min(printer.reconcileSince??binding.effectiveAt,latest);}
      // Only pretracking terminal jobs are excluded. A quick print that starts
      // after the binding and finishes during the history request still counts.
      if(printer.bindings[0]?.id===binding.id)for(const job of command.jobs){
        const key=filamentJobKey(job);if(!key||!terminal(job.status)||state.processedJobs[key])continue;
        if(finite(job.endTime)&&job.endTime<=binding.effectiveAt)record(job,key,'excluded');
        else if(job.startTime>=binding.effectiveAt&&job.startTime<=at&&finite(job.endTime)&&job.endTime>=job.startTime&&job.endTime<=at+5_000){/* observed by the complete reconciliation */}
        else pending(job,key,'Задание пересекает включение учёта либо время принтера не подтверждено. Уточните расход вручную.');
      }
      printer.binding=binding;printer.status=printer.pendingJobs?'pending':'tracking';delete printer.error;break;
    }
    case 'history-reconciled':{
      const printer=ensurePrinter(command.printerId);
      if(printer.binding?.id!==command.bindingId||printer.binding.baselinePending||printer.historyClockAmbiguous||command.from!==printer.reconcileSince)break;
      const jobs=command.jobs.filter(job=>job.printerId===command.printerId);
      if(!jobs.length||jobs.some(job=>!finite(job.startTime)||job.startTime<=0))break;
      if(jobs.some(job=>!terminal(job.status)&&!activeJob(job.status)))break;
      // A durable cursor may move only after every terminal row in a complete
      // page batch has a durable charged/excluded/pending marker. Active rows
      // pin the range so later completion cannot fall behind the cursor.
      const accounted=jobs.filter(job=>terminal(job.status)).every(job=>{const key=filamentJobKey(job);return key!==undefined&&!!state.processedJobs[key]});
      if(!accounted)break;
      let newest=0,oldestActive=Infinity;
      for(const job of jobs){newest=Math.max(newest,job.startTime);if(activeJob(job.status))oldestActive=Math.min(oldestActive,job.startTime);}
      const next=Math.min(newest,oldestActive)-86_400_000;
      if(next>(printer.reconcileSince??printer.trackingAt??Infinity))printer.reconcileSince=next;
      break;
    }
    case 'set-printer-status':{const printer=ensurePrinter(command.printerId);printer.status=command.status==='tracking'?(printer.pendingJobs?'pending':printer.binding?.baselinePending?'baseline-pending':printer.binding?'tracking':'unbound'):command.status;printer.error=command.message?.slice(0,1000);break;}
    case 'observe-job':{
      const job=command.job;if(!terminal(job.status))break;
      text(job.printerId,'принтер');text(job.filename||'Неизвестный файл','файл',1024);const printer=ensurePrinter(job.printerId);
      if(!printer.trackingAt)break;
      const key=filamentJobKey(job),fallbackKey=key??JSON.stringify([job.printerId,'unknown',job.filename,finite(job.startTime)?job.startTime:0,finite(job.endTime)?job.endTime:0]);
      // Once terminal use is charged or queued, a repeated/restarted observation cannot debit it again.
      const previousJob=state.processedJobs[fallbackKey];
      if(previousJob&&(previousJob.outcome!=='charged'||!finite(job.usedMm)||job.usedMm<=(previousJob.usedMm??0)))break;
      if(!key){pending(job,fallbackKey,'История не передала устойчивый идентификатор и время начала задания. Требуется подтверждение расхода.');break;}
      if(printer.historyClockAmbiguous||job.startTime>now+5_000||finite(job.endTime)&&job.endTime>now+5_000){
        printer.historyClockAmbiguous=true;pending(job,key,'Время истории принтера не согласовано со временем учёта. Подтвердите расход вручную; старые задания автоматически не списаны.');break;
      }
      const all=printer.bindings,activeAnchor=all.find(binding=>binding.activeBaseline?.jobKey===key);
      if(job.startTime<(printer.trackingAt??Infinity)&&!activeAnchor){
        if(printer.serverFloorAt!==undefined&&job.startTime>=printer.serverFloorAt){pending(job,key,'Время принтера отличается от времени включения учёта. Подтвердите привязку и расход вручную.');}
        else record(job,key,'excluded');
        break;
      }
      const candidates=all.filter(binding=>binding.effectiveAt<=job.startTime&&(binding.endedAt===undefined||job.startTime<binding.endedAt));
      const binding=activeAnchor??(candidates.length===1?candidates[0]:undefined);
      if(!binding){pending(job,key,'Не определён материал или катушка для этого задания.');break;}
      if(binding.baselinePending){break;}
      if(!finite(job.usedMm)||job.usedMm<0){pending(job,key,'Принтер не передал фактический расход пластика. Полный вес файла не списан.');break;}
      const end=finite(job.endTime)&&job.endTime!>=job.startTime?job.endTime:undefined;
      if(binding.endedAt!==undefined&&(!end||end>binding.endedAt)){
        pending(job,key,'Во время задания изменилась привязка материала или катушки. Уточните расход вручную.');break;
      }
      const baseline=binding.activeBaseline?.jobKey===key?binding.activeBaseline.usedMm:0;
      if(job.usedMm<baseline){pending(job,key,'Счётчик расхода стал меньше исходного. Автоматическое списание остановлено.');break;}
      const material=ensureMaterial(binding.material);
      if(job.material&&normalizeFilamentMaterial(job.material)!==material.material){pending(job,key,'Материал файла отличается от назначенного пластика. Уточните расход.');break;}
      const rate=previousJob?.gramsPerMm??calculatedFilamentGrams(1,material),amount=rate===undefined?undefined:(job.usedMm-baseline)*rate;
      if(amount===undefined){pending(job,key,'Расход не удалось перевести в граммы. Требуется уточнение.');break;}
      const additional=Math.max(0,amount-(previousJob?.chargedGrams??0));
      try{debit(job.printerId,material.material,additional,binding.spoolId,'calculated',job.printerName,end??now);record(job,key,'charged',amount,binding.id,rate);}catch(error){
        if(previousJob)throw error;
        pending(job,key,error instanceof Error?error.message:String(error));
      }
      break;
    }
    case 'resolve-pending':case 'dismiss-pending':{
      const entry=state.pending.find(row=>row.id===command.pendingId);if(!entry)throw new Error('Задание для уточнения не найдено.');if(entry.resolved)break;
      const printer=ensurePrinter(entry.printerId),marker=state.processedJobs[entry.jobKey];
      if(command.type==='resolve-pending'){debit(entry.printerId,command.material,grams(command.grams),command.spoolId,'manual',entry.printerName,finite(entry.endTime)&&entry.endTime>0&&entry.endTime<=now?entry.endTime:now);entry.material=normalizeFilamentMaterial(command.material);marker.chargedGrams=command.grams;marker.outcome='manual';entry.resolution='manual';}
      else{marker.outcome='dismissed';entry.resolution='dismissed';}
      entry.resolved=true;entry.resolvedAt=now;entry.note=command.note?.slice(0,1000);printer.pendingJobs=state.pending.filter(row=>row.printerId===entry.printerId&&!row.resolved).length;printer.status=printer.pendingJobs?'pending':printer.binding?.baselinePending?'baseline-pending':printer.binding?'tracking':'unbound';break;
    }
  }
  for(const row of materialSummary(state)){
    const material=state.materials[row.material];
    if(row.totalGrams>row.reserveGrams||row.reserveGrams===0)material.reserveNotified=false;
    else if(!material.reserveNotified){material.reserveNotified=true;const title=`${row.material}: достигнут резерв пластика`,body=`Осталось ${(row.totalGrams/1000).toLocaleString('ru-RU',{maximumFractionDigits:3})} кг, резерв — ${(row.reserveGrams/1000).toLocaleString('ru-RU',{maximumFractionDigits:3})} кг.`;notices.push({action:'filament.reserve',title,body,details:`${row.material} · ${body}`});}
  }
  // Fail closed; no truncation can forget an unpaid job or cause repeat billing.
  restoreFilamentInventory(state);
  return {state,notices};
}
