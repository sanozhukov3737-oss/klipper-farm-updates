import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileArchive, LoaderCircle, Plus, Radar, RefreshCw, SearchX, TriangleAlert, X } from 'lucide-react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DiscoveredPrinter, DiscoveryAdapter, DiscoveryDiagnostics, DiscoveryFound, DiscoveryResult, NetworkEnvironmentSnapshot, PrinterConfig, PrinterModel } from '../types';
import { MoonrakerClient, type PrinterDetection } from '../lib/moonraker';
import { secureInvoke } from '../lib/auth';
import { FLASHFORGE_5M_DISPLAY_NAME } from '../lib/printerDetection';
import { printerEndpointKey, printerHostDisplay } from '../lib/printerEndpoint';
import { samePhysicalPrinter } from '../lib/deviceIdentity';
import { diagnosticZipCreate } from '../lib/native';
import { diagnosticEntries } from '../lib/diagnosticLog';
import { appAlert, appConfirm } from '../lib/appDialogs';
import { getCatalogModel, type PrinterCatalogModel } from '../lib/printerCatalog';
import { PrinterModelPicker } from './PrinterModelPicker';

type DiscoveryPhase='idle'|'scanning'|'identifying'|'done'|'cancelling'|'cancelled'|'error';
type DetectionState='auth-required'|'http-response'|'not-moonraker'|'queued'|'detecting'|'done'|'error';
const MAX_IDENTIFY_RESULTS=64;
const IDENTIFY_DEADLINE_MS=30_000;

type DiscoveryRuntimeResult=DiscoveryResult&Partial<{
  operation_id:string;
  operationId:string;
  scanned:number;
  total:number;
  cancelled:boolean;
  timed_out:boolean;
  timedOut:boolean;
  duration_ms:number;
  durationMs:number;
}>;

type DiscoveryProgress={
  operation_id?:string;
  operationId?:string;
  phase:'started'|'hybrid'|'scanning'|'retrying'|'complete'|'cancelled'|'timed_out';
  scanned:number;
  total:number;
  found:number;
};

type DetectionCompat=PrinterDetection&Partial<{
  fingerprint:string;
  engineVersion:number;
  selectedModelId:string;
  modelId:string;
  configSnapshot:unknown;
  snapshot:unknown;
}>;

export type IdentifiedDiscoveredPrinter=DiscoveredPrinter&{
  /** Stable UI identity; enrichment may add UUID/hostname without replacing the row. */
  discoveryRowId:string;
  /** User-selected catalogue identity; never used as detected/native model ID. */
  catalogModelId?:string;
  detection?:DetectionCompat;
  detectionState:DetectionState;
  detectionError?:string;
  cameraCount?:number;
  cameraChecked?:boolean;
  /** Ephemeral: validated in the native process and persisted only through secretSet. */
  apiKeyForAdd?:string;
  /** A strong identity collision must be explicitly accepted before saving. */
  identityConflictAccepted?:boolean;
  routeSwitches?:number;
  routeHistory?:string[];
};

type Props={
  open:boolean;
  printers:PrinterModel[];
  onClose:()=>void;
  onAdd:(printer:IdentifiedDiscoveredPrinter)=>boolean|void|Promise<boolean|void>;
  onAddAll:(printers:IdentifiedDiscoveredPrinter[])=>boolean|void|Promise<boolean|void>;
};

type ApiKeyValidation={valid:boolean;protocol:'rest'|'websocket';port:number;klippy_state?:string;moonraker_version?:string;message:string};
type CredentialDraft={value:string;state:'idle'|'validating'|'valid'|'error';error?:string};
type IdentifyTask={id:string;key:string;row:IdentifiedDiscoveredPrinter;apiKey?:string};
type DiscoveryHistoryEntry={id:string;startedAt:string;durationMs:number;found:number;confirmed:number;timedOut:boolean;fastRecovery:boolean;subnets:string[];counts:Record<string,number>;adapters:string[];routes:string[];errors:number;routeSwitches:number};

const DISCOVERY_HISTORY_KEY='klipper-discovery-history-v206';
// New key deliberately clears adapter choices learned before iProxy and other
// VPN drivers were classified. Users can still opt into them explicitly.
// Version the persisted selection so an adapter that an older build
// accidentally treated as physical (for example iProxy/Wintun) cannot remain
// silently enabled after the VPN filtering rules are corrected.
const DISCOVERY_ADAPTERS_KEY='klipper-discovery-adapters-v208';
const loadStringList=(key:string)=>{try{const value=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value.filter(item=>typeof item==='string').slice(0,32):[]}catch{return[]}};
const loadDiscoveryHistory=():DiscoveryHistoryEntry[]=>{try{const value=JSON.parse(localStorage.getItem(DISCOVERY_HISTORY_KEY)||'[]');return Array.isArray(value)?value.slice(0,10):[]}catch{return[]}};

