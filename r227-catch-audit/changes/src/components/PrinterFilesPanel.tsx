import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock3,
  Database,
  FileCode2,
  Folder,
  FolderPlus,
  HardDrive,
  Layers3,
  ListPlus,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  Usb,
  Wifi,
  X,
} from 'lucide-react';
import type { FileCompatibility, GCodeFileEntry, GCodeMetadata, PrinterModel } from '../types';
import type { MoonrakerClient } from '../lib/moonraker';
import { GCODE_VALIDATION_ENGINE_VERSION, printStartOptionsFromValidation, validateGCode, type GCodeValidation } from '../lib/gcodeValidation';
import { metadataCompatibility } from '../lib/gcodeCompatibility';
import { audit, dbGetStrict, dbSet } from '../lib/db';
import { printerDisplayName } from '../lib/printerName';
import { printerConnectionLabel } from '../lib/printerHealth';
import { localLibraryIsSharedByModel, localLibraryScopeId, localLibraryScopeLabel } from '../lib/localLibraryScope';
import { uncertainPrintStart } from '../lib/printStartConfirmation';
import { diagnosticWarning } from '../lib/diagnosticLog';
import { GCodeThumbnail } from './GCodeThumbnail';
import { LocalLibraryPanel } from './LocalLibraryPanel';
import { fileNameCollator, ListPagination, usePagedRows } from './ListPagination';

type ValidationState='queued'|'checking'|'checked'|'failed';
type CachedValidation={signature:string;checkedAt:number;report:GCodeValidation};
type PrinterFile = GCodeFileEntry&{metadata?:GCodeMetadata;compatibility:FileCompatibility;validationState:ValidationState;validation?:GCodeValidation;signature:string};
type CachedPrinterFile=GCodeFileEntry&{metadata?:GCodeMetadata};
type FileIndex = { hashes:Record<string,string>;projects:Record<string,string>;folders:string[];validations:Record<string,CachedValidation>;files:CachedPrinterFile[];lastSyncedAt?:number };
type FileActionDialog={kind:'start'|'blocked'|'delete';file:PrinterFile;report?:GCodeValidation};
type PendingFileLaunch={printerId:string;host:string;dialog:FileActionDialog};
const EMPTY_INDEX: FileIndex = { hashes:{},projects:{},folders:[],validations:{},files:[] };
const CACHE_WITHOUT_FILE_IDENTITY_MS=15*60*1_000;
const MAX_FILE_CACHE_JSON_CHARS=1_200_000;
const WEBVIEW_HASH_LIMIT=8*1024*1024;

const normalizeIndex=(value:Partial<FileIndex>|undefined):FileIndex=>({
  hashes:value?.hashes??{},
  projects:value?.projects??{},
  folders:value?.folders??[],
  validations:value?.validations??{},
  files:Array.isArray(value?.files)?value.files.filter(item=>typeof item?.path==='string'&&item.path).slice(0,1000):[],
  ...(typeof value?.lastSyncedAt==='number'?{lastSyncedAt:value.lastSyncedAt}:{}),
});
const cacheableMetadata=(metadata?:GCodeMetadata):GCodeMetadata|undefined=>metadata?{
  filename:metadata.filename,
  estimated_time:metadata.estimated_time,
  filament_total:metadata.filament_total,
  filament_weight_total:metadata.filament_weight_total,
  filament_type:metadata.filament_type,
  filament_name:metadata.filament_name,
  layer_height:metadata.layer_height,
  object_height:metadata.object_height,
  nozzle_diameter:metadata.nozzle_diameter,
  first_layer_extr_temp:metadata.first_layer_extr_temp,
  first_layer_bed_temp:metadata.first_layer_bed_temp,
  printer_vendor:metadata.printer_vendor,
  printer_model:metadata.printer_model,
  slicer:metadata.slicer,
  thumbnails:metadata.thumbnails?.slice(0,8).map(({width,height,size,thumbnail_path,relative_path})=>({width,height,size,thumbnail_path,relative_path})),
}:undefined;
const boundedFileCache=(rows:Array<{entry:GCodeFileEntry;metadata?:GCodeMetadata}>)=>{
  const output:CachedPrinterFile[]=[];let size=2;
  for(const {entry,metadata} of rows){
    const item:CachedPrinterFile={...entry,metadata:cacheableMetadata(metadata)},encoded=JSON.stringify(item).length+1;
    if(size+encoded>MAX_FILE_CACHE_JSON_CHARS)break;
    output.push(item);size+=encoded;
  }
  return output;
};
const mapLimit=async<T,R>(items:T[],limit:number,worker:(item:T,index:number)=>Promise<R>)=>{
  const output=new Array<R>(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(cursor<items.length){const index=cursor++;output[index]=await worker(items[index],index)}
  }));
  return output;
};
const reportCompatibility=(report:GCodeValidation):FileCompatibility=>{
  const errors=report.issues.filter(issue=>issue.level==='error').map(issue=>issue.message);
  if(errors.length)return{level:'blocked',reasons:errors};
  const warnings=report.issues.filter(issue=>issue.level==='warning').map(issue=>issue.message);
  return warnings.length?{level:'warning',reasons:warnings}:{level:'compatible',reasons:['Полная автоматическая проверка пройдена']};
};
const validationSignature=(entry:GCodeFileEntry,profileSignature:string)=>[
  GCODE_VALIDATION_ENGINE_VERSION,
  profileSignature,
  entry.size??'size?',
  entry.modified??'modified?',
].join(':');
const printerRowsFromCache=(items:CachedPrinterFile[],index:FileIndex,printer:PrinterModel,profileSignature:string,now=Date.now()):PrinterFile[]=>items.map(entry=>{
  const signature=validationSignature(entry,profileSignature),cached=index.validations[entry.path];
  const stableIdentity=entry.size!==undefined||entry.modified!==undefined;
  const cacheFresh=!!cached&&cached.signature===signature&&(stableIdentity||now-cached.checkedAt<CACHE_WITHOUT_FILE_IDENTITY_MS);
  const report=cacheFresh?{...cached.report,metadata:{...(cached.report.metadata??{}),...(entry.metadata??{}),filename:entry.metadata?.filename||cached.report.metadata?.filename||entry.path}}:undefined;
  const metadata=report?.metadata??entry.metadata;
  return{...entry,metadata,signature,validationState:report?'checked':'queued',validation:report,compatibility:report?reportCompatibility(report):metadataCompatibility(printer,metadata)};
});