const operationId=()=>globalThis.crypto?.randomUUID?.()??`discovery-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const operationIdOf=(value:{operation_id?:string;operationId?:string})=>value.operation_id??value.operationId;
const errorText=(error:unknown)=>String(error instanceof Error?error.message:error).replace(/^Error:\s*/,'');

function detectedModel(detection?:DetectionCompat){
  return String(detection?.model??detection?.selectedModelId??detection?.modelId??'custom');
}

const PRESET_NAMES:Record<string,string>={
  'ender3-v3-ke':'Ender-3 V3 KE',
  'ender3-v3-se':'Ender-3 V3 SE',
  'creality-k1c':'Creality K1C',
  'creality-k1c-2025':'Creality K1C',
  'creality-k1-max':'Creality K1 Max',
  'flashforge-ad5m':FLASHFORGE_5M_DISPLAY_NAME,
};

function likelyCandidate(detection?:DetectionCompat){
  const candidate=detection?.candidates?.[0];
  return candidate&&candidate.score>=24?candidate.model:undefined;
}

function detectedName(row:IdentifiedDiscoveredPrinter){
  const detection=row.detection;
  const model=detectedModel(detection);
  if(model!=='custom'&&PRESET_NAMES[model])return PRESET_NAMES[model];
  const candidate=likelyCandidate(detection);
  if(candidate&&PRESET_NAMES[candidate])return `Возможно: ${PRESET_NAMES[candidate]}`;
  if(detection?.name)return detection.name;
  if(row.detectedName)return row.detectedName;
  return `Klipper · ${row.ip}`;
}

const catalogName=(entry:PrinterCatalogModel)=>entry.model.toLowerCase().startsWith(entry.brand.toLowerCase())?entry.model:`${entry.brand} ${entry.model}`;

function confidenceLabel(detection?:DetectionCompat){
  if(!detection)return 'модель не определена';
  const status=String(detection.status??'');
  if(status==='ambiguous')return 'нужна проверка модели';
  if(status==='unknown')return 'модель не определена';
  if(status==='confirmed')return 'определено точно';
  if(status==='probable')return 'определено предварительно';
  const confidence=(detection as unknown as Record<string,unknown>).confidence;
  if(typeof confidence==='number')return confidence>=.8?'определено точно':confidence>=.55?'определено предварительно':'низкая уверенность';
  return confidence==='high'?'определено точно':confidence==='medium'?'определено предварительно':'модель не определена';
}

const EVIDENCE_LABELS:Record<string,string>={
  'identity.exact.flashforge-ad5m':`модель ${FLASHFORGE_5M_DISPLAY_NAME}`,
  'config.signature.flashforge-ad5m':`конфигурация ${FLASHFORGE_5M_DISPLAY_NAME}`,
  'levelling.ad5m-load-cell':`тензодатчик ${FLASHFORGE_5M_DISPLAY_NAME}`,
  'board.ad5m-level-pins':`контур калибровки ${FLASHFORGE_5M_DISPLAY_NAME}`,
  'platform.ad5m-power-pins':`управление питанием ${FLASHFORGE_5M_DISPLAY_NAME}`,
  'platform.ad5m-fan-layout':`система вентиляторов ${FLASHFORGE_5M_DISPLAY_NAME}`,
  'firmware.flashforge-klipper':'прошивка FlashForge Klipper',
  'geometry.centered-flashforge-220':`центрированная геометрия ${FLASHFORGE_5M_DISPLAY_NAME}`,
  'manufacturer.flashforge':'производитель FlashForge',
  'kinematics.corexy':'кинематика CoreXY',
  'kinematics.cartesian':'декартова кинематика',
};

function evidenceLabel(value:string){
  if(EVIDENCE_LABELS[value])return EVIDENCE_LABELS[value];
  const geometry=value.match(/^geometry\.(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if(geometry)return `рабочая зона ${geometry[1]}×${geometry[2]}×${geometry[3]} мм`;
  if(value.toLowerCase().includes('ad5m'))return `признак платформы ${FLASHFORGE_5M_DISPLAY_NAME}`;
  return value;
}

function firstEvidence(detection?:DetectionCompat,row?:DiscoveredPrinter){
  const selected=detectedModel(detection);
  const target=selected!=='custom'?selected:detection?.candidates?.[0]?.model;
  const supplied=detection?.evidence??row?.evidence??[];
  const evidence=(supplied.find(value=>typeof value==='object'&&value!==null&&String((value as unknown as Record<string,unknown>).model??'')===target)??supplied[0]) as unknown;
  if(typeof evidence==='string')return evidenceLabel(evidence);
  if(evidence&&typeof evidence==='object'){
    const item=evidence as Record<string,unknown>;
    return evidenceLabel(String(item.id??item.message??item.label??item.code??''));
  }
  return '';
}

const normalizedIdentity=(value?:string)=>value?.trim().replace(/\.$/,'').toLowerCase()||undefined;
const rowIdentity=(row:DiscoveredPrinter)=>row.deviceIdentity??(row.detection as DetectionCompat|undefined)?.deviceIdentity;
const savedIdentityConflict=(printer:PrinterModel,row:DiscoveredPrinter)=>{
  const identity=rowIdentity(row);
  const savedUuid=normalizedIdentity(printer.deviceIdentity?.signals.uuid);
  const foundUuid=normalizedIdentity(identity?.signals.uuid??row.moonraker_uuid);
  if(savedUuid&&foundUuid)return savedUuid!==foundUuid;
  return !!printer.deviceIdentity?.dedupeSafe&&!!identity?.dedupeSafe&&printer.deviceIdentity.stableId!==identity.stableId;
};
const matchingPrinter=(printers:PrinterModel[],row:DiscoveredPrinter)=>printers.find(printer=>
  !savedIdentityConflict(printer,row)&&(
    samePhysicalPrinter(printer.deviceIdentity,rowIdentity(row))
    ||printerEndpointKey(printer.host)===printerEndpointKey(row.host)
  )
);

const strongIdentityConflict=(left:DiscoveredPrinter,right:DiscoveredPrinter)=>{
  const stableLeft=normalizedIdentity(left.stable_id),stableRight=normalizedIdentity(right.stable_id);
  const uuidLeft=normalizedIdentity(left.moonraker_uuid),uuidRight=normalizedIdentity(right.moonraker_uuid);
  const deviceLeft=rowIdentity(left),deviceRight=rowIdentity(right);
  if(uuidLeft&&uuidRight)return uuidLeft!==uuidRight;
  if(deviceLeft?.dedupeSafe&&deviceRight?.dedupeSafe)return deviceLeft.stableId!==deviceRight.stableId;
  return !!stableLeft&&!!stableRight&&stableLeft!==stableRight;
};
const strongIdentityMatch=(left:DiscoveredPrinter,right:DiscoveredPrinter)=>(!!normalizedIdentity(left.stable_id)&&normalizedIdentity(left.stable_id)===normalizedIdentity(right.stable_id))
  ||(!!normalizedIdentity(left.moonraker_uuid)&&normalizedIdentity(left.moonraker_uuid)===normalizedIdentity(right.moonraker_uuid))
  ||samePhysicalPrinter(rowIdentity(left),rowIdentity(right));
const sameDiscoveryRow=(left:DiscoveredPrinter,right:DiscoveredPrinter)=>!strongIdentityConflict(left,right)&&(
  strongIdentityMatch(left,right)
  ||left.ip===right.ip
  ||(!!normalizedIdentity(left.hostname)&&normalizedIdentity(left.hostname)===normalizedIdentity(right.hostname))
);
const conflictIdentityLabels=(row:DiscoveredPrinter)=>[
  row.stable_id&&`stable:${normalizedIdentity(row.stable_id)}`,
  row.moonraker_uuid&&`uuid:${normalizedIdentity(row.moonraker_uuid)}`,
  rowIdentity(row)?.dedupeSafe&&`device:${rowIdentity(row)?.stableId}`,
].filter((value):value is string=>!!value);
const savedIdentityLabels=(printer:PrinterModel)=>[
  printer.deviceIdentity?.signals.uuid&&`uuid:${normalizedIdentity(printer.deviceIdentity.signals.uuid)}`,
  printer.deviceIdentity?.dedupeSafe&&`device:${printer.deviceIdentity.stableId}`,
].filter((value):value is string=>!!value);
const uniqueStrings=(values:(string|undefined)[])=>[...new Set(values.filter((value):value is string=>!!value))].sort();
const generatedRowId=()=>`row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const rowKey=(row:DiscoveredPrinter)=>('discoveryRowId'in row&&typeof row.discoveryRowId==='string')?row.discoveryRowId:row.stable_id?`stable:${row.stable_id}`:row.moonraker_uuid?`uuid:${row.moonraker_uuid}`:row.hostname?`host:${normalizedIdentity(row.hostname)}`:`ip:${row.ip}`;

function discoveryRank(row:DiscoveredPrinter){
  if(row.moonraker_confirmed&&!row.auth_required)return 0;
  if(row.auth_required)return 1;
  if(row.probe_state==='not_moonraker')return 2;
  return 3;
}

function mergeFoundRow(current:IdentifiedDiscoveredPrinter|undefined,incoming:DiscoveredPrinter):IdentifiedDiscoveredPrinter{
  const supplied=(incoming as DiscoveredPrinter&{detection?:DetectionCompat}).detection;
  if(!current){
    const detectionState:DetectionState=incoming.auth_required?'auth-required':!incoming.moonraker_confirmed?(incoming.probe_state==='not_moonraker'?'not-moonraker':'http-response'):supplied?'done':'queued';
    return {...incoming,discoveryRowId:generatedRowId(),detection:supplied,detectionState};
  }
  const incomingWins=discoveryRank(incoming)<discoveryRank(current)
    ||(discoveryRank(incoming)===discoveryRank(current)&&incoming.port===7125&&current.port!==7125);
  const endpointChanged=incomingWins&&printerEndpointKey(current.host)!==printerEndpointKey(incoming.host);
  const combined=incomingWins
    ?{...current,...incoming,discoveryRowId:current.discoveryRowId}
    :{...incoming,...current,stable_id:current.stable_id??incoming.stable_id,moonraker_uuid:current.moonraker_uuid??incoming.moonraker_uuid,hostname:current.hostname??incoming.hostname};
  const merged:IdentifiedDiscoveredPrinter={
    ...combined,
    discoveryRowId:current.discoveryRowId,
    catalogModelId:current.catalogModelId,
    detection:supplied??current.detection,
    detectionState:current.detectionState,
    identity_conflict:current.identity_conflict??incoming.identity_conflict,
    conflict_hosts:uniqueStrings([...(current.conflict_hosts??[]),...(incoming.conflict_hosts??[])]),
    conflict_identities:uniqueStrings([...(current.conflict_identities??[]),...(incoming.conflict_identities??[])]),
    identityConflictAccepted:current.identityConflictAccepted,
  };
  if(merged.auth_required)return {...merged,detection:undefined,detectionState:'auth-required',detectionError:undefined,apiKeyForAdd:undefined};
  if(!merged.moonraker_confirmed)return {...merged,detection:undefined,detectionState:merged.probe_state==='not_moonraker'?'not-moonraker':'http-response',detectionError:undefined,apiKeyForAdd:undefined};
  if(endpointChanged)return {...merged,detection:supplied,detectionState:supplied?'done':'queued',detectionError:undefined};
  return {...merged,detection:supplied??current.detection,detectionState:supplied?'done':current.detectionState==='auth-required'?'queued':current.detectionState};
}

function collapseDiscoveryRows(rows:IdentifiedDiscoveredPrinter[]){
  const output:IdentifiedDiscoveredPrinter[]=[];
  for(const row of rows){
    const index=output.findIndex(current=>sameDiscoveryRow(current,row));
    if(index<0){output.push(row);continue}
    const current=output[index],rowWins=discoveryRank(row)<discoveryRank(current);
    const primary=rowWins?row:current,secondary=rowWins?current:row;
    output[index]={...secondary,...primary,discoveryRowId:current.discoveryRowId,catalogModelId:current.catalogModelId??row.catalogModelId,detection:primary.detection??secondary.detection,deviceIdentity:primary.deviceIdentity??secondary.deviceIdentity,cameraCount:primary.cameraCount??secondary.cameraCount,cameraChecked:primary.cameraChecked??secondary.cameraChecked,identity_conflict:primary.identity_conflict??secondary.identity_conflict,conflict_hosts:uniqueStrings([...(primary.conflict_hosts??[]),...(secondary.conflict_hosts??[])]),conflict_identities:uniqueStrings([...(primary.conflict_identities??[]),...(secondary.conflict_identities??[])]),identityConflictAccepted:primary.identityConflictAccepted??secondary.identityConflictAccepted};
  }
  return output;
}

const DIAGNOSTIC_OUTCOME_LABELS:Record<string,string>={
  moonraker:'Moonraker',authorization_required:'HTTP 401',http_404:'HTTP 404/405',closed_port:'Закрытые порты',timeout:'Тайм-ауты',not_moonraker:'Не Moonraker',network_error:'Ошибки сети',adapter_excluded:'Исключённые адаптеры',adapter_selected:'Активные адаптеры',adapter_selected_override:'Адаптеры включены вручную',adapter_selection_reset:'Выбор адаптера сброшен',different_subnet:'Другая подсеть',isolation_suspected:'Возможна изоляция',cancelled:'Отменено'
};
const diagnosticOutcomeLabel=(value:string)=>DIAGNOSTIC_OUTCOME_LABELS[value]??value;

export function DiscoveryPanel({open,printers,onClose,onAdd,onAddAll}:Props){
  const [phase,setPhase]=useState<DiscoveryPhase>('idle');
  const [rows,setRows]=useState<IdentifiedDiscoveredPrinter[]>([]);
  const [subnets,setSubnets]=useState<string[]>([]);
  const [diagnostics,setDiagnostics]=useState<DiscoveryDiagnostics>();
  const [progress,setProgress]=useState({scanned:0,total:0,found:0});
  const [message,setMessage]=useState('');
  const [manualRange,setManualRange]=useState('');
  const [manualHost,setManualHost]=useState('');
  const [manualBusy,setManualBusy]=useState(false);
  const [diagnosticBusy,setDiagnosticBusy]=useState(false);
  const [adding,setAdding]=useState<string>();
  const [catalogRowId,setCatalogRowId]=useState<string>();
  const [listenersReady,setListenersReady]=useState(false);
  const [addedKeys,setAddedKeys]=useState<Set<string>>(()=>new Set());
  const [credentials,setCredentials]=useState<Record<string,CredentialDraft>>({});
  const [availableAdapters,setAvailableAdapters]=useState<DiscoveryAdapter[]>([]);
  const [selectedAdapters,setSelectedAdapters]=useState<string[]>(()=>loadStringList(DISCOVERY_ADAPTERS_KEY));
  const [history,setHistory]=useState<DiscoveryHistoryEntry[]>(loadDiscoveryHistory);
  const operationRef=useRef('');
  const manualRangeRef=useRef('');
  const inFlightRef=useRef(false);
  const startIntentRef=useRef(0);
  const cancelPromiseRef=useRef<Promise<boolean>>();
  const activeScanSettledRef=useRef<Promise<void>>();
  const openRef=useRef(open);
  const printersRef=useRef(printers);
  const rowsRef=useRef<IdentifiedDiscoveredPrinter[]>([]);
  const onCloseRef=useRef(onClose);
  const onAddRef=useRef(onAdd);
  const onAddAllRef=useRef(onAddAll);
  const closeTimer=useRef<number>();
  const catalogRowIdRef=useRef<string>();
  const deferredCloseDelayRef=useRef<number>();
  const panelRef=useRef<HTMLElement>(null);
  const identifyQueueRef=useRef<IdentifyTask[]>([]);
  const identifyActiveRef=useRef(0);
  const identifyActiveKeysRef=useRef(new Set<string>());
  const identifyWaitersRef=useRef<Array<()=>void>>([]);
  const identifyExpiredRef=useRef(new Set<string>());
  const pumpIdentifyRef=useRef<()=>void>(()=>{});
  const selectedAdaptersRef=useRef(selectedAdapters);
  const selectCatalogRow=useCallback((id?:string)=>{catalogRowIdRef.current=id;setCatalogRowId(id)},[]);

  useEffect(()=>{openRef.current=open;if(!open){deferredCloseDelayRef.current=undefined;selectCatalogRow(undefined)}},[open,selectCatalogRow]);
  useEffect(()=>{printersRef.current=printers},[printers]);
  useEffect(()=>{onCloseRef.current=onClose},[onClose]);
  useEffect(()=>{onAddRef.current=onAdd},[onAdd]);
  useEffect(()=>{onAddAllRef.current=onAddAll},[onAddAll]);
  useEffect(()=>{if(catalogRowId&&!rows.some(row=>rowKey(row)===catalogRowId))selectCatalogRow(undefined)},[catalogRowId,rows,selectCatalogRow]);
  useEffect(()=>{manualRangeRef.current=manualRange},[manualRange]);
  useEffect(()=>{selectedAdaptersRef.current=selectedAdapters;try{localStorage.setItem(DISCOVERY_ADAPTERS_KEY,JSON.stringify(selectedAdapters))}catch{/* выбор адаптеров — подсказка для следующего поиска */}},[selectedAdapters]);
  useEffect(()=>{
    if(!open||!listenersReady)return;
    let active=true;
    secureInvoke<NetworkEnvironmentSnapshot>('network_environment_snapshot',{}).then(snapshot=>{
      if(!active)return;
      const adapters=snapshot.adapters??[];
      setAvailableAdapters(adapters);
      const selected=selectedAdaptersRef.current;
      if(selected.length){
        const resolved=[...new Set(selected.flatMap(value=>adapters.filter(adapter=>adapter.name===value||adapter.address===value).map(adapter=>adapter.name)))];
        if(!resolved.length)setSelectedAdapters([]);
        else if(resolved.length!==selected.length||resolved.some((value,index)=>value!==selected[index]))setSelectedAdapters(resolved);
      }
    }).catch(()=>{});
    return()=>{active=false};
  },[open,listenersReady]);
  const setRowsSynced=useCallback((next:IdentifiedDiscoveredPrinter[])=>{rowsRef.current=next;setRows(next)},[]);
  const scrubCredentials=useCallback(()=>{
    setCredentials({});
    setRowsSynced(rowsRef.current.map(row=>row.apiKeyForAdd?{...row,apiKeyForAdd:undefined}:row));
  },[setRowsSynced]);
  const clearCloseTimer=()=>{if(closeTimer.current)window.clearTimeout(closeTimer.current);closeTimer.current=undefined};
  const scheduleClose=useCallback((delay:number)=>{
    clearCloseTimer();
    if(catalogRowIdRef.current){deferredCloseDelayRef.current=delay;return}
    closeTimer.current=window.setTimeout(()=>{
      closeTimer.current=undefined;
      if(catalogRowIdRef.current){deferredCloseDelayRef.current=delay;return}
      scrubCredentials();onCloseRef.current();
    },delay);
  },[scrubCredentials]);
  useEffect(()=>{
    if(catalogRowId||deferredCloseDelayRef.current===undefined||!open)return;
    const delay=deferredCloseDelayRef.current;
    deferredCloseDelayRef.current=undefined;
    scheduleClose(delay);
  },[catalogRowId,open,scheduleClose]);
  const signalIdentifyIdle=()=>{
    if(identifyQueueRef.current.length||identifyActiveRef.current)return;
    const waiters=identifyWaitersRef.current.splice(0);
    waiters.forEach(resolve=>resolve());
  };

  const pumpIdentification=useCallback(()=>{
    while(identifyActiveRef.current<3&&identifyQueueRef.current.length){
      const task=identifyQueueRef.current.shift()!;
      if(task.id!==operationRef.current||identifyExpiredRef.current.has(task.id))continue;
      const activeToken=`${task.id}|${task.key}`;
      if(identifyActiveKeysRef.current.has(activeToken)){
        identifyQueueRef.current.push(task);
        break;
      }
      identifyActiveRef.current++;
      identifyActiveKeysRef.current.add(activeToken);
      const current=rowsRef.current.find(row=>rowKey(row)===task.key);
      if(!current||current.auth_required){identifyActiveRef.current--;identifyActiveKeysRef.current.delete(activeToken);continue}
      setRowsSynced(rowsRef.current.map(row=>rowKey(row)===task.key?{...row,detectionState:'detecting'}:row));
      void (async()=>{
        const saved=printersRef.current.find(item=>printerEndpointKey(item.host)===printerEndpointKey(task.row.host));
        const config:PrinterConfig=saved
          ?{...saved,apiKey:task.apiKey??saved.apiKey}
          :{id:`scan-${task.row.ip.replaceAll(':','-')}-${task.row.port}`,name:`Klipper · ${task.row.ip}`,host:task.row.host,icon:'corexy',apiKey:task.apiKey};
        try{
          const client=new MoonrakerClient(config);
          const detection=await client.detect() as DetectionCompat;
          // Camera discovery follows model detection instead of competing with
          // it. Some embedded Moonraker builds stop responding under a burst of
          // parallel background RPCs while a /24 scan is still in progress.
          const cameraCount=await client.webcams().then(items=>items.filter(item=>item.enabled).length).catch(()=>undefined);
          const reliability=client.reliabilitySnapshot();
          const routeHistory=reliability.channelHealth.routeHistory.map(entry=>`${entry.from.protocol}:${entry.from.port} → ${entry.to.protocol}:${entry.to.port} (${entry.reason})`);
          if(task.id!==operationRef.current||identifyExpiredRef.current.has(task.id))return;
          setRowsSynced(collapseDiscoveryRows(rowsRef.current.map(row=>rowKey(row)!==task.key||printerEndpointKey(row.host)!==printerEndpointKey(task.row.host)?row:{...row,detection,detectionState:'done',reachable:detection.reachable,probeWarnings:detection.probeWarnings,probeCoverage:detection.probeCoverage,deviceIdentity:detection.deviceIdentity,moonraker_uuid:detection.deviceIdentity?.signals.uuid??row.moonraker_uuid,model:detectedModel(detection) as DiscoveredPrinter['model'],detectedName:detection.name,confidence:typeof detection.confidence==='string'?detection.confidence:undefined,evidence:(detection.evidence??[]).map(value=>typeof value==='string'?value:String((value as unknown as Record<string,unknown>).id??(value as unknown as Record<string,unknown>).message??(value as unknown as Record<string,unknown>).code??'')),cameraCount,cameraChecked:cameraCount!==undefined,routeSwitches:reliability.channelHealth.switches,routeHistory})));
        }catch(error){
          if(task.id!==operationRef.current||identifyExpiredRef.current.has(task.id))return;
          setRowsSynced(rowsRef.current.map(row=>rowKey(row)===task.key?{...row,detectionState:'error',detectionError:errorText(error)}:row));
        }finally{
          identifyActiveRef.current--;
          identifyActiveKeysRef.current.delete(activeToken);
          pumpIdentifyRef.current();
          signalIdentifyIdle();
        }
      })();
    }
    signalIdentifyIdle();
  },[setRowsSynced]);
  pumpIdentifyRef.current=pumpIdentification;

  const enqueueIdentification=useCallback((row:IdentifiedDiscoveredPrinter,id:string,apiKey?:string)=>{
    if(!row.moonraker_confirmed||(row.auth_required&&!apiKey))return;
    const key=rowKey(row);
    if(row.detection||identifyActiveKeysRef.current.has(`${id}|${key}`)||identifyQueueRef.current.some(task=>task.id===id&&task.key===key))return;
    identifyQueueRef.current=identifyQueueRef.current.filter(task=>task.key!==key);
    const accepted=rowsRef.current.slice(0,MAX_IDENTIFY_RESULTS).some(item=>rowKey(item)===key);
    if(!accepted)return;
    identifyQueueRef.current.push({id,key,row,apiKey});
    pumpIdentifyRef.current();
  },[]);

  const acceptFound=useCallback((incoming:DiscoveredPrinter,id:string,apiKey?:string)=>{
    if(id!==operationRef.current)return;
    let currentRows=rowsRef.current;
    let candidate=incoming;
    const savedCollisions=printersRef.current.filter(printer=>savedIdentityConflict(printer,candidate)&&(
      printerEndpointKey(printer.host)===printerEndpointKey(candidate.host)
      ||samePhysicalPrinter(printer.deviceIdentity,rowIdentity(candidate))
    ));
    if(savedCollisions.length){
      candidate={
        ...candidate,
        identity_conflict:'saved_identity_collision',
        conflict_hosts:uniqueStrings([candidate.host,...(candidate.conflict_hosts??[]),...savedCollisions.map(printer=>printer.host)]),
        conflict_identities:uniqueStrings([...(candidate.conflict_identities??[]),...conflictIdentityLabels(candidate),...savedCollisions.flatMap(savedIdentityLabels)]),
      };
    }
    const collisions=currentRows.filter(row=>strongIdentityConflict(row,candidate)&&(
      row.ip===candidate.ip
      ||(!!normalizedIdentity(row.hostname)&&normalizedIdentity(row.hostname)===normalizedIdentity(candidate.hostname))
    ));
    if(collisions.length){
      const sameAddress=collisions.some(row=>row.ip===candidate.ip);
      const code=sameAddress?'address_identity_collision':'hostname_identity_collision';
      const hosts=uniqueStrings([candidate.host,...(candidate.conflict_hosts??[]),...collisions.flatMap(row=>[row.host,...(row.conflict_hosts??[])])]);
      const identities=uniqueStrings([...(candidate.conflict_identities??[]),...conflictIdentityLabels(candidate),...collisions.flatMap(row=>[...(row.conflict_identities??[]),...conflictIdentityLabels(row)])]);
      candidate={...candidate,identity_conflict:code,conflict_hosts:hosts,conflict_identities:identities};
      currentRows=currentRows.map(row=>collisions.includes(row)?{...row,identity_conflict:row.identity_conflict??code,conflict_hosts:hosts,conflict_identities:identities,identityConflictAccepted:false}:row);
    }
    let index=currentRows.findIndex(row=>sameDiscoveryRow(row,candidate));
    if(index<0&&currentRows.length>=MAX_IDENTIFY_RESULTS){
      const replaceable=candidate.moonraker_confirmed?currentRows.findIndex(row=>!row.moonraker_confirmed):-1;
      if(replaceable>=0){currentRows=currentRows.filter((_,rowIndex)=>rowIndex!==replaceable);index=-1}
      else{
        setMessage(current=>current.includes(`${MAX_IDENTIFY_RESULTS}`)?current:`${current?`${current} `:''}Показаны первые ${MAX_IDENTIFY_RESULTS} устройств; остальные отсечены защитным лимитом.`);
        return;
      }
    }
    const merged=mergeFoundRow(index>=0?currentRows[index]:undefined,candidate);
    const next=index>=0?currentRows.map((row,rowIndex)=>rowIndex===index?merged:row):[...currentRows,merged];
    const collapsed=collapseDiscoveryRows(next);
    setRowsSynced(collapsed);
    setProgress(current=>({...current,found:Math.max(current.found,collapsed.length)}));
    if(merged.moonraker_confirmed&&!merged.auth_required&&!merged.detection&&merged.detectionState!=='detecting')enqueueIdentification({...merged,apiKeyForAdd:apiKey},id,apiKey);
  },[enqueueIdentification,setRowsSynced]);

  useEffect(()=>{
    let disposed=false;
    const stops:UnlistenFn[]=[];
    Promise.all([
      listen<DiscoveryProgress>('moonraker-discovery-progress',event=>{
        const payload=event.payload;
        if(operationIdOf(payload)!==operationRef.current)return;
        setProgress(current=>({scanned:Math.max(current.scanned,payload.scanned??0),total:Math.max(current.total,payload.total??0),found:Math.max(current.found,payload.found??0)}));
        if(payload.phase==='cancelled')setPhase('cancelled');
        if(payload.phase==='hybrid')setMessage('Параллельно проверяем сохранённые адреса, ARP, mDNS и SSDP на каждом выбранном адаптере.');
        if(payload.phase==='retrying')setMessage('Повторно проверяем медленные адреса с увеличенным тайм-аутом.');
        if(payload.phase==='timed_out')setMessage('Лимит времени поиска исчерпан. Показаны уже найденные устройства.');
      }),
      listen<DiscoveryFound>('moonraker-discovery-result',event=>{
        const payload=event.payload;
        if(operationIdOf(payload)!==operationRef.current)return;
        acceptFound(payload.printer,operationIdOf(payload)!);
      })
    ]).then(unlisteners=>{if(disposed)unlisteners.forEach(stop=>stop());else{stops.push(...unlisteners);setListenersReady(true)}}).catch(()=>{if(!disposed){setListenersReady(true);setMessage('Событийный канал поиска недоступен; итоговые результаты появятся после завершения прохода.')}});
    return()=>{disposed=true;stops.forEach(stop=>stop())};
  },[acceptFound]);

  const waitForIdentification=useCallback(async(id:string)=>{
    if(!identifyQueueRef.current.some(task=>task.id===id)&&identifyActiveRef.current===0)return;
    setPhase('identifying');
    let timer:number|undefined;
    await Promise.race([
      new Promise<void>(resolve=>identifyWaitersRef.current.push(resolve)),
      new Promise<void>(resolve=>{timer=window.setTimeout(resolve,IDENTIFY_DEADLINE_MS)})
    ]);
    if(timer)window.clearTimeout(timer);
    if(operationRef.current!==id)return;
    if(identifyQueueRef.current.some(task=>task.id===id)||identifyActiveRef.current){
      identifyExpiredRef.current.add(id);
      identifyQueueRef.current=identifyQueueRef.current.filter(task=>task.id!==id);
      setRowsSynced(rowsRef.current.map(row=>row.detectionState==='queued'||row.detectionState==='detecting'?{...row,detectionState:'error',detectionError:'Лимит автоматического определения исчерпан — модель можно проверить в настройках'}:row));
      setMessage(current=>`${current?`${current} `:''}Автоопределение остановлено по лимиту 30 секунд; найденные принтеры остаются доступны.`);
    }
  },[setRowsSynced]);

  const startScan=useCallback(async()=>{
    if(inFlightRef.current&&operationRef.current)return;
    const intent=++startIntentRef.current;
    if(cancelPromiseRef.current)await cancelPromiseRef.current;
    if(intent!==startIntentRef.current)return;
    if(activeScanSettledRef.current)await activeScanSettledRef.current;
    if(intent!==startIntentRef.current||!openRef.current||inFlightRef.current)return;
    inFlightRef.current=true;
    let releaseScan!:()=>void;
    const scanSettled=new Promise<void>(resolve=>{releaseScan=resolve});
    activeScanSettledRef.current=scanSettled;
    clearCloseTimer();
    const id=operationId();
    const scanStartedAt=Date.now();
    operationRef.current=id;
    identifyQueueRef.current=[];
    identifyExpiredRef.current.delete(id);
    setRowsSynced([]);
    deferredCloseDelayRef.current=undefined;
    selectCatalogRow(undefined);
    setAddedKeys(new Set());
    setCredentials({});
    setSubnets([]);
    setDiagnostics(undefined);
    setMessage('');
    setProgress({scanned:0,total:0,found:0});
    setPhase('scanning');
    try{
      let busyRetries=0;
      let result:DiscoveryRuntimeResult;
      while(true){
        try{
          result=await secureInvoke<DiscoveryRuntimeResult>('discover_moonraker',{knownHosts:printersRef.current.map(printer=>printer.host),operationId:id,manualRange:manualRangeRef.current.trim()||undefined,selectedAdapterAddresses:selectedAdaptersRef.current.length?selectedAdaptersRef.current:undefined,fastRecovery:false});
          break;
        }catch(error){
          const busy=/\bDISCOVERY_BUSY\b/i.test(errorText(error));
          if(!busy||busyRetries>=12||operationRef.current!==id)throw error;
          busyRetries++;
          await new Promise(resolve=>window.setTimeout(resolve,220));
          if(operationRef.current!==id)throw error;
        }
      }
      if(operationRef.current!==id)return;
      const resultId=operationIdOf(result);
      if(resultId&&resultId!==id)return;
      result.printers.forEach(printer=>acceptFound(printer,id));
      setSubnets(result.scanned_subnets??[]);
      setDiagnostics(result.diagnostics);
      if(result.diagnostics?.adapters)setAvailableAdapters(result.diagnostics.adapters);
      setProgress({scanned:result.scanned??result.total??0,total:result.total??result.scanned??0,found:Math.max(result.printers.length,rowsRef.current.length)});
      const historyEntry:DiscoveryHistoryEntry={
        id,
        startedAt:new Date(scanStartedAt).toISOString(),
        durationMs:result.duration_ms??Date.now()-scanStartedAt,
        found:Math.max(result.printers.length,rowsRef.current.length),
        confirmed:result.printers.filter(printer=>printer.moonraker_confirmed).length,
        timedOut:!!(result.timed_out??result.timedOut),
        fastRecovery:!!(result.fast_recovery??result.fastRecovery),
        subnets:(result.scanned_subnets??[]).slice(0,32),
        counts:{...(result.diagnostics?.counts??{})},
        adapters:(result.diagnostics?.adapters??[]).filter(adapter=>adapter.eligible!==false||selectedAdaptersRef.current.includes(adapter.name)||selectedAdaptersRef.current.includes(adapter.address)).map(adapter=>`${adapter.name} · ${adapter.address}`),
        routes:uniqueStrings(result.printers.filter(printer=>printer.working_protocol&&printer.working_port).map(printer=>`${printer.working_protocol}:${printer.working_port}`)),
        errors:Object.entries(result.diagnostics?.counts??{}).filter(([outcome])=>['closed_port','timeout','network_error','http_404','not_moonraker'].includes(outcome)).reduce((sum,[,count])=>sum+count,0),
        routeSwitches:0,
      };
      setHistory(current=>{
        const next=[historyEntry,...current.filter(entry=>entry.id!==id)].slice(0,10);
        try{localStorage.setItem(DISCOVERY_HISTORY_KEY,JSON.stringify(next))}catch{/* история поиска — диагностическая подсказка, не данные печати */}
        return next;
      });
      if(result.cancelled){setPhase('cancelled');scheduleClose(1200);return}
      if(result.timed_out??result.timedOut)setMessage('Лимит времени поиска исчерпан. Показаны уже найденные устройства.');
      else if((result.retried??0)>0)setMessage(`Медленный проход завершён: повторно проверено адресов — ${result.retried}.`);
      await waitForIdentification(id);
      if(operationRef.current!==id)return;
      setHistory(current=>{
        const routes=uniqueStrings(rowsRef.current.filter(row=>row.working_protocol&&row.working_port).map(row=>`${row.working_protocol}:${row.working_port}`));
        const routeSwitches=rowsRef.current.reduce((sum,row)=>sum+(row.routeSwitches??0),0);
        const next=current.map(entry=>entry.id===id?{...entry,routes,routeSwitches}:entry);
        try{localStorage.setItem(DISCOVERY_HISTORY_KEY,JSON.stringify(next))}catch{/* история поиска — диагностическая подсказка */}
        return next;
      });
      setPhase('done');
      inFlightRef.current=false;
      const hasNew=rowsRef.current.some(item=>{
        const match=matchingPrinter(printersRef.current,item);
        return !match||printerEndpointKey(match.host)!==printerEndpointKey(item.host);
      });
      operationRef.current='';
      if(rowsRef.current.length>0&&!hasNew)scheduleClose(4_500);
    }catch(error){
      if(operationRef.current!==id)return;
      operationRef.current='';
      setMessage(errorText(error));
      setPhase('error');
    }finally{
      inFlightRef.current=false;
      if(activeScanSettledRef.current===scanSettled)activeScanSettledRef.current=undefined;
      releaseScan();
    }
  },[acceptFound,scheduleClose,selectCatalogRow,setRowsSynced,waitForIdentification]);

  useEffect(()=>{if(open&&listenersReady){panelRef.current?.focus();void startScan()}},[open,listenersReady,startScan]);

  const cancel=useCallback((close=false)=>{
    startIntentRef.current++;
    if(close){openRef.current=false;deferredCloseDelayRef.current=undefined;selectCatalogRow(undefined)}
    clearCloseTimer();
    const id=operationRef.current;
    operationRef.current='';
    identifyQueueRef.current=[];
    if(id){
      identifyExpiredRef.current.add(id);
      setPhase('cancelling');
      const pending=secureInvoke<boolean>('cancel_moonraker_discovery',{operationId:id}).catch(()=>false);
      cancelPromiseRef.current=pending;
      void pending.finally(()=>{if(cancelPromiseRef.current===pending)cancelPromiseRef.current=undefined;if(!close&&openRef.current)setPhase('cancelled')});
    }
    if(close){scrubCredentials();onCloseRef.current()}else scheduleClose(1200);
  },[scheduleClose,scrubCredentials,selectCatalogRow]);

  useEffect(()=>{
    if(!open)return;
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){if(catalogRowId){event.preventDefault();selectCatalogRow(undefined)}else cancel(true);return}
      if(event.key!=='Tab')return;
      const panel=panelRef.current;
      if(!panel)return;
      const focusable=[...panel.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[href],[tabindex]:not([tabindex="-1"])')].filter(element=>element.getClientRects().length>0);
      if(!focusable.length){event.preventDefault();panel.focus();return}
      const first=focusable[0],last=focusable[focusable.length-1],current=document.activeElement;
      if(event.shiftKey&&(current===first||!panel.contains(current))){event.preventDefault();last.focus()}
      else if(!event.shiftKey&&(current===last||!panel.contains(current))){event.preventDefault();first.focus()}
    };
    window.addEventListener('keydown',key);
    return()=>window.removeEventListener('keydown',key);
  },[open,cancel,catalogRowId,selectCatalogRow]);
  useEffect(()=>()=>{clearCloseTimer();const id=operationRef.current;operationRef.current='';identifyQueueRef.current=[];if(id)secureInvoke<boolean>('cancel_moonraker_discovery',{operationId:id}).catch(()=>false)},[]);

  if(!open)return null;
  const active=phase==='scanning'||phase==='identifying'||phase==='cancelling';
  const known=(row:DiscoveredPrinter)=>{
    if(addedKeys.has(rowKey(row)))return true;
    const match=matchingPrinter(printers,row);
    return !!match&&printerEndpointKey(match.host)===printerEndpointKey(row.host);
  };
  const moved=(row:DiscoveredPrinter)=>{const match=matchingPrinter(printers,row);return !!match&&printerEndpointKey(match.host)!==printerEndpointKey(row.host)};
  const fresh=rows.filter(row=>!known(row));
  const addableFresh=fresh.filter(row=>row.moonraker_confirmed&&!row.auth_required&&(!row.identity_conflict||row.identityConflictAccepted)&&row.detectionState!=='queued'&&row.detectionState!=='detecting');
  const identifiedCount=rows.filter(row=>row.detectionState==='done'||row.detectionState==='error').length;
  const percent=progress.total?Math.min(100,Math.round(progress.scanned/progress.total*100)):undefined;
  const updateCredential=(key:string,patch:Partial<CredentialDraft>)=>setCredentials(current=>{
    const previous:CredentialDraft=current[key]??{value:'',state:'idle'};
    return{...current,[key]:{...previous,...patch}};
  });
  const chooseCatalogModel=(key:string,entry?:PrinterCatalogModel)=>{
    clearCloseTimer();
    setRowsSynced(rowsRef.current.map(row=>rowKey(row)===key?{...row,catalogModelId:entry?.id}:row));
    selectCatalogRow(undefined);
  };
  const addOne=async(row:IdentifiedDiscoveredPrinter)=>{
    clearCloseTimer();
    const key=rowKey(row);
    if(row.identity_conflict&&!row.identityConflictAccepted){setMessage('Сначала явно выберите устройство в конфликте идентичности.');return}
    setAdding(key);setMessage('');
    try{
      const saved=await onAddRef.current(row);
      if(saved===false)return;
      setRowsSynced(rowsRef.current.map(item=>rowKey(item)===key?{...item,apiKeyForAdd:undefined}:item));
      updateCredential(key,{value:'',state:'valid',error:undefined});
      setAddedKeys(current=>new Set(current).add(key));
      if(fresh.every(item=>rowKey(item)===key||addedKeys.has(rowKey(item))))scheduleClose(4_500);
    }catch(error){setMessage(errorText(error))}finally{setAdding(undefined)}
  };
  const acceptIdentityConflict=async(row:IdentifiedDiscoveredPrinter)=>{
    const hosts=(row.conflict_hosts?.length?row.conflict_hosts:[row.host]).join('\n');
    const identities=(row.conflict_identities?.length?row.conflict_identities:conflictIdentityLabels(row)).join('\n');
    const accepted=await appConfirm(
      `Один адрес/hostname связан с разными Stable ID либо один Stable ID ответил с нескольких адресов. Автоматическая замена заблокирована.\n\nВыбранный адрес: ${printerHostDisplay(row.host)}\n\nАдреса:\n${hosts}\n\nИдентификаторы:\n${identities||'не получены'}\n\nПродолжить именно с выбранной строкой?`,
      {title:'Конфликт идентичности принтера',confirmLabel:'Выбрать эту строку',cancelLabel:'Не изменять'}
    );
    if(!accepted)return;
    setRowsSynced(rowsRef.current.map(item=>rowKey(item)===rowKey(row)?{...item,identityConflictAccepted:true}:item));
    setMessage(`Выбран адрес ${printerHostDisplay(row.host)}. Перед сохранением приложение ещё раз проверит существующий принтер.`);
  };
  const addEvery=async()=>{
    clearCloseTimer();setAdding('*');setMessage('');
    try{
      const saved=await onAddAllRef.current(addableFresh);
      if(saved===false)return;
      const savedKeys=new Set(addableFresh.map(row=>rowKey(row)));
      setRowsSynced(rowsRef.current.map(row=>savedKeys.has(rowKey(row))?{...row,apiKeyForAdd:undefined}:row));
      setCredentials(current=>Object.fromEntries(Object.entries(current).map(([key,draft])=>[key,savedKeys.has(key)?{...draft,value:''}:draft])));
      setAddedKeys(current=>{const next=new Set(current);addableFresh.forEach(row=>next.add(rowKey(row)));return next});
      scheduleClose(4_500);
    }catch(error){setMessage(errorText(error))}finally{setAdding(undefined)}
  };
  const validateApiKey=async(row:IdentifiedDiscoveredPrinter)=>{
    clearCloseTimer();
    const key=rowKey(row),value=(credentials[key]?.value??'').trim();
    if(!value){updateCredential(key,{state:'error',error:'Введите API Key'});return}
    updateCredential(key,{state:'validating',error:undefined});
    try{
      const result=await secureInvoke<ApiKeyValidation>('validate_moonraker_api_key',{host:row.host,apiKey:value});
      if(!result.valid){updateCredential(key,{state:'error',error:result.message||'Moonraker отклонил API Key'});return}
      updateCredential(key,{state:'valid',error:undefined});
      const currentRow=rowsRef.current.find(item=>rowKey(item)===key);
      if(!currentRow||printerEndpointKey(currentRow.host)!==printerEndpointKey(row.host))return;
      const unlocked:IdentifiedDiscoveredPrinter={...currentRow,auth_required:false,working_protocol:result.protocol,working_port:result.port,klippy_state:result.klippy_state??currentRow.klippy_state,moonraker_version:result.moonraker_version??currentRow.moonraker_version,detectionState:'queued',apiKeyForAdd:value};
      setRowsSynced(rowsRef.current.map(item=>rowKey(item)===key?unlocked:item));
      const id=operationRef.current||operationId();
      if(!operationRef.current)operationRef.current=id;
      enqueueIdentification(unlocked,id,value);
    }catch(error){updateCredential(key,{state:'error',error:errorText(error)})}
  };
  const probeManual=async()=>{
    const host=manualHost.trim();
    if(!host){setMessage('Введите IP-адрес или локальное имя принтера.');return}
    clearCloseTimer();
    const id=operationId();
    operationRef.current=id;
    setManualBusy(true);setMessage('Проверяем указанный адрес на портах 7125 и 80…');setPhase('identifying');
    try{
      const found=await secureInvoke<DiscoveredPrinter[]>('probe_moonraker_host',{host});
      if(operationRef.current!==id)return;
      found.forEach(row=>acceptFound(row,id));
      await waitForIdentification(id);
      if(operationRef.current!==id)return;
      const confirmed=found.some(row=>row.moonraker_confirmed);
      setMessage(confirmed?'Ручная проверка завершена: Moonraker найден.':'Адрес отвечает по HTTP, но Moonraker на нём не подтверждён.');
      setPhase('done');
      operationRef.current='';
    }catch(error){
      if(operationRef.current===id){operationRef.current='';setMessage(errorText(error));setPhase('error')}
    }finally{setManualBusy(false)}
  };
  const createDiscoveryArchive=async()=>{
    setDiagnosticBusy(true);
    try{
      const safeRows=rowsRef.current.map(row=>{const safe={...row};delete safe.apiKeyForAdd;return safe});
      const authorization=Object.fromEntries(Object.entries(credentials).map(([key,value])=>[key,{state:value.state,error:value.error}]));
      const payload={kind:'klipper-farm-discovery-report',generatedAt:new Date().toISOString(),phase,progress,subnets,diagnostics,history,devices:safeRows,authorization,frontend:diagnosticEntries(undefined,500)};
      const result=await diagnosticZipCreate(JSON.stringify(payload));
      await appAlert(`ZIP создан:\n${result.path}\nSHA-256: ${result.sha256}`,{title:'Диагностика поиска готова'});
    }catch(error){await appAlert(errorText(error),{title:'Диагностический ZIP не создан'})}
    finally{setDiagnosticBusy(false)}
  };
  const diagnosticCounts=diagnostics?.counts??{};
  const hasConfirmed=rows.some(row=>row.moonraker_confirmed);
  const hasAuth=rows.some(row=>row.auth_required);
  const hasWrongKey=Object.values(credentials).some(value=>value.state==='error');
  const hasExcludedVpn=!!diagnostics?.adapters.some(adapter=>adapter.eligible===false&&/vpn|iproxy|wireguard|wintun|openvpn|warp|tun|tap/i.test(`${adapter.name} ${adapter.reason??''}`));
  const networkUnknown=!hasConfirmed&&((diagnosticCounts.timeout??0)>0||(diagnosticCounts.network_error??0)>0);
  const selectableAdapters=availableAdapters;
  const defaultAdapterNames=[...new Set(availableAdapters.filter(adapter=>adapter.eligible!==false).map(adapter=>adapter.name))];
  const adapterChecked=(adapter:DiscoveryAdapter)=>selectedAdapters.length?(selectedAdapters.includes(adapter.name)||selectedAdapters.includes(adapter.address)):adapter.eligible!==false;
  const toggleAdapter=(name:string,checked:boolean)=>{
    const all=[...new Set(selectableAdapters.map(adapter=>adapter.name))];
    const next=new Set(selectedAdapters.length?selectedAdapters:defaultAdapterNames);
    if(checked)next.add(name);else next.delete(name);
    if(!next.size){setMessage('Для поиска должен оставаться выбран хотя бы один сетевой адаптер.');return}
    const values=[...next].filter(value=>all.includes(value));
    const defaultSelection=values.length===defaultAdapterNames.length&&values.every(value=>defaultAdapterNames.includes(value));
    setSelectedAdapters(defaultSelection?[]:values);
  };
  const diagnosticCases=[
    {title:'Другая подсеть / VLAN',active:(diagnosticCounts.different_subnet??0)>0||networkUnknown,text:'Сравните адреса и подсети ПК и принтера. Маршрутизацию между VLAN обычный /24-поиск создать не может.'},
    {title:'Гостевой Wi‑Fi',active:(diagnosticCounts.isolation_suspected??0)>0||networkUnknown,text:'Подключите оба устройства к основной сети: гостевой режим обычно запрещает доступ к локальным устройствам.'},
    {title:'Изоляция клиентов',active:(diagnosticCounts.isolation_suspected??0)>0||networkUnknown,text:'Отключите AP/Client Isolation в роутере или точке доступа — программное сканирование её не обходит.'},
    {title:'Закрыт порт',active:(diagnosticCounts.closed_port??0)>0,text:'Проверьте TCP 7125 и 80, локальный firewall и настройки Moonraker.'},
    {title:'Неправильный API Key',active:hasAuth||hasWrongKey,text:'HTTP 401 означает, что Moonraker найден; сохраните только ключ, который прошёл проверку. Обычный 403 от роутера больше не считается принтером.'},
    {title:'Moonraker не запущен',active:(diagnosticCounts.http_404??0)>0||(diagnosticCounts.not_moonraker??0)>0,text:'IP отвечает, но /server/info не подтвердил Moonraker. Проверьте службу и правильный порт.'},
    {title:'VPN',active:hasExcludedVpn,text:'VPN автоматически исключён, а поиск привязан к Wi-Fi/Ethernet. Если у VPN включён Kill Switch или запрещён доступ к LAN, разрешите локальную сеть в настройках VPN.'},
  ];

  return <div className="discoveryBackdrop" onMouseDown={event=>event.target===event.currentTarget&&cancel(true)}>
    <section className="discoveryPanel" role="dialog" aria-modal="true" aria-labelledby="discoveryTitle" tabIndex={-1} ref={panelRef} onPointerDown={clearCloseTimer}>
      <header className="discoveryPanelHead">
        <div className="discoveryPanelTitle"><i><Radar className={active?'spin':''}/></i><div><span>LAN // MOONRAKER</span><h2 id="discoveryTitle">Поиск принтеров</h2><p>{phase==='scanning'?'Результаты появляются сразу; модели определяются параллельно':phase==='identifying'?'Завершаем безопасное определение моделей':phase==='done'?`Moonraker: ${rows.filter(row=>row.moonraker_confirmed).length} · HTTP-ответов: ${rows.length}`:phase==='error'?'Поиск завершился с ошибкой':'Поиск остановлен'}</p></div></div>
        <div className="discoveryPanelHeadActions">{!active&&<button title="Повторить поиск" aria-label="Повторить поиск" onClick={startScan}><RefreshCw/></button>}<button title="Закрыть" aria-label="Закрыть поиск" onClick={()=>cancel(true)}><X/></button></div>
      </header>

      <div className={`discoveryProgress ${active?'active':''}`}>
        <div><span>{phase==='identifying'?'ЗАВЕРШЕНИЕ ОПРЕДЕЛЕНИЯ':'ПОИСК + ОПРЕДЕЛЕНИЕ'}</span><b>{`${progress.scanned}${progress.total?` / ${progress.total}`:''} · Moonraker ${rows.filter(row=>row.moonraker_confirmed).length} · HTTP ${rows.length} · моделей ${identifiedCount}`}</b></div>
        <progress max={100} value={percent}/>
      </div>

      {message&&<div className={`discoveryMessage ${phase==='error'?'error':'warn'}`}><TriangleAlert/><span>{message}</span></div>}

      <div className="discoveryResults">
        {rows.map(row=>{
          const key=rowKey(row),isKnown=known(row),ipMoved=moved(row),detecting=row.detectionState==='queued'||row.detectionState==='detecting',authRequired=!!row.auth_required,identityBlocked=!!row.identity_conflict&&!row.identityConflictAccepted;
          const catalogModel=getCatalogModel(row.catalogModelId);
          const httpOnly=!row.moonraker_confirmed,checkingHttp=row.detectionState==='http-response';
          const credential:CredentialDraft=credentials[key]??{value:'',state:'idle'};
          const channel=row.working_protocol&&row.working_port?`${row.working_protocol==='websocket'?'WS':row.working_protocol==='rest'?'REST':'JSON-RPC'} · ${row.working_port}`:'';
          return <Fragment key={key}><article className={`${isKnown?'known':ipMoved?'moved':''} ${authRequired?'authRequired':''} ${httpOnly?'httpOnly':''} ${identityBlocked?'identityConflict':''}`}>
            <i className={`discoveryDeviceState ${row.detectionState}`}>{detecting||checkingHttp?<LoaderCircle className="spin"/>:row.detectionState==='error'||authRequired||httpOnly?<TriangleAlert/>:<CheckCircle2/>}</i>
            <div className="discoveryDeviceBody">
              <b>{authRequired?'Moonraker найден · требуется API Key':checkingHttp?'Устройство отвечает · проверяем Moonraker':httpOnly?'HTTP-сервис найден · это не Moonraker':detecting?'Определение модели…':detectedName(row)}</b>
              <span>{printerHostDisplay(row.host)}{row.hostname?` · ${row.hostname}`:''}{channel?` · ${channel}`:''}{row.http_status?` · HTTP ${row.http_status}`:''}{!authRequired&&!httpOnly?` · Klipper ${row.detection?.klippyState??row.klippy_state??'unknown'}`:''}</span>
              {row.identity_conflict&&<div className="discoveryIdentityConflict"><small><b>{row.identityConflictAccepted?'Конфликт подтверждён вручную':'Автозамена заблокирована'}</b> · {row.identity_conflict==='identity_multiple_addresses'?'один Stable ID ответил с нескольких адресов':'адрес/hostname связан с разными идентификаторами'}</small>{identityBlocked&&<button onClick={()=>void acceptIdentityConflict(row)}><TriangleAlert/>Выбрать эту строку</button>}</div>}
              {authRequired?<div className="discoveryAuth"><input type="password" autoComplete="off" spellCheck={false} value={credential.value} disabled={credential.state==='validating'} onChange={event=>updateCredential(key,{value:event.target.value,state:'idle',error:undefined})} onKeyDown={event=>{if(event.key==='Enter')void validateApiKey(row)}} placeholder="API Key Moonraker" aria-label={`API Key для ${printerHostDisplay(row.host)}`}/><button disabled={credential.state==='validating'||!credential.value.trim()} onClick={()=>validateApiKey(row)}>{credential.state==='validating'?<LoaderCircle className="spin"/>:<CheckCircle2/>}Проверить</button>{credential.error&&<small className="errorText">{credential.error}</small>}<small>Ключ проверяется до добавления и сохраняется в Windows Credential Manager.</small></div>:httpOnly?<small>{checkingHttp?'Карточка показана сразу после HTTP-ответа; идёт проверка /server/info и WebSocket.':'Устройство оставлено в отчёте, но добавить его как принтер нельзя. Проверьте порт и службу Moonraker.'}</small>:detecting?<small>Имя, модель и камера определяются отдельно — карточка уже доступна</small>:row.detectionState==='error'?<small className="errorText">Принтер найден, но расширенная проверка не завершена: {row.detectionError}</small>:<small>{confidenceLabel(row.detection)}{firstEvidence(row.detection,row)?` · ${firstEvidence(row.detection,row)}`:''}{row.detection?.probeCoverage?` · проверок ${row.detection.probeCoverage.successful}/${row.detection.probeCoverage.total}`:''}{row.cameraChecked?` · ${row.cameraCount?`камер: ${row.cameraCount}`:'камера не найдена'}`:' · камера недоступна'}{row.detection?.probeWarnings.length?' · часть данных временно недоступна':''}</small>}
              {!isKnown&&(row.moonraker_confirmed||authRequired)&&<div className="discoveryCatalogChoice">{catalogModel&&<small>Выбрана модель: {catalogName(catalogModel)}</small>}<button type="button" disabled={!!adding} style={{marginTop:8,minHeight:32,padding:'5px 9px',fontSize:12}} aria-label={`Выбрать модель для ${printerHostDisplay(row.host)}`} aria-expanded={catalogRowId===key} onClick={()=>{clearCloseTimer();selectCatalogRow(catalogRowId===key?undefined:key)}}>{catalogModel?'Изменить модель':'Выбрать свою модель'}</button></div>}
            </div>
            {isKnown&&row.moonraker_confirmed?<span className="discoveryAdded">УЖЕ ДОБАВЛЕН</span>:!authRequired&&row.moonraker_confirmed&&<button disabled={detecting||identityBlocked||!!adding||!!catalogRowId} title={identityBlocked?'Сначала подтвердите конфликт идентичности':undefined} onClick={()=>addOne(row)}><Plus/>{adding===key?'Сохраняем…':ipMoved?'Обновить IP':'Добавить'}</button>}
          </article>{catalogRowId===key&&<section className="discoveryCatalogPicker" aria-label={`Каталог моделей для ${printerHostDisplay(row.host)}`} style={{padding:12,border:'1px solid var(--ui-border)',borderRadius:10}}><header style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,marginBottom:14}}><strong>Модель для {printerHostDisplay(row.host)}</strong><button type="button" onClick={()=>selectCatalogRow(undefined)} style={{minHeight:34,padding:'5px 10px'}}>Назад к результатам</button></header><PrinterModelPicker compact selectedId={row.catalogModelId} onSelect={entry=>chooseCatalogModel(key,entry)}/></section>}</Fragment>
        })}
        {!rows.length&&!active&&phase!=='error'&&<div className="discoveryNoResults"><SearchX/><b>Moonraker на портах 80/7125 не найден</b><span>{subnets.length?`Проверены сети: ${subnets.join(', ')}`:'Активные локальные сети определить не удалось.'}</span></div>}
        {active&&!rows.length&&<div className="discoveryNoResults scanning"><Radar className="spin"/><b>Идёт поиск без блокировки интерфейса</b><span>Первый принтер появится здесь сразу после ответа.</span></div>}
      </div>

      {(diagnostics||subnets.length>0)&&<details className="discoveryReport"><summary>Отчёт и диагностика поиска</summary><div className="discoveryReportGrid"><section><b>Проверенные источники и сети</b><p>{subnets.join(', ')||'Нет доступных сетей'}</p>{diagnostics?.adapters.map(adapter=>{const scanNetwork=adapter.scanNetwork??adapter.scan_network,ipv6=adapter.ipv6Addresses??adapter.ipv6_addresses??[];return <small key={`${adapter.name}-${adapter.address}`} className={adapter.eligible===false?'excluded':''}>{adapter.name}: {adapter.address} · сеть {adapter.network}{scanNetwork?` · проход ${scanNetwork}`:''}{ipv6.length?` · IPv6 ${ipv6.join(', ')}`:''}{adapter.reason?` · ${adapter.reason}`:''}</small>})}</section><section><b>Результаты проверок</b><div className="discoveryDiagnosticCounts">{Object.entries(diagnostics?.counts??{}).sort(([a],[b])=>a.localeCompare(b)).map(([outcome,count])=><span key={outcome}>{diagnosticOutcomeLabel(outcome)} <strong>{count}</strong></span>)}</div><button className="discoveryArchive" disabled={diagnosticBusy} onClick={()=>void createDiscoveryArchive()}><FileArchive/>{diagnosticBusy?'Создаём ZIP…':'Диагностический ZIP'}</button></section></div><div className="discoveryBandNote"><b>2,4 и 5 ГГц не мешают сами по себе.</b> Если роутер объединяет диапазоны в одну LAN, устройства видят друг друга. VPN не мешает, пока в нём разрешён доступ к локальной сети. Разные VLAN, гостевая сеть, Client Isolation и VPN Kill Switch требуют изменения сетевых настроек.</div><div className="discoveryCases">{diagnosticCases.map(item=><section key={item.title} className={item.active?'active':''}><b>{item.title}</b><small>{item.active?'Требует проверки':'Признак не подтверждён'}</small><p>{item.text}</p></section>)}</div>{!!diagnostics?.entries.length&&<div className="discoveryDiagnosticEntries">{diagnostics.entries.map((entry,index)=>{const duration=entry.durationMs??entry.duration_ms;return <small key={`${entry.host}-${entry.outcome}-${index}`}><b>{entry.host}</b> · {diagnosticOutcomeLabel(entry.outcome)}{entry.adapter?` · адаптер ${entry.adapter}`:''}{duration!==undefined?` · ${duration} мс`:''} · {entry.detail}</small>})}</div>}{!!history.length&&<div className="discoveryHistory"><b>Последние поиски</b>{history.map(entry=><small key={entry.id}>{new Date(entry.startedAt).toLocaleString()} · {entry.fastRecovery?'быстрое восстановление':'полный поиск'} · {entry.durationMs} мс · HTTP {entry.found} · Moonraker {entry.confirmed} · ошибки {entry.errors??0} · маршруты {(entry.routes??[]).join(', ')||'нет'} · переключения {entry.routeSwitches??0}{entry.timedOut?' · лимит времени':''}</small>)}</div>}</details>}

      <footer className="discoveryPanelFoot">
        <details className="discoveryAdvanced"><summary>Расширенный поиск</summary>{selectableAdapters.length>0&&<fieldset className="discoveryAdapters"><legend>Сетевые адаптеры</legend>{selectableAdapters.map(adapter=><label key={`${adapter.name}-${adapter.address}`} className={adapter.eligible===false?'excluded':''}><input type="checkbox" checked={adapterChecked(adapter)} disabled={active} onChange={event=>toggleAdapter(adapter.name,event.target.checked)}/><span>{adapter.name} · {adapter.address} · {adapter.scanNetwork??adapter.scan_network??adapter.network}{adapter.eligible===false?` · вручную: ${adapter.reason??'виртуальный адаптер'}`:''}</span></label>)}<small>По умолчанию поиск идёт только через физические Wi-Fi/Ethernet и привязывает TCP/mDNS/SSDP к их адресам. Поэтому VPN можно оставить включённым. VPN-адаптер выбирайте вручную только для принтера, реально доступного через VPN.</small></fieldset>}<label className="discoveryManualHost"><span>IP или имя</span><span><input value={manualHost} disabled={active||manualBusy} onChange={event=>setManualHost(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void probeManual()}} placeholder="192.168.1.42 или printer.local"/><button disabled={active||manualBusy||!manualHost.trim()} onClick={()=>void probeManual()}>{manualBusy?<LoaderCircle className="spin"/>:<Radar/>}Проверить</button></span></label><small>Ручная проверка всегда выполняется напрямую на 7125 и 80, даже если адрес вне найденной /24.</small><label className="discoveryManualRange"><span>Диапазон</span><input value={manualRange} disabled={active||manualBusy} onChange={event=>setManualRange(event.target.value)} placeholder="192.168.1.0/22 или 192.168.1.10-192.168.1.80"/></label><small>Для нестандартной сети укажите диапазон и нажмите «Повторить поиск».</small></details>
        <div>{active?<button onClick={()=>cancel(false)}><X/>Остановить</button>:<button onClick={()=>cancel(true)}>Закрыть</button>}{phase==='done'&&addableFresh.length>1&&<button className="primary" disabled={!!adding||!!catalogRowId} onClick={addEvery}><Plus/>{adding==='*'?'Добавляем…':`Добавить все (${addableFresh.length})`}</button>}</div>
      </footer>
    </section>
  </div>;
}