const duration = (seconds?: number) => {
  if (!seconds) return 'время не определено';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`
    : `${minutes} мин`;
};
const stateLabel = (status: PrinterModel['status']) => status.state === 'printing'
  ? 'Идёт печать'
  : status.state === 'paused'
    ? 'Печать на паузе'
    : status.connectionState === 'connecting'
      ? 'Подключение'
      : status.connectionState === 'degraded'
        ? printerConnectionLabel(status)
    : status.state === 'ready'
      ? 'Готов к запуску'
      : status.state === 'error'
        ? 'Требует внимания'
        : 'Нет связи';
const leafName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
const materialTone = (value?: string) => {
  const material = value?.toLowerCase() ?? '';
  if (material.includes('petg')) return 'petg';
  if (material.includes('pla')) return 'pla';
  if (material.includes('abs') || material.includes('asa')) return 'abs';
  if (material.includes('tpu') || material.includes('flex')) return 'tpu';
  return 'generic';
};
const fileHash = async (file: File) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))
  .map(value => value.toString(16).padStart(2, '0'))
  .join('');

export function PrinterFilesPanel({ printer, printers, client, canOperate, onClose, onSettings }: { printer: PrinterModel; printers: PrinterModel[]; client?: MoonrakerClient; canOperate: boolean; onClose: () => void; onSettings?:()=>void }) {
  const storageKey = `production.printerFiles.${printer.id}`;
  const libraryId=localLibraryScopeId(printer);
  const libraryLabel=localLibraryScopeLabel(printer);
  const librarySharedByModel=localLibraryIsSharedByModel(printer);
  const libraryPeerIds=useMemo(()=>printers.filter(item=>localLibraryScopeId(item)===libraryId).map(item=>item.id).sort(),[printers,libraryId]);
  const libraryDescription=librarySharedByModel
    ?`${libraryLabel} · общая библиотека для ${libraryPeerIds.length} ${libraryPeerIds.length===1?'принтера':'принтеров'}`
    :`${printerDisplayName(printer)} · отдельная офлайн-библиотека`;
  const profileSignature = JSON.stringify(printer.profile ?? {});
  const connectionState=printer.status.connectionState??(printer.status.state==='offline'?'offline':'online');
  const canSync=!printer.status.remoteControlSuspended&&(connectionState==='online'||connectionState==='degraded');
  const [files, setFiles] = useState<PrinterFile[]>([]);
  const [fileIndex, setFileIndex] = useState<FileIndex>(EMPTY_INDEX);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('all');
  const [newProject, setNewProject] = useState('');
  const [sort, setSort] = useState<'name' | 'material' | 'time'>('name');
  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [autoCheck,setAutoCheck]=useState({done:0,total:0,running:false,current:''});
  const [actionDialog,setActionDialog]=useState<FileActionDialog>();
  const pendingLaunchRef=useRef<PendingFileLaunch>();
  const [pendingLaunch,setPendingLaunch]=useState<PendingFileLaunch>();
  const [launchUnconfirmed,setLaunchUnconfirmed]=useState(false);
  const [recoveringLaunch,setRecoveringLaunch]=useState(false);
  const [checkingLaunch,setCheckingLaunch]=useState(false);
  const launchQueryRef=useRef<object>();
  const actionEpoch=useRef(0);
  const clientRef=useRef(client);clientRef.current=client;
  const [notice,setNotice]=useState('');
  const [usingCache,setUsingCache]=useState(false);
  const [source,setSource]=useState<'printer'|'local'>('printer');
  const [longOperation,setLongOperation]=useState<'upload'|'analysis'>();
  const [analysisWaiting,setAnalysisWaiting]=useState(false);
  const validationRun=useRef(0);
  const validationTask=useRef<Promise<void>|undefined>(undefined);
  const validationAbort=useRef<AbortController>();
  const operationAbort=useRef<AbortController>();
  const printerRef=useRef(printer);
  const fileIndexRef=useRef(fileIndex);
  const fileListRef=useRef<HTMLDivElement>(null);
  printerRef.current=printer;
  fileIndexRef.current=fileIndex;
  useEffect(()=>{
    actionEpoch.current++;
    pendingLaunchRef.current=undefined;launchQueryRef.current=undefined;setPendingLaunch(undefined);setActionDialog(undefined);setBusy(false);setError('');setLaunchUnconfirmed(false);setRecoveringLaunch(false);setCheckingLaunch(false);
    return()=>{actionEpoch.current++};
  },[client,printer.id,printer.host]);

  const stopBackgroundValidation=useCallback(async(signal?:AbortSignal)=>{
    validationRun.current++;
    validationAbort.current?.abort('Фоновая проверка отменена пользователем');
    validationAbort.current=undefined;
    const task=validationTask.current;
    if(task){
      setAutoCheck(current=>({...current,running:false,current:'Приостановлено для выбранного действия'}));
      // An active native request keeps its existing bounded network slot.
      // Cancelling the selected action can release its UI immediately, while
      // the abandoned background task drains without starting more files.
      await new Promise<void>((resolve,reject)=>{
        const cancel=()=>{signal?.removeEventListener('abort',cancel);reject(new DOMException('Проверка отменена','AbortError'))};
        if(signal?.aborted){cancel();return}
        signal?.addEventListener('abort',cancel,{once:true});
        void task.catch(()=>{}).then(()=>{signal?.removeEventListener('abort',cancel);resolve()});
      });
    }
  },[]);

  const persistIndex = async (next: FileIndex) => {
    setFileIndex(next);
    await dbSet(storageKey, next);
  };
  const hydrateCache=useCallback(async()=>{
    const index=normalizeIndex(await dbGetStrict<Partial<FileIndex>>(storageKey,EMPTY_INDEX));
    const rows=printerRowsFromCache(index.files,index,printerRef.current,profileSignature);
    setFileIndex(index);
    setFiles(rows);
    setUsingCache(rows.length>0);
    const checked=rows.filter(row=>row.validationState==='checked').length;
    setAutoCheck({done:checked,total:rows.length,running:false,current:rows.length?'Локальный кеш · синхронизация возобновится автоматически':''});
    return index;
  },[storageKey,printer.id,profileSignature]);
  const refresh = useCallback(async () => {
    const run=++validationRun.current;
    validationAbort.current?.abort('Запущена новая синхронизация');
    const validationController=new AbortController();
    validationAbort.current=validationController;
    const activeClient = client;
    if (!activeClient) {
      if(validationAbort.current===validationController)validationAbort.current=undefined;
      try{
        const cached=await hydrateCache();
        setError(cached.files.length?'Moonraker ещё подключается. Показываем локально сохранённый список файлов.':'Принтер ещё не подключён к Moonraker.');
      }catch(error){setError(`Не удалось прочитать локальный кеш файлов: ${String(error instanceof Error?error.message:error)}`)}
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const [entries,stored] = await Promise.all([activeClient.fileEntries(),dbGetStrict<Partial<FileIndex>>(storageKey,EMPTY_INDEX)]);
      if(run!==validationRun.current)return;
      const index=normalizeIndex(stored);
      const now=Date.now();
      const cachedByPath=new Map<string,CachedPrinterFile>(index.files.map(file=>[file.path,file] as const));
      const cachedRows=entries.map(entry=>{
        const cached=cachedByPath.get(entry.path);
        const sameSize=entry.size===undefined||cached?.size===undefined||entry.size===cached.size;
        const sameModified=entry.modified===undefined||cached?.modified===undefined||entry.modified===cached.modified;
        return{entry,metadata:sameSize&&sameModified?cached?.metadata:undefined};
      });
      const initialFiles=cachedRows.map(({entry,metadata})=>({...entry,metadata}));
      const initialRows=printerRowsFromCache(initialFiles,index,printerRef.current,profileSignature,now);
      const initialIndex:FileIndex={...index,files:boundedFileCache(cachedRows),lastSyncedAt:now};
      await dbSet(storageKey,initialIndex);
      if(run!==validationRun.current)return;
      setFileIndex(initialIndex);
      setFiles(initialRows);
      setUsingCache(false);
      setBusy(false);
      // The list is already usable. Keep the validation banner hidden until
      // the lightweight metadata pass has determined what still needs checks.
      setAutoCheck({done:0,total:0,running:false,current:''});

      const task=(async()=>{
        // Show the file names immediately. Metadata is hydrated afterwards
        // with a small worker pool so a slow controller cannot freeze the panel.
        const metadataErrors:string[]=[];
        const metadataRows=await mapLimit(entries,activeClient.prefersConservativeBackgroundMode()?1:3,async(entry,index)=>{
          if(run!==validationRun.current)return cachedRows[index];
          const metadata=await activeClient.metadata(entry.path,validationController.signal).catch(error=>{
            const reason=String(error instanceof Error?error.message:error);
            if(!/\bHTTP(?: error)?[: ]+(?:404|405)\b/i.test(reason))metadataErrors.push(`${entry.path}: ${reason}`);
            return undefined;
          });
          return{entry,metadata:metadata??cachedRows[index].metadata};
        });
        if(run!==validationRun.current)return;
        if(metadataErrors.length)setError(`Не удалось прочитать метаданные файлов. ${metadataErrors[0]}`);
        const liveFiles=metadataRows.map(({entry,metadata})=>({...entry,metadata}));
        const rows=printerRowsFromCache(liveFiles,index,printerRef.current,profileSignature,Date.now());
        const nextIndex:FileIndex={...index,files:boundedFileCache(metadataRows),lastSyncedAt:now};
        setFileIndex(nextIndex);
        setFiles(rows);
        await dbSet(storageKey,nextIndex);
        if(run!==validationRun.current)return;

        const pending=rows.filter(row=>row.validationState==='queued');
        let done=rows.length-pending.length;
        const backgroundAllowed=!activeClient.prefersK1CCompatibilityMode()
          &&(!activeClient.prefersLowResourceMode()||printerRef.current.status.state==='ready');
        const holdReason=activeClient.prefersK1CCompatibilityMode()
          ?'K1C: проверка выполняется по запросу перед печатью или добавлением в очередь'
          :'Отложено до завершения печати';
        setAutoCheck({done,total:rows.length,running:pending.length>0&&backgroundAllowed,current:pending.length&&!backgroundAllowed?holdReason:''});
        if(!pending.length||!backgroundAllowed)return;

        const updates:Record<string,CachedValidation>={};
        for(const file of pending){
          if(run!==validationRun.current)return;
          setAutoCheck({done,total:rows.length,running:true,current:leafName(file.path)});
          setFiles(current=>current.map(item=>item.path===file.path?{...item,validationState:'checking'}:item));
          try{
            const report=await validateGCode(activeClient,printerRef.current,file.path,validationController.signal);
            if(run!==validationRun.current)return;
            updates[file.path]={signature:file.signature,checkedAt:Date.now(),report};
            setFiles(current=>current.map(item=>item.path===file.path?{
              ...item,
              metadata:report.metadata??item.metadata,
              compatibility:reportCompatibility(report),
              validationState:'checked',
              validation:report,
            }:item));
          }catch(value){
            if(run!==validationRun.current)return;
            const message=String(value instanceof Error?value.message:value);
            setFiles(current=>current.map(item=>item.path===file.path?{...item,validationState:'failed',compatibility:{level:'unknown',reasons:[`Автопроверка не завершена: ${message}`]}}:item));
          }
          done++;
          setAutoCheck({done,total:rows.length,running:done<rows.length,current:''});
        }
        if(run!==validationRun.current)return;
        const latest=normalizeIndex(await dbGetStrict<Partial<FileIndex>>(storageKey,EMPTY_INDEX));
        const livePaths=new Set(rows.map(row=>row.path));
        const retained=Object.fromEntries(Object.entries(latest.validations).filter(([path])=>livePaths.has(path)));
        const next={...latest,validations:{...retained,...updates}};
        await dbSet(storageKey,next);
        if(run!==validationRun.current)return;
        setFileIndex(current=>({...current,validations:{...retained,...updates}}));
        setAutoCheck({done:rows.length,total:rows.length,running:false,current:''});
      })();
      validationTask.current=task;
      void task.catch(value=>{if(run===validationRun.current)setError(`Синхронизация файлов не завершена. ${String(value instanceof Error?value.message:value)}`)}).finally(()=>{if(validationTask.current===task)validationTask.current=undefined;if(validationAbort.current===validationController)validationAbort.current=undefined});
    } catch (value) {
      if(run===validationRun.current){
        let cached=fileIndexRef.current;
        try{cached=await hydrateCache()}catch{/* кеш не поднялся: ниже покажем причину, оставшись на прежнем снимке */}
        const reason=String(value instanceof Error?value.message:value);
        setError(cached.files.length?`Локальная синхронизация временно недоступна. Показан кеш файлов. ${reason}`:reason);
      }
    } finally {
      if(run===validationRun.current)setBusy(false);
      if(validationAbort.current===validationController&&!validationTask.current)validationAbort.current=undefined;
    }
  }, [client, storageKey, profileSignature,hydrateCache]);
  useEffect(() => {
    let active=true;
    void hydrateCache().then(cached=>{
      if(!active)return;
      if(canSync){void refresh();return}
      validationRun.current++;
      setBusy(false);
      setError(printer.status.remoteControlSuspended
        ?`Forge-X печатает автономно. ${cached.files.length?'Показан локальный кеш файлов. ':''}Синхронизация возобновится после запуска Moonraker.`
        :connectionState==='offline'
          ?`Moonraker не отвечает. ${cached.files.length?'Показан локальный кеш файлов. ':''}Повторная синхронизация запустится после восстановления локальной связи.`
          :'');
    }).catch(value=>{if(active){setBusy(false);setError(`Не удалось прочитать локальный кеш файлов: ${String(value instanceof Error?value.message:value)}`)}});
    return()=>{active=false;validationRun.current++;validationAbort.current?.abort('Панель закрыта');operationAbort.current?.abort('Панель закрыта')};
  }, [refresh,hydrateCache,canSync,printer.status.remoteControlSuspended]);

  const projects = useMemo(() => Array.from(new Set([
    ...(fileIndex.folders ?? []),
    ...Object.values(fileIndex.projects),
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b)), [fileIndex.folders, fileIndex.projects]);
  const visible = useMemo(() => files
    .filter(file => (project === 'all' || (project === 'none'
      ? !fileIndex.projects[file.path]
      : fileIndex.projects[file.path] === project))
      && file.path.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === 'material'
      ? (a.metadata?.filament_type ?? '').localeCompare(b.metadata?.filament_type ?? '')
      : sort === 'time'
        ? (b.metadata?.estimated_time ?? 0) - (a.metadata?.estimated_time ?? 0)
        : fileNameCollator.compare(a.path,b.path)), [files, fileIndex.projects, project, query, sort]);
  const filePage=usePagedRows(visible,JSON.stringify([printer.id,query,project,sort]));
  const stats = useMemo(() => {
    const compatible = files.filter(file => file.validationState==='checked'&&file.validation?.ok).length;
    const attention = files.filter(file => file.validationState==='checked'&&!file.validation?.ok||file.validationState==='failed').length;
    const totalSeconds = files.reduce((sum, file) => sum + (file.metadata?.estimated_time ?? 0), 0);
    const materials = new Set(files.map(file => file.metadata?.filament_type?.trim()).filter(Boolean)).size;
    return { compatible, attention, totalSeconds, materials };
  }, [files]);

  const upload = async (file: File) => {
    if (!client || !canOperate || !canSync) return;
    if (!/\.(?:gcode|gco)$/i.test(file.name)) {
      setError('Можно загрузить только заранее нарезанный файл .gcode или .gco.');
      return;
    }
    setBusy(true);
    setLongOperation('upload');
    setError('');
    setUploadProgress(0);
    try {
      // WebCrypto accepts only a complete ArrayBuffer. Keep that fast duplicate
      // check for small files; large G-code is hashed by the native streaming
      // uploader so WebView2 never holds another 100 MiB copy.
      const preliminaryHash = file.size<=WEBVIEW_HASH_LIMIT?await fileHash(file):undefined;
      const duplicate = preliminaryHash?fileIndex.hashes[preliminaryHash]:undefined;
      if (duplicate && files.some(item => item.path === duplicate)) {
        setQuery(duplicate);
        throw new Error(`Этот файл уже загружен как ${duplicate}`);
      }
      const path = await client.upload(file, setUploadProgress);
      const hash=preliminaryHash??client.uploadedSha256(path);
      const next: FileIndex = {
        hashes: hash?{ ...fileIndex.hashes, [hash]: path }:{...fileIndex.hashes},
        projects: { ...fileIndex.projects },
        folders: fileIndex.folders,
        validations:{...fileIndex.validations},
        files:fileIndex.files,
        lastSyncedAt:fileIndex.lastSyncedAt,
      };
      if (project !== 'all' && project !== 'none') next.projects[path] = project;
      await persistIndex(next);
      await audit('gcode.upload', `${path} → ${printer.name}`);
      await refresh();
    } catch (value) {
      setError(String(value));
    } finally {
      setLongOperation(undefined);
      setBusy(false);
      window.setTimeout(() => setUploadProgress(undefined), 700);
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    if(!canSync)return;
    const file = event.dataTransfer.files?.[0];
    if (file) void upload(file);
  };
  const rememberReport=async(file:PrinterFile,report:GCodeValidation)=>{
    const cached:CachedValidation={signature:file.signature,checkedAt:Date.now(),report};
    setFiles(current=>current.map(item=>item.path===file.path?{...item,metadata:report.metadata??item.metadata,compatibility:reportCompatibility(report),validationState:'checked',validation:report}:item));
    const latest=normalizeIndex(await dbGetStrict<Partial<FileIndex>>(storageKey,EMPTY_INDEX));
    const next={...latest,validations:{...latest.validations,[file.path]:cached}};
    await dbSet(storageKey,next);
    setFileIndex(current=>({...current,validations:{...current.validations,[file.path]:cached}}));
  };
  const validateForAction=async(file:PrinterFile,signal?:AbortSignal)=>{
    if(!client||!canSync)return;
    setFiles(current=>current.map(item=>item.path===file.path?{...item,validationState:'checking'}:item));
    const report=await validateGCode(client,printer,file.path,signal);
    await rememberReport(file,report);
    if(!report.ok)await audit('gcode.blocked',`${printer.name} · ${file.path}`);
    return report;
  };
  const start = async (file: PrinterFile) => {
    if (!client || !canOperate || !canSync) return;
    const pending=pendingLaunchRef.current;
    if(pending){setActionDialog(pending.dialog);setError('Предыдущий запуск ещё не подтверждён. Проверьте состояние принтера без повторной отправки команды.');return}
    setBusy(true);
    setError('');
    setNotice('');
    const controller=new AbortController();operationAbort.current=controller;setLongOperation('analysis');setAnalysisWaiting(true);
    try {
      await stopBackgroundValidation(controller.signal);
      setAnalysisWaiting(false);
      const report=await validateForAction(file,controller.signal);
      if(controller.signal.aborted||operationAbort.current!==controller)return;
      if(report)setActionDialog({kind:report.ok?'start':'blocked',file,report});
    } catch (value) {
      if(!controller.signal.aborted)setError(String(value));
    } finally {
      if(operationAbort.current===controller){operationAbort.current=undefined;setLongOperation(undefined);setAnalysisWaiting(false);setBusy(false)}
    }
  };
  const enqueue = async (file: PrinterFile) => {
    if (!client || !canOperate || !canSync) return;
    setBusy(true);
    setError('');
    setNotice('');
    const controller=new AbortController();operationAbort.current=controller;setLongOperation('analysis');setAnalysisWaiting(true);
    try {
      await stopBackgroundValidation(controller.signal);
      setAnalysisWaiting(false);
      const report=await validateForAction(file,controller.signal);
      if(controller.signal.aborted||operationAbort.current!==controller)return;
      if(!report)return;
      if(!report.ok){setActionDialog({kind:'blocked',file,report});return}
      setLongOperation(undefined);
      await client.enqueue([file.path]);
      await audit('print.queue_add', `${file.path} → ${printer.name}`);
      await refresh();
      setNotice(`${file.path} добавлен в очередь ${printerDisplayName(printer)}.`);
    } catch (value) {
      if(!controller.signal.aborted)setError(String(value));
    } finally {
      if(operationAbort.current===controller){operationAbort.current=undefined;setLongOperation(undefined);setAnalysisWaiting(false);setBusy(false)}
    }
  };
  const confirmAction=async()=>{
    const dialog=actionDialog;
    if(!dialog||!client||!canOperate||!canSync||busy||dialog.kind==='blocked')return;
    const unresolved=pendingLaunchRef.current;
    if(dialog.kind==='start'&&unresolved){pendingLaunchRef.current=unresolved;setPendingLaunch(unresolved);setActionDialog(unresolved.dialog);setError('Запуск пока не подтверждён. Нажмите «Проверить состояние»: команда повторно отправляться не будет.');return}
    const epoch=actionEpoch.current,printerId=printer.id,host=printer.host;
    const stillCurrent=()=>actionEpoch.current===epoch&&clientRef.current===client&&printerRef.current.id===printerId&&printerRef.current.host===host;
    let pending:PendingFileLaunch|undefined;
    setBusy(true);
    setError('');
    try {
      if(dialog.kind==='start'){
        pending={printerId,host,dialog};
        pendingLaunchRef.current=pending;setPendingLaunch(pending);
        await client.start(dialog.file.path,printStartOptionsFromValidation(dialog.report!));
        if(!stillCurrent())return;
        pendingLaunchRef.current=undefined;setPendingLaunch(undefined);
        setLaunchUnconfirmed(false);setRecoveringLaunch(false);
        void audit('print.validated_start',`${dialog.file.path} → ${printer.name}`).catch(()=>{});
        setActionDialog(undefined);
        onClose();
        return;
      }
      validationRun.current++;
      await client.deleteFile(dialog.file.path);
      const hashes=Object.fromEntries(Object.entries(fileIndex.hashes).filter(([,path])=>path!==dialog.file.path));
      const projects={...fileIndex.projects},validations={...fileIndex.validations};
      delete projects[dialog.file.path];
      delete validations[dialog.file.path];
      await persistIndex({...fileIndex,hashes,projects,folders:fileIndex.folders,validations,files:fileIndex.files.filter(item=>item.path!==dialog.file.path)});
      await audit('gcode.delete',`${dialog.file.path} · ${printer.name}`);
      setActionDialog(undefined);
      await refresh();
    } catch (value) {
      if(pending&&uncertainPrintStart(value)){
        diagnosticWarning('print.files_start_unconfirmed',value,{printerId,operation:'control.print_start'});
        if(stillCurrent()){setLaunchUnconfirmed(true);setError('');}
      }else{
        if(stillCurrent()){
          if(pendingLaunchRef.current===pending){pendingLaunchRef.current=undefined;setPendingLaunch(undefined)}
          setError(String(value));
        }
      }
    } finally {
      if(stillCurrent())setBusy(false);
    }
  };
  const recheckLaunch=async(automatic=false)=>{
    const pending=pendingLaunchRef.current;
    if(!client||!pending||busy||launchQueryRef.current||pending.printerId!==printer.id||pending.host!==printer.host)return 'pending';
    const epoch=actionEpoch.current;
    const stillCurrent=()=>actionEpoch.current===epoch&&pendingLaunchRef.current===pending&&clientRef.current===client&&printerRef.current.id===pending.printerId&&printerRef.current.host===pending.host;
    const query={};launchQueryRef.current=query;setCheckingLaunch(true);
    try{
      const observed=await client.checkPrintStart(pending.dialog.file.path);
      if(!stillCurrent())return 'stopped';
      if(observed.confirmed){
        launchQueryRef.current=undefined;setCheckingLaunch(false);
        pendingLaunchRef.current=undefined;setPendingLaunch(undefined);setActionDialog(undefined);setError('');setLaunchUnconfirmed(false);setRecoveringLaunch(false);
        void audit('print.start_recovered',`${pending.dialog.file.path} → ${printer.name}`).catch(()=>{});onClose();
        return 'confirmed';
      }
      if(observed.state==='error'||((observed.state==='printing'||observed.state==='paused')&&observed.filename)){
        setError(observed.state==='error'?`Принтер сообщил ошибку: ${observed.message||'проверьте экран принтера'}`:'Принтер выполняет другое задание. Повторная команда не отправлялась.');setRecoveringLaunch(false);return 'stopped';
      }
      if(!automatic)setError('Запуск пока не подтверждён. Повторная команда не отправлялась.');
      return 'pending';
    }catch(value){
      diagnosticWarning('print.files_recheck',value,{printerId:pending.printerId,operation:'control.check_print_start'});
      if(!stillCurrent())return 'stopped';
      if(!automatic)setError('Не удалось получить состояние принтера. Повторная команда не отправлялась.');
      return 'pending';
    }finally{if(launchQueryRef.current===query){const current=stillCurrent();launchQueryRef.current=undefined;if(current)setCheckingLaunch(false)}}
  };
  // A missing command reply starts read-only recovery, never another launch.
  useEffect(()=>{
    if(!launchUnconfirmed||!pendingLaunch||!client)return;
    let stopped=false,timer:number|undefined;
    const deadline=Date.now()+90_000;
    const active=()=>!stopped&&pendingLaunchRef.current===pendingLaunch&&clientRef.current===client&&printerRef.current.id===pendingLaunch.printerId&&printerRef.current.host===pendingLaunch.host;
    setRecoveringLaunch(true);
    const check=async()=>{
      if(!active())return;
      if(Date.now()>=deadline){setRecoveringLaunch(false);setError('Принтер не подтвердил запуск за время автоматической проверки. Повторная команда не отправлялась.');return;}
      const result=await recheckLaunch(true);
      if(!active())return;
      if(result==='stopped'||result==='confirmed'){setRecoveringLaunch(false);return;}
      timer=window.setTimeout(()=>void check(),Math.min(2_000,Math.max(0,deadline-Date.now())));
    };
    timer=window.setTimeout(()=>void check(),0);
    return()=>{stopped=true;if(timer!==undefined)window.clearTimeout(timer)};
  },[launchUnconfirmed,pendingLaunch,client,printer.id,printer.host]);
  const closeAction=()=>{
    if(busy)return;
    // Closing an unresolved action is intentional. A later attempt must run
    // preflight again, just like the existing local-library workflow.
    actionEpoch.current++;pendingLaunchRef.current=undefined;launchQueryRef.current=undefined;setPendingLaunch(undefined);setActionDialog(undefined);setError('');setLaunchUnconfirmed(false);setRecoveringLaunch(false);setCheckingLaunch(false);
  };
  const remove=(file:PrinterFile)=>{if(client&&canOperate&&canSync)setActionDialog({kind:'delete',file})};
  const assignProject = async (path: string, value: string) => {
    const indexedProjects = { ...fileIndex.projects };
    if (value) indexedProjects[path] = value;
    else delete indexedProjects[path];
    await persistIndex({ ...fileIndex, projects: indexedProjects });
  };
  const createProject = () => {
    const value = newProject.trim().slice(0, 60);
    if (!value) return;
    const folders = Array.from(new Set([...(fileIndex.folders ?? []), value]));
    persistIndex({ ...fileIndex, folders }).catch(value => setError(String(value)));
    setProject(value);
    setNewProject('');
  };

  const printerState = printer.status.remoteControlSuspended?'local':printer.status.connectionState==='offline'?'offline':printer.status.connectionState==='degraded'?'error':printer.status.connectionState==='connecting'?'connecting':printer.status.state;
  const nodeDetail = usingCache
    ?`Локальный кеш${fileIndex.lastSyncedAt?` · синхронизирован ${new Date(fileIndex.lastSyncedAt).toLocaleString('ru-RU')}`:''}`
    : printer.status.remoteControlSuspended
    ? 'Автономная печать · Moonraker временно остановлен G-code'
    : printer.status.connectionState === 'offline'
    ? 'Moonraker не отвечает'
    : printer.status.connectionState === 'connecting'
      ? 'Проверяем адрес и API Moonraker'
      : printer.status.connectionState === 'degraded'
        ? printer.status.connectionMessage||'Moonraker доступен, телеметрия уточняется'
    : printer.status.filename
      ? leafName(printer.status.filename)
      : `Moonraker синхронизирован${printer.status.latency !== undefined ? ` · ${printer.status.latency} мс` : ''}`;

  return <div className="modalBackdrop top printerFilesBackdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="panel printerFilesPanel" role="dialog" aria-modal="true" aria-labelledby="printer-files-title">
      <header className="panelHead printerFilesHead">
        <div className="printerFilesTitle">
          <i><Usb /></i>
          <span>
            <small>{source==='printer'?'PRINTER STORAGE / MOONRAKER':'LOCAL STORAGE / OFFLINE'}</small>
            <h2 id="printer-files-title">{source==='printer'?'Файлы принтера':'Моя флешка'}</h2>
            <p>{source==='printer'?`${printerDisplayName(printer)} · отдельное хранилище G-code`:libraryDescription}</p>
          </span>
        </div>
        <div className="printerFilesHeadActions">
          <span className={`printerFilesConnection state-${source==='local'?'ready':printerState}`}><i />{source==='local'?<HardDrive/>:<Wifi />}{source==='local'?'Доступно офлайн':usingCache?'Локальный кеш':stateLabel(printer.status)}</span>
          {longOperation&&<button type="button" className="danger" onClick={()=>longOperation==='upload'?client?.cancelUpload():operationAbort.current?.abort('Операция отменена пользователем')}><X/><span>{longOperation==='upload'?'Отменить загрузку':'Отменить анализ'}</span></button>}
          {source==='printer'&&<button type="button" disabled={busy||!canSync} onClick={refresh}><RefreshCw className={busy ? 'spin' : ''} /><span>Обновить</span></button>}
          <button type="button" className="round" title="Закрыть" aria-label="Закрыть файлы принтера" onClick={onClose}><X /></button>
        </div>
      </header>

      <div className="printerFilesSourceTabs" role="tablist" aria-label="Источник G-code">
        <button type="button" role="tab" aria-selected={source==='printer'} className={source==='printer'?'active':''} onClick={()=>{setSource('printer');if(canSync)void refresh()}}><Database/><span><b>На принтере</b><small>Moonraker · {files.length} файлов</small></span></button>
        <button type="button" role="tab" aria-selected={source==='local'} className={source==='local'?'active':''} onClick={()=>{void stopBackgroundValidation();setSource('local')}}><HardDrive/><span><b>Моя флешка</b><small>{librarySharedByModel?`${libraryLabel} · общая для ${libraryPeerIds.length}`:`${printerDisplayName(printer)} · отдельно`}</small></span></button>
      </div>

      {source==='local'?<LocalLibraryPanel printer={printer} libraryScopeId={libraryId} libraryScopeLabel={libraryLabel} librarySharedByModel={librarySharedByModel} sourcePrinterIds={libraryPeerIds} client={client} canOperate={canOperate} canSync={canSync} onPrinted={onClose}/>:<>

      <div className={`printerFilesOverview state-${printerState}`}>
        <div className="printerFilesNode">
          <i><Activity /></i>
          <span><small>СОСТОЯНИЕ УЗЛА</small><strong>{usingCache?'Данные доступны офлайн':stateLabel(printer.status)}</strong><em title={nodeDetail}>{nodeDetail}</em></span>
        </div>
        <div className="printerFilesStats">
          <div><Database /><span><strong>{files.length}</strong><small>файлов</small><em>{visible.length} показано</em></span></div>
          <div className={stats.attention ? 'warning' : 'success'}><CheckCircle2 /><span><strong>{stats.compatible}</strong><small>проверены</small><em>{autoCheck.running?`${autoCheck.done} из ${autoCheck.total}`:stats.attention?`${stats.attention} заблокированы`:'автопроверка завершена'}</em></span></div>
          <div><Clock3 /><span><strong>{duration(stats.totalSeconds)}</strong><small>время печати</small><em>всего в хранилище</em></span></div>
          <div><Layers3 /><span><strong>{stats.materials}</strong><small>материалов</small><em>{projects.length} проектов</em></span></div>
        </div>
      </div>

      <div
        className={`printerFilesDrop ${dragActive ? 'active' : ''} ${busy ? 'busy' : ''}`}
        aria-busy={uploadProgress !== undefined}
        onDragEnter={event => { event.preventDefault(); if(canSync)setDragActive(true); }}
        onDragOver={event => event.preventDefault()}
        onDragLeave={event => { if (event.currentTarget === event.target) setDragActive(false); }}
        onDrop={drop}
      >
        <div className="printerFilesDropCopy">
          <i><Upload /></i>
          <span><small>БЫСТРАЯ ЗАГРУЗКА</small><b>{dragActive ? 'Отпустите файл — он готов к отправке' : 'Добавить готовый G-code'}</b><em>.gcode или .gco · проверка дублей · загрузка прямо в Moonraker</em></span>
        </div>
        <label className={`button printerFilesUploadButton ${!canOperate || busy || !canSync ? 'disabled' : ''}`} aria-disabled={!canOperate || busy || !canSync}>
          <Upload />Выбрать файл
          <input
            hidden
            disabled={!canOperate || busy || !canSync}
            type="file"
            accept=".gcode,.gco"
            onChange={event => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (file) void upload(file);
            }}
          />
        </label>
        {uploadProgress !== undefined && <div className="printerUploadProgress">
          <i style={{ width: `${uploadProgress}%` }} />
          <span>{uploadProgress === 0 ? 'Проверка файла' : 'Отправка в Moonraker'} · {uploadProgress}%</span>
          <button type="button" onClick={()=>client?.cancelUpload()}><X/>Отменить</button>
        </div>}
      </div>

      <div className="printerFilesCommandBar">
        <div className="printerFilesFilters">
          <label className="printerFilesSearch"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск по имени файла…" aria-label="Поиск по имени файла" /></label>
          <label><Folder /><select value={project} onChange={event => setProject(event.target.value)} aria-label="Фильтр по проекту"><option value="all">Все проекты</option><option value="none">Без проекта</option>{projects.map(value => <option key={value}>{value}</option>)}</select></label>
          <label><SlidersHorizontal /><select value={sort} onChange={event => setSort(event.target.value as typeof sort)} aria-label="Сортировка файлов"><option value="name">По имени</option><option value="material">По материалу</option><option value="time">По времени</option></select></label>
          <div className="printerFilesNewProject"><input value={newProject} onChange={event => setNewProject(event.target.value)} placeholder="Новый проект" aria-label="Название нового проекта" maxLength={60} /><button type="button" disabled={!newProject.trim()} title="Создать проект" aria-label="Создать проект" onClick={createProject}><FolderPlus /></button></div>
        </div>
        <div className="printerFilesResult"><b>{visible.length}</b><span>из {files.length}</span></div>
      </div>

      {!!autoCheck.total&&<div className={`printerFilesAutoCheck ${autoCheck.running?'running':autoCheck.current?'paused':'complete'}`}>
        <ShieldCheck />
        <span><b>{autoCheck.running?'Автоматическая проверка G-code':autoCheck.current?'Автопроверка безопасно приостановлена':'Автоматическая проверка завершена'}</b><small>{autoCheck.running?(autoCheck.current?`Проверяем: ${autoCheck.current}`:'Подготовка следующего файла'):autoCheck.current||`Проверено ${autoCheck.done} из ${autoCheck.total}`}</small></span>
        <progress max={autoCheck.total} value={autoCheck.done}/>
        <strong>{autoCheck.done}/{autoCheck.total}</strong>
        {autoCheck.running&&<button type="button" onClick={()=>void stopBackgroundValidation()}><X/>Остановить</button>}
      </div>}
      {notice&&<div className="printerFilesNotice"><CheckCircle2 /><span>{notice}</span><button type="button" aria-label="Закрыть сообщение" onClick={()=>setNotice('')}><X /></button></div>}
      {longOperation==='analysis'&&<div className="printerFilesNotice" role="status"><RefreshCw className="spin"/><span>{analysisWaiting?'Ожидаем завершения текущего запроса принтера…':'Проверяем выбранный G-code…'}</span></div>}
      {error && <div className="printerFilesError"><ShieldAlert />{error}</div>}
      <div className="printerFilesList" ref={fileListRef}>
        {filePage.rows.map(file => {
          const badge = file.compatibility.level;
          const material = file.metadata?.filament_type?.trim() || 'Материал не указан';
          const name = leafName(file.path);
          const checking=file.validationState==='checking',queued=file.validationState==='queued';
          const badgeText=checking?'Проверяется':queued?'В очереди проверки':file.validationState==='failed'?'Ошибка проверки':badge==='blocked'?'Заблокирован':badge==='warning'?'Проверен · замечания':'Проверен';
          return <article className={`printerFileCard compat-${badge} material-${materialTone(material)}`} key={file.path}>
            <div className="printerFileThumb">
              <GCodeThumbnail client={canSync?client:undefined} filename={file.path} metadata={file.metadata} identity={file} fallback={<FileCode2 />} alt={`Предпросмотр ${name}`} />
              <span>{material === 'Материал не указан' ? 'G-CODE' : material}</span>
            </div>
            <div className="printerFileInfo">
              <div className="printerFileHeading">
                <span><b title={file.path}>{name}</b>{name !== file.path && <small title={file.path}>{file.path}</small>}</span>
                <span className={`compatBadge ${badge} state-${file.validationState}`} title={file.compatibility.reasons.join('\n')}>
                  {checking?<RefreshCw className="spin"/>:queued?<ShieldCheck/>:badge==='compatible'?<CheckCircle2/>:<ShieldAlert/>}
                  {badgeText}
                </span>
              </div>
              <div className="printerFileMeta">
                <span className="material"><Layers3 />{material}</span>
                <span><Clock3 />{duration(file.metadata?.estimated_time)}</span>
                <span><FileCode2 />{file.metadata?.slicer ?? 'G-code'}</span>
              </div>
              <div className="printerFileSpecs">
                <span>Сопло <b>{file.metadata?.nozzle_diameter ? `${file.metadata.nozzle_diameter} мм` : '—'}</b></span>
                <span>Слой <b>{file.metadata?.layer_height ? `${file.metadata.layer_height} мм` : '—'}</b></span>
                <span>Высота <b>{file.metadata?.object_height ? `${file.metadata.object_height} мм` : '—'}</b></span>
              </div>
            </div>
            <aside className="printerFileControls">
              <label className="printerFileProject"><span><Folder />Проект</span><select disabled={!canOperate} value={fileIndex.projects[file.path] ?? ''} onChange={event => assignProject(file.path, event.target.value)}><option value="">Без проекта</option>{projects.map(value => <option key={value}>{value}</option>)}</select></label>
              <div className="printerFileActions">
                <button type="button" className="primary" disabled={!canOperate || !canSync || busy || checking || printer.status.state !== 'ready' || printer.status.connectionState !== 'online'} title={printer.status.state === 'ready'&&printer.status.connectionState==='online' ? 'Повторная проверка и запуск по локальной сети' : 'Печать доступна, когда локальный Moonraker и Klipper готовы'} onClick={() => start(file)}><Play />Печать</button>
                <button type="button" disabled={!canOperate || !canSync || busy || checking} title="Повторно проверить и добавить в очередь" onClick={() => enqueue(file)}><ListPlus />В очередь</button>
                <button type="button" className="danger" disabled={!canOperate || !canSync || busy} title="Удалить с принтера" aria-label={`Удалить ${name}`} onClick={() => remove(file)}><Trash2 /></button>
              </div>
            </aside>
          </article>;
        })}
        {!visible.length && !busy && !error && <div className="printerFilesEmpty"><Usb /><b>{files.length ? 'Файлы не подходят под фильтр' : 'На этом принтере пока нет G-code'}</b><span>{files.length ? 'Измените поиск, проект или способ сортировки.' : 'Загрузите заранее нарезанный файл для этой модели принтера.'}</span></div>}
        {busy && !files.length && <div className="printerFilesEmpty loading"><RefreshCw className="spin" /><b>Синхронизируем хранилище Moonraker…</b><span>Читаем файлы, превью и метаданные.</span></div>}
      </div>
      <ListPagination count={visible.length} page={filePage.page} onPageChange={page=>{filePage.setPage(page);fileListRef.current?.scrollTo({top:0})}}/>
      {actionDialog&&<div className="printerFileDialogBackdrop" onMouseDown={event=>{if(event.target===event.currentTarget)closeAction()}}>
        <section className={`printerFileDialog ${actionDialog.kind}`} role="dialog" aria-modal="true" aria-labelledby="printer-file-dialog-title">
          <header><i>{actionDialog.kind==='start'?<Play/>:<ShieldAlert/>}</i><span><small>G-CODE PREFLIGHT</small><b id="printer-file-dialog-title">{actionDialog.kind==='start'?(pendingLaunch?'Ожидаем подтверждения запуска':'Файл готов к печати'):actionDialog.kind==='delete'?'Удалить файл с принтера?':'Запуск заблокирован'}</b><em>{actionDialog.file.path}</em></span><button type="button" disabled={busy} onClick={closeAction}><X /></button></header>
          {actionDialog.kind==='start'&&pendingLaunch&&<p className={recoveringLaunch?'printerFileLaunchRecovery':undefined} role="status" aria-live="polite">{recoveringLaunch&&<RefreshCw className="spin"/>}{busy?'Ожидаем ответ принтера…':recoveringLaunch?'Автоматически проверяем запуск на принтере. Повторная команда не отправляется.':error||'Команда уже отправлена. Можно проверить состояние принтера без повторного запуска.'}</p>}
          {actionDialog.kind==='delete'
            ?<p>Файл будет удалён из хранилища {printerDisplayName(printer)}. Это действие нельзя отменить.</p>
            :<div className="printerFileIssueList">{actionDialog.report?.issues.map(issue=><div className={issue.level} key={`${issue.code}:${issue.message}`}><i>{issue.level==='error'?<ShieldAlert/>:<CheckCircle2/>}</i><span>{issue.message}</span></div>)}</div>}
          <footer><button type="button" disabled={busy} onClick={closeAction}>{pendingLaunch?'Закрыть':'Отмена'}</button>{actionDialog.kind==='start'&&pendingLaunch?<button type="button" className="primary" disabled={busy||checkingLaunch||recoveringLaunch||!canSync} onClick={()=>void recheckLaunch()}><RefreshCw className={checkingLaunch||recoveringLaunch?'spin':''}/>{recoveringLaunch?'Проверяем автоматически…':checkingLaunch?'Проверяем состояние…':'Проверить состояние'}</button>:actionDialog.kind!=='blocked'&&<button type="button" className={actionDialog.kind==='delete'?'danger':'primary'} disabled={busy} onClick={confirmAction}>{busy?<RefreshCw className="spin"/>:actionDialog.kind==='start'?<Play/>:<Trash2/>}{actionDialog.kind==='start'?`Запустить на ${printerDisplayName(printer)}`:'Удалить файл'}</button>}{actionDialog.kind==='blocked'&&<>{onSettings&&<button type="button" onClick={()=>{closeAction();onSettings()}}><SlidersHorizontal/>Настройки принтера</button>}<button type="button" className="primary" onClick={closeAction}>Понятно</button></>}</footer>
        </section>
      </div>}
      </>}
    </section>
  </div>;
}
