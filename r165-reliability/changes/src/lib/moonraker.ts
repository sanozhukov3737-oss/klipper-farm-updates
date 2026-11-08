import { subscribeActorBridge, type NativeIdentityAttestation, type PrinterActorPhase, type PrinterActorPresentation, type PrinterStatusTimestamps, type PrinterActorSnapshot, type PrinterActorEvent, type PrinterActorOperationResult } from './printerActorBridge';
import { secureInvoke } from './auth';
import { readGCodeFileEntries } from './moonrakerFiles';
import { OfflinePollGate } from './connectionFeedback';
import { discoverPrinterLight, printerLightCommand, printerLightState, type PrinterLightTarget, type PrinterLightState } from './printerLight';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { GCodeFileEntry, GCodeMetadata, GCodeThumbnail, HistoryJob, PrinterCapabilities, PrinterConfig, PrinterDetectionFacts, PrinterDetectionResult, PrinterDeviceIdentity, PrinterStatus, QueueStatus, TemperatureStore, Webcam } from '../types';
import { classifyPrinterModel, mergePrinterDetectionFacts, printerDetectionFactsFromMoonraker, printerPresetDisplayName } from './printerDetection';
import { connectionAttempt, connectionFailed, connectionReachable, connectionStatusPatch, initialConnectionHealth, normalizeKlippyState, preserveAuthoritativeOffline, type ConnectionHealth } from './printerHealth';
import { dataUrlFromBase64Image, dataUrlFromImageBytes, embeddedGCodeThumbnailDataUrl } from './gcodeThumbnail';
import { moonrakerObjectNames, moonrakerRecord, moonrakerStatus } from './moonrakerPayload';
import { printerDeviceIdentity } from './deviceIdentity';
import { ConnectionRecovery, MoonrakerChannelHealth, type MoonrakerChannel, type MoonrakerPort, type MoonrakerProtocol } from './connectionReliability';
import { PrinterRequestScheduler, RequestCancelledError, type PrinterRequestSchedulerSnapshot } from './requestScheduler';
import { PRINT_START_CONFIRMATION_MS, PrintStartNotSentError, printStartDefinitelyNotSent, printStartObservation, uncertainPrintStart } from './printStartConfirmation';
import { diagnosticError, diagnosticInfo, diagnosticWarning } from './diagnosticLog';
import type { LocalTransferProgress } from './localLibraryTransfer';
import { localLibraryUploadToPrinter } from './native';
import { assertModelDependentOperationAllowed } from './modelSafety';
import { checkedFanPayload, printerFanCommand, printerFanSpeed, printerFanTelemetryObject, printerGcodeResponseLines, resolvePrinterFan, type PrinterFanState } from './fanControl';

type Listener = (status: Partial<PrinterStatus>) => void;
type ResponseListener = (line:string) => void;
export type PrinterPhysicalIdentityObservation={signals:PrinterDeviceIdentity['signals'];attestedAt:number;host:string;printerId:string;sessionEpoch:number};

type NativeHttpResponse={status:number;contentType?:string;body:number[]};
type ThumbnailReadOptions={allowEmbeddedGcode?:boolean;signal?:AbortSignal};
type NativeUploadBegin={uploadId:string;chunkSize:number;receivedSize:number;resumed:boolean;completedPath?:string};
type NativeUploadFinish={path:string;sha256:string;remoteVerified:boolean;recovered:boolean};
type MoonrakerDefaultPort=80|7125;
type NativeRpcOptions={preferRest?:boolean;timeoutMs?:number;defaultPort?:MoonrakerDefaultPort};
type K1CTransport={protocol:'websocket'|'rest'|'jsonrpc';defaultPort:MoonrakerDefaultPort};

export type PrintStartOptions={
  expectsMoonrakerStop?:boolean;
  estimatedDuration?:number;
};

export type MoonrakerHistoryPageOptions={limit?:number;start?:number;since?:number;order?:'asc'|'desc';signal?:AbortSignal};
export type MoonrakerHistoryPage={jobs:HistoryJob[];count:number};

export interface PrinterDetection extends PrinterDetectionResult {
  reachable:boolean;
  ready:boolean;
  name:string;
  klippyState:string;
  moonrakerVersion?:string;
  hostname?:string;
  objectCount:number;
  latency:number;
  probeWarnings:string[];
  probeCoverage:{successful:number;total:number;available:string[];missing:string[]};
  facts:PrinterDetectionFacts;
  deviceIdentity?:PrinterDeviceIdentity;
}

export interface PrinterReliabilitySnapshot{
  scheduler:PrinterRequestSchedulerSnapshot;
  recovery:ReturnType<ConnectionRecovery['snapshot']>;
  channelHealth:ReturnType<MoonrakerChannelHealth['snapshot']>;
  activePort:MoonrakerDefaultPort;
  activeProtocol:K1CTransport['protocol']|'http';
  endpoint:string;
}

// Методы без побочных эффектов: повтор после смены сессии актора безопасен.
// Команды, меняющие состояние принтера (старт, отмена, движение), здесь намеренно
// отсутствуют: их повтор мог бы запустить действие дважды.
const IDEMPOTENT_RPC_METHODS=new Set([
  'server.info','server.config','server.files.list','server.files.metadata','server.files.roots',
  'server.temperature_store','server.history.list','server.job_queue.status','server.websocket_id',
  'printer.info','printer.objects.list','printer.objects.query','printer.objects.subscribe',
  'machine.system_info','machine.proc_stats','machine.update.status',
]);
const boundedText=(...values:unknown[])=>{
  for(const value of values){
    if(typeof value==='string'&&value.trim())return value.trim().slice(0,160);
    if(typeof value==='number'&&Number.isFinite(value))return String(value).slice(0,160);
  }
  return undefined;
};

const blobSha256=async(blob:Blob)=>{
  const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
};

const safeGcodePath=(value:string)=>{
  let path=value.trim().replace(/\\/g,'/');
  if(/^https?:\/\//i.test(path))return undefined;
  if(path.startsWith('/server/files/gcodes/'))path=path.slice('/server/files/gcodes/'.length);
  path=path.replace(/^\/+/, '').replace(/^gcodes\//i,'');
  if(!path||path.length>2048)return undefined;
  const output:string[]=[];
  for(const raw of path.split('/')){
    if(!raw)continue;
    let segment=raw;
    try{segment=decodeURIComponent(raw)}catch{}
    if(!segment||segment==='.'||segment==='..'||segment.includes('/')||segment.includes('\\')||segment.length>255||[...segment].some(char=>char.charCodeAt(0)<0x20))return undefined;
    output.push(segment);
  }
  return output.length?output.join('/'):undefined;
};

const encodedGcodePath=(value:string)=>safeGcodePath(value)?.split('/').map(encodeURIComponent).join('/');

// File-manager and upload results are raw relative filenames, not URLs.
// Validate them without changing spaces, percent sequences or folder names.
const rawPrintFilePath=(value:string)=>{
  if(typeof value!=='string'||!value||value.length>2048||value.startsWith('/')||/^[a-z]:\//i.test(value)||/[\\\p{Cc}]/u.test(value))return undefined;
  if(value.split('/').some(segment=>!segment||segment==='.'||segment==='..'||segment.length>255))return undefined;
  return value;
};

export class MoonrakerClient {
  private listeners = new Set<Listener>();
  private responseListeners = new Set<ResponseListener>();
  private physicalIdentityListeners=new Set<(observation:PrinterPhysicalIdentityObservation)=>void>();
  private lastPhysicalIdentityKey='';
  private sensorObjects:string[]=[];
  private availableObjects=new Set<string>();
  private lightTarget?:PrinterLightTarget;
  private fanObject='fan';
  private fanControlStatus:Partial<PrinterStatus>={state:'offline',connectionState:'offline'};
  private pollTimer?: number;
  private pollInFlightEpoch?:number;
  private pollSettled?:Promise<void>;
  private resolvePollSettled?:()=>void;
  private pollCount=0;
  private closedByUser = false;
  private connectionEpoch = 0;
  private transport:'http'='http';
  private health:ConnectionHealth=initialConnectionHealth();
  private thumbnailCache=new Map<string,Promise<string|undefined>>();
  private thumbnailActive=0;
  private thumbnailWaiters:Array<()=>void>=[];
  private thumbnailGeneration=0;
  private gcodeTextCache=new Map<string,{promise:Promise<string>;expires:number}>();
  private metadataCache=new Map<string,{promise:Promise<GCodeMetadata>;expires:number}>();
  private fileEntriesInFlight?:Promise<GCodeFileEntry[]>;
  private queueStatusInFlight?:Promise<QueueStatus>;
  private temperatureStoreInFlight?:Promise<TemperatureStore>;
  private detectionInFlight?:Promise<PrinterDetection>;
  private uploadedHashes=new Map<string,string>();
  private uploadedFiles=new Map<string,File>();
  private uploadInFlight?:Promise<string>;
  private uploadController?:AbortController;
  private activeUploadId?:string;
  private actorActive=false;
  private addressIdentityConflict=false;
  private actorIdentity?:{printerId:string;host:string;stableId:string};
  private actorFilePort?:MoonrakerDefaultPort;
  private actorEpoch=0;
  private actorEventId=0;
  private actorEventTail:Promise<void>=Promise.resolve();
  private actorAckHighWater=0;
  private actorAckTimer?:number;
  private actorAckInFlight=false;
  private actorUnlisten?:UnlistenFn;
  private actorBridgeUnsubscribe?:()=>void;
  private actorSnapshotConnected=false;
  private actorSnapshotMissing=0;
  private actorBridgeFailures=0;
  private actorCompatibilityTimer?:number;
  private actorCompatibilityGate=new OfflinePollGate();
  private actorCompatibilityInFlightEpoch?:number;
  private actorCompatibilityHealthy=false;
  private actorCompatibilityLastSuccessAt=0;
  private actorCompatibilityObservation?:{observedAt:number;status:Partial<PrinterStatus>};
  private actorAuthoritativeConnectionState:PrinterActorPresentation['connectionState']='connecting';
  private actorRecoveryInFlight=false;
  private backgroundInFlight=new Set<Promise<unknown>>();
  private requestScheduler=new PrinterRequestScheduler();
  private pendingPrintStart?:Promise<any>;
  private printStartFileRoot?:{key:string;path?:string};
  private recovery=new ConnectionRecovery();
  private channelHealth=new MoonrakerChannelHealth({protocol:'websocket',port:80});
  private conservativeIoTail:Promise<void>=Promise.resolve();
  private resourceQuietUntil=0;
  private lastConnectionProbeAt=0;
  private lastObjectCatalogAttemptAt=0;
  private objectCatalogInFlight?:Promise<boolean>;
  private telemetryQueryMode:'fields'|'all'|'split'='fields';
  private k1cTelemetryTransport:K1CTransport={protocol:'websocket',defaultPort:80};
  private activeConnectionPort:MoonrakerDefaultPort=7125;
  private k1cExtendedTelemetryInFlight?:Promise<void>;
  private lastK1cExtendedTelemetryAt=0;
  private expectedMoonrakerStopUntil=0;
  private expectedMoonrakerStopArmedAt=0;
  private lastTelemetryKlippyState='unknown';
  private authorizationRetryUntil=0;
  private statusBuffer: Partial<PrinterStatus> = {};
  private statusTimer?: number;
  private lastState:PrinterStatus['state']='offline';
  private lastStatusFilename?:string;
  private visibilityHandler = () => {
    if(this.closedByUser) return;
    if(this.pollTimer) window.clearTimeout(this.pollTimer);
    this.pollTimer=undefined;
    this.schedulePoll(document.hidden ? 8000 : 150);
  };
  constructor(public config: PrinterConfig) {
    const port=this.configuredMoonrakerPort();
    this.channelHealth=new MoonrakerChannelHealth({protocol:'websocket',port:port===7125?7125:80});
  }

  async connect() {
    const previousPoll=this.pollSettled;
    const epoch=++this.connectionEpoch;
    this.addressIdentityConflict=false;
    this.lastPhysicalIdentityKey='';
    this.requestScheduler.reopen();
    this.actorActive=false;
    this.actorFilePort=undefined;
    this.actorEpoch=0;
    this.actorEventId=0;
    this.actorEventTail=Promise.resolve();
    this.actorUnlisten?.();
    this.actorUnlisten=undefined;
    this.actorBridgeUnsubscribe?.();
    this.actorBridgeUnsubscribe=undefined;
    this.actorSnapshotConnected=false;
    this.actorSnapshotMissing=0;
    this.actorBridgeFailures=0;
    this.actorCompatibilityHealthy=false;
    this.actorCompatibilityLastSuccessAt=0;
    this.actorCompatibilityObservation=undefined;
    this.actorAuthoritativeConnectionState='connecting';
    this.actorCompatibilityGate.reset();
    this.stopActorCompatibilityPoll();
    this.closedByUser = false;
    if(this.pollTimer) window.clearTimeout(this.pollTimer);
    this.pollTimer=undefined;
    document.removeEventListener('visibilitychange',this.visibilityHandler);
    document.addEventListener('visibilitychange',this.visibilityHandler);

    this.transport='http';
    this.pollCount=0;
    this.availableObjects.clear();
    this.sensorObjects=[];
    this.fanObject='fan';
    this.resourceQuietUntil=0;
    this.lastConnectionProbeAt=0;
    // The object catalogue is useful for optional sensors, but it must never
    // delay the first core telemetry frame shown by the UI.
    this.lastObjectCatalogAttemptAt=Date.now();
    this.objectCatalogInFlight=undefined;
    this.telemetryQueryMode='fields';
    const remembered=this.channelHealth.active();
    this.k1cTelemetryTransport={protocol:remembered.protocol,defaultPort:remembered.port};
    this.activeConnectionPort=this.configuredMoonrakerPort()===80?80:7125;
    this.k1cExtendedTelemetryInFlight=undefined;
    this.lastK1cExtendedTelemetryAt=0;
    this.expectedMoonrakerStopUntil=0;
    this.expectedMoonrakerStopArmedAt=0;
    this.lastTelemetryKlippyState='unknown';
    this.health=initialConnectionHealth(this.health);
    this.emitNow({...connectionStatusPatch(this.health),remoteControlSuspended:false});
    if(previousPoll)await previousPoll;
    if(!this.connectionActive(epoch))return;
    if(await this.connectActor(epoch))return;
    await this.pollOnce(epoch);
  }

  private connectionActive(epoch:number){return !this.closedByUser&&this.connectionEpoch===epoch}

  private stableId(){
    // Rust preserves the durable binding when discovery changes the frontend
    // fingerprint. Reuse its acknowledged identity only for this exact target.
    const actor=this.actorIdentity;
    if(actor?.printerId===this.config.id&&actor.host===this.config.host)return actor.stableId;
    const identity=this.config.deviceIdentity;
    return identity?.dedupeSafe&&identity.stableId?identity.stableId:this.config.id;
  }

  private uploadTarget(){
    // The upload journal belongs to the registered actor, not to a temporary
    // K1C HTTP compatibility route. Rust selects the actor's transport itself.
    return {stableId:this.stableId(),printerId:this.config.id,host:this.config.host,defaultPort:this.moonrakerDefaultPort()};
  }

  private actorPhasePatch(phase:PrinterActorPhase,lastError?:string):Partial<PrinterStatus>{
    const channel={connectionProtocol:'websocket' as const,connectionPort:this.activeConnectionPort};
    if(phase!=='quarantined'&&(this.lastTelemetryKlippyState==='shutdown'||this.lastTelemetryKlippyState==='error')){
      const state=this.lastTelemetryKlippyState;
      return{...channel,state:'error',connectionState:'degraded',klippyState:state,connectionReason:state==='shutdown'?'klipper_shutdown':'klipper_error',connectionMessage:lastError||this.fanControlStatus.connectionMessage||(state==='shutdown'?'Klipper shutdown':'Ошибка Klipper')};
    }
    if(phase==='degraded'||phase==='recovering')return{connectionState:'degraded',connectionReason:'daemon_recovering',connectionMessage:lastError||'Daemon восстанавливается'};
    if(phase==='quarantined')return{state:'error',connectionState:'degraded',connectionReason:'quarantine',connectionMessage:lastError||'Quarantine'};
    if(this.lastTelemetryKlippyState==='startup')return{...channel,connectionState:'degraded',klippyState:'startup',connectionReason:'klipper_startup',connectionMessage:'Moonraker доступен, Klipper запускается'};
    if(phase==='printing')return{...channel,state:this.lastState==='paused'?'paused':'printing',klippyState:this.lastTelemetryKlippyState==='ready'?'ready':undefined,connectionState:'online',connectionReason:'websocket',connectionMessage:'WebSocket подключён'};
    if(phase==='ready'||phase==='operating')return{...channel,state:this.lastState==='printing'||this.lastState==='paused'?this.lastState:this.lastState==='error'?'error':'ready',klippyState:this.lastTelemetryKlippyState==='ready'?'ready':undefined,connectionState:'online',connectionReason:'websocket',connectionMessage:'WebSocket подключён'};
    return{connectionState:'connecting',connectionReason:'connecting',connectionMessage:'PrinterActor идентифицирует принтер'};
  }

  private actorDisconnectedPatch(phase:PrinterActorPhase,lastError?:string):Partial<PrinterStatus>{
    if(phase==='degraded'||phase==='recovering')return{connectionState:'degraded',connectionReason:'daemon_recovering',connectionMessage:lastError||'Daemon восстанавливается'};
    return{connectionState:'connecting',connectionReason:'connecting',connectionMessage:lastError||'PrinterActor подключает WebSocket'};
  }

  private actorPresentationPatch(snapshot:PrinterActorSnapshot):Partial<PrinterStatus>{
    const presentation=snapshot.presentation;
    if(!presentation||presentation.generation!==snapshot.sessionEpoch)return{};
    const protocol= ['websocket','rest','jsonrpc'].includes(presentation.channel)
      ?presentation.channel as PrinterStatus['connectionProtocol']
      :undefined;
    return{
      connectionState:presentation.connectionState,
      connectionReason:presentation.reason,
      connectionMessage:presentation.message,
      connectionProtocol:protocol,
      connectionPort:presentation.port,
    };
  }

  private compatibilityChannelPatch():Partial<PrinterStatus>{
    const protocol=this.prefersK1CCompatibilityMode()?this.k1cTelemetryTransport.protocol:this.prefersLowResourceMode()?'rest':'jsonrpc';
    const connectionPort=this.prefersK1CCompatibilityMode()?this.k1cTelemetryTransport.defaultPort:(this.configuredMoonrakerPort()===80?80:7125);
    return{connectionReason:protocol==='websocket'?'websocket':'rest_jsonrpc',connectionProtocol:protocol,connectionPort,connectionMessage:protocol==='websocket'?'WebSocket подключён':'Moonraker доступен · REST/JSON-RPC'};
  }

  private applyActorSnapshot(snapshot:PrinterActorSnapshot){
    if(snapshot.printerId!==this.config.id||snapshot.host!==this.config.host)return;
    if(snapshot.sessionEpoch<this.actorEpoch)return;
    this.actorIdentity={printerId:snapshot.printerId,host:snapshot.host,stableId:snapshot.stableId};
    this.actorEpoch=snapshot.sessionEpoch;
    const connectionEpoch=this.connectionEpoch;
    this.emitPhysicalIdentity(snapshot.identityAttestation,snapshot.host,snapshot.printerId,snapshot.sessionEpoch);
    if(!this.connectionActive(connectionEpoch))return;
    const now=Date.now();
    const persistentWebSocket=snapshot.connected&&snapshot.activeProtocol==='websocket';
    const freshCompatibilityStatus=snapshot.connected&&!persistentWebSocket&&snapshot.lastSeenAt!==undefined&&now-snapshot.lastSeenAt<=20_000;
    const freshLocalCompatibility=this.actorCompatibilityLastSuccessAt>0&&now-this.actorCompatibilityLastSuccessAt<=20_000;
    const local=this.actorCompatibilityObservation;
    const preferLocal=snapshot.phase!=='quarantined'&&!!local&&now>=local.observedAt&&now-local.observedAt<=20_000
      &&local.observedAt>(snapshot.lastSeenAt??0);
    if(local&&!preferLocal&&snapshot.lastSeenAt!==undefined&&snapshot.lastSeenAt>=local.observedAt)this.actorCompatibilityObservation=undefined;
    this.actorSnapshotConnected=persistentWebSocket;
    this.actorSnapshotMissing=0;
    this.actorBridgeFailures=0;
    if(snapshot.presentation?.generation===snapshot.sessionEpoch)this.actorAuthoritativeConnectionState=snapshot.presentation.connectionState;
    this.config={...this.config,capabilities:snapshot.capabilities};
    this.transport='http';
    this.actorFilePort=snapshot.connected&&(snapshot.activePort===80||snapshot.activePort===7125)?snapshot.activePort:undefined;
    if(snapshot.activePort===80||snapshot.activePort===7125)this.activeConnectionPort=snapshot.activePort;
    if(!preferLocal&&snapshot.cachedStatus&&Object.keys(snapshot.cachedStatus).length)this.applyStatus(snapshot.cachedStatus,snapshot.lastSeenAt??now,snapshot,snapshot.connected);
    if(preferLocal){
      // A retrying native WebSocket can still carry the pre-fault cache. A
      // later successful REST observation owns the controller/job state until
      // native telemetry actually catches up, not merely until its next poll.
      this.actorSnapshotConnected=false;
      this.actorCompatibilityHealthy=true;
      this.scheduleActorCompatibilityPoll(5_000);
      this.emitNow({...local.status,lastSeen:local.observedAt});
    }else if(persistentWebSocket){
      this.actorCompatibilityGate.reset();
      this.actorCompatibilityHealthy=false;
      this.actorCompatibilityLastSuccessAt=0;
      this.actorCompatibilityObservation=undefined;
      this.stopActorCompatibilityPoll();
      this.emitNow({...this.actorPhasePatch(snapshot.phase,snapshot.lastError),...this.actorPresentationPatch(snapshot),lastSeen:snapshot.lastSeenAt});
    }else if(snapshot.phase==='quarantined'){
      this.actorCompatibilityHealthy=false;
      this.actorCompatibilityLastSuccessAt=0;
      this.actorCompatibilityObservation=undefined;
      this.stopActorCompatibilityPoll();
      this.emitNow({...this.actorPhasePatch(snapshot.phase,snapshot.lastError),...this.actorPresentationPatch(snapshot),lastSeen:snapshot.lastSeenAt});
    }else{
      if(freshCompatibilityStatus)this.actorCompatibilityLastSuccessAt=Math.max(this.actorCompatibilityLastSuccessAt,snapshot.lastSeenAt!);
      this.actorCompatibilityHealthy=freshCompatibilityStatus||freshLocalCompatibility;
      this.scheduleActorCompatibilityPoll(this.actorCompatibilityHealthy?5_000:350);
      const route=this.compatibilityChannelPatch();
      this.emitNow(this.actorCompatibilityHealthy
        ?{...route,...this.actorPhasePatch(snapshot.phase,snapshot.lastError),...this.actorPresentationPatch(snapshot),connectionProtocol:route.connectionProtocol,connectionPort:route.connectionPort,lastSeen:snapshot.lastSeenAt}
        :{...this.actorDisconnectedPatch(snapshot.phase,snapshot.lastError),...this.actorPresentationPatch(snapshot)});
    }
    this.flushStatus();
  }

  private async applyActorEvent(update:PrinterActorEvent,stableId:string,epoch:number){
    if(!this.connectionActive(epoch)||update.printerId!==this.config.id||update.stableId!==stableId)return;
    if(update.eventId>0&&update.eventId<=this.actorEventId)return;
    if(update.sessionEpoch<this.actorEpoch){
      this.scheduleActorEventAck(update.eventId);
      return;
    }
    this.actorEpoch=update.sessionEpoch;
    this.actorEventId=Math.max(this.actorEventId,update.eventId||0);
    if((update.kind==='identity_attested'||update.kind==='identity_warning')&&this.actorIdentity?.host===this.config.host){
      this.emitPhysicalIdentity(update.payload,this.actorIdentity.host,update.printerId,update.sessionEpoch);
      if(!this.connectionActive(epoch))return;
    }
    if(update.kind==='gcode_response')for(const line of printerGcodeResponseLines(update.payload))this.responseListeners.forEach(listener=>listener(line));
    if((update.kind==='capabilities'||update.kind==='firmware_reattested')&&update.payload&&typeof update.payload==='object')this.config={...this.config,capabilities:update.payload as PrinterCapabilities};
    const hasStatus=!!update.status&&Object.keys(update.status).length>0;
    if(hasStatus){
      if(update.kind==='printer_fault'||update.kind.startsWith('klippy_'))this.actorCompatibilityObservation=undefined;
      const persistentWebSocket=update.kind.startsWith('klippy_')||update.kind==='printer_fault'
        ?this.actorSnapshotConnected:update.kind==='websocket'||update.kind==='subscription';
      this.actorSnapshotConnected=persistentWebSocket;
      this.actorCompatibilityHealthy=!persistentWebSocket;
      this.actorCompatibilityLastSuccessAt=persistentWebSocket?0:Date.now();
      if(persistentWebSocket)this.stopActorCompatibilityPoll();else this.scheduleActorCompatibilityPoll(5_000);
      const observedAt=typeof update.eventtime==='number'&&Number.isFinite(update.eventtime)&&update.eventtime>1_000_000_000
        ?(update.eventtime<10_000_000_000?update.eventtime*1_000:update.eventtime)
        :Date.now();
      // Source heater dates survive delayed bridge delivery. Legacy events have
      // no heater dates; receipt time cannot prove their cached values are live.
      this.applyStatus(update.status!,observedAt,{...update,jobUpdatedAt:update.jobUpdatedAt===undefined?observedAt:update.jobUpdatedAt});
    }
    this.emitNow(hasStatus&&!this.actorSnapshotConnected
      ?{...this.compatibilityChannelPatch(),connectionState:'online'}
      :this.actorPhasePatch(update.phase,typeof update.payload==='string'?update.payload:undefined));
    this.flushStatus();
    this.scheduleActorEventAck(update.eventId);
  }

  private queueActorEvent(update:PrinterActorEvent,stableId:string,epoch:number){
    const task=this.actorEventTail.catch(()=>{}).then(()=>this.applyActorEvent(update,stableId,epoch));
    this.actorEventTail=task;
    return task;
  }

  private scheduleActorEventAck(throughEventId:number){
    if(throughEventId<=0)return;
    this.actorAckHighWater=Math.max(this.actorAckHighWater,throughEventId);
    this.armActorEventAck();
  }

  private armActorEventAck(delayMs=50){
    if(this.actorAckTimer!==undefined||this.actorAckInFlight||this.actorAckHighWater<=0)return;
    this.actorAckTimer=window.setTimeout(()=>{
      this.actorAckTimer=undefined;
      void this.flushActorEventAcks();
    },delayMs);
  }

  private async flushActorEventAcks(){
    if(this.actorAckInFlight||this.actorAckHighWater<=0)return;
    const throughEventId=this.actorAckHighWater;
    this.actorAckHighWater=0;
    this.actorAckInFlight=true;
    let retry=false;
    try{
      await secureInvoke<number>('printer_actor_events_ack',{printerId:this.config.id,host:this.config.host,throughEventId});
    }catch(error){
      retry=true;
      this.actorAckHighWater=Math.max(this.actorAckHighWater,throughEventId);
      diagnosticWarning('printer.actor.outbox_ack',error,{printerId:this.config.id,operation:'actor.events.ack'});
    }finally{
      this.actorAckInFlight=false;
      this.armActorEventAck(retry?500:50);
    }
  }

  private async connectActor(epoch:number){
    try{
      const stableId=this.stableId();
      let authoritativeStableId=stableId,replaying=true;
      const buffered:PrinterActorEvent[]=[];
      const unlisten=await listen<PrinterActorEvent>('printer-actor-event',event=>{
        if(replaying)buffered.push(event.payload);
        else void this.queueActorEvent(event.payload,authoritativeStableId,epoch);
      });
      if(!this.connectionActive(epoch)){unlisten();return false}
      this.actorUnlisten=unlisten;
      const snapshot=await secureInvoke<PrinterActorSnapshot>('printer_actor_upsert',{
        config:{
          stableId,
          printerId:this.config.id,
          modelId:this.config.modelSelection?.selectedPreset??this.config.profile?.preset??'custom',
          host:this.config.host,
          defaultPort:this.moonrakerDefaultPort(),
          firmwareSignature:this.config.configSnapshot?.firmwareSignature??null,
          capabilitiesHint:this.config.capabilities??null,
        },
        apiKey:this.config.apiKey||null,
      });
      if(!this.connectionActive(epoch)){unlisten();return false}
      if(snapshot.printerId!==this.config.id||snapshot.host!==this.config.host)throw new Error('PrinterActor вернул другой адрес или идентификатор принтера');
      this.actorActive=true;
      authoritativeStableId=snapshot.stableId;
      this.actorBridgeUnsubscribe=subscribeActorBridge({
        printerId:this.config.id,
        host:this.config.host,
        onSnapshot:update=>{if(this.connectionActive(epoch)&&this.actorActive)this.applyActorSnapshot(update)},
        onEvent:update=>{if(this.connectionActive(epoch)&&this.actorActive)void this.queueActorEvent(update,authoritativeStableId,epoch)},
        onMissing:()=>this.handleActorSnapshotMissing(epoch),
        onError:error=>this.handleActorBridgeError(error,epoch),
      });
      this.applyActorSnapshot(snapshot);
      const pending=await secureInvoke<PrinterActorEvent[]>('printer_actor_events_pending',{printerId:this.config.id,host:this.config.host,limit:512});
      const replay=async(events:PrinterActorEvent[])=>{
        const ordered=[...events].sort((left,right)=>(left.eventId||0)-(right.eventId||0));
        for(const event of ordered)await this.queueActorEvent(event,authoritativeStableId,epoch);
      };
      await replay(pending);
      while(buffered.length)await replay(buffered.splice(0));
      replaying=false;
      return true;
    }catch(error){
      this.actorUnlisten?.();
      this.actorUnlisten=undefined;
      this.actorBridgeUnsubscribe?.();
      this.actorBridgeUnsubscribe=undefined;
      this.stopActorCompatibilityPoll();
      this.actorActive=false;
      diagnosticWarning('printer.actor.bootstrap',error,{printerId:this.config.id,operation:'actor.upsert'});
      if(/ADDRESS_IDENTITY_CONFLICT/.test(String(error instanceof Error?error.message:error))){
        this.addressIdentityConflict=true;this.lastState='offline';
        this.emitNow({state:'offline',connectionState:'offline',remoteControlSuspended:true,connectionReason:'quarantine',connectionMessage:'Конфликт адреса: IP уже связан с другим принтером. Проверяем фактическое устройство.',fanSpeed:undefined,telemetryUpdatedAt:undefined,nozzleUpdatedAt:undefined,bedUpdatedAt:undefined,jobUpdatedAt:undefined,lastSeen:undefined});
        // This failure has been handled. Do not bypass the native identity
        // guard through the older direct REST compatibility path.
        return true;
      }
      return false;
    }
  }

  private handleActorSnapshotMissing(epoch:number){
    if(!this.connectionActive(epoch)||!this.actorActive)return;
    this.actorSnapshotMissing++;
    this.actorSnapshotConnected=false;
    if(this.actorSnapshotMissing>=2)this.scheduleActorCompatibilityPoll(100);
    if(this.actorSnapshotMissing>=4)this.requestActorRecovery(epoch,'daemon не вернул зарегистрированный PrinterActor');
  }

  private handleActorBridgeError(error:unknown,epoch:number){
    if(!this.connectionActive(epoch)||!this.actorActive)return;
    this.actorBridgeFailures++;
    if(this.actorBridgeFailures===1)diagnosticWarning('printer.actor.snapshot_bridge',error,{printerId:this.config.id,operation:'actor.snapshots'});
    this.emitNow({connectionState:'degraded',connectionReason:'daemon_recovering',connectionMessage:'Daemon восстанавливается'});
    this.scheduleActorCompatibilityPoll(100);
    if(this.actorBridgeFailures>=3)this.requestActorRecovery(epoch,'канал снимков klipper-farmd не отвечает');
  }

  private requestActorRecovery(epoch:number,reason:string){
    if(this.actorRecoveryInFlight||!this.connectionActive(epoch))return;
    this.actorRecoveryInFlight=true;
    diagnosticWarning('printer.actor.recover',reason,{printerId:this.config.id,operation:'actor.reconnect'});
    void this.reconnect()
      .catch(error=>diagnosticWarning('printer.actor.recover',error,{printerId:this.config.id,operation:'actor.reconnect'}))
      .finally(()=>{this.actorRecoveryInFlight=false});
  }

  private stopActorCompatibilityPoll(){
    if(this.actorCompatibilityTimer!==undefined)window.clearTimeout(this.actorCompatibilityTimer);
    this.actorCompatibilityTimer=undefined;
  }

  private scheduleActorCompatibilityPoll(delay=0,epoch=this.connectionEpoch){
    if(!this.actorActive||this.actorSnapshotConnected||!this.connectionActive(epoch)||this.actorCompatibilityTimer!==undefined||this.actorCompatibilityInFlightEpoch===epoch)return;
    this.actorCompatibilityTimer=window.setTimeout(()=>{
      this.actorCompatibilityTimer=undefined;
      void this.pollActorCompatibility(epoch);
    },this.actorCompatibilityGate.delay(delay));
  }

  private async pollActorCompatibility(epoch:number){
    if(!this.actorActive||this.actorSnapshotConnected||!this.connectionActive(epoch)||this.actorCompatibilityInFlightEpoch===epoch)return;
    this.actorCompatibilityInFlightEpoch=epoch;
    try{
      this.health=connectionAttempt(this.health);
      const probeStarted=performance.now(),k1c=this.prefersK1CCompatibilityMode();
      let connection:{klippyState?:string;message?:string};
      let probeLatency=0;
      if(k1c){
        this.lastTelemetryKlippyState='unknown';
        if(!await this.pollStatus(epoch))throw new Error('Совместимый опрос K1C был прерван');
        connection={klippyState:this.lastTelemetryKlippyState==='unknown'?'ready':this.lastTelemetryKlippyState};
        // On Creality OS the bounded core-status request is itself the most
        // reliable liveness probe; /server/info may stall while printing.
        probeLatency=performance.now()-probeStarted;
      }else{
        connection=await this.readConnectionInfo();
        // Do not include the following full telemetry query in the latency
        // displayed to the operator.
        probeLatency=performance.now()-probeStarted;
        if(normalizeKlippyState(connection.klippyState)==='ready'&&!await this.pollStatus(epoch))throw new Error('Совместимый опрос Moonraker был прерван');
      }
      if(!this.connectionActive(epoch))return;
      this.health=connectionReachable(this.health,{
        klippyState:connection.klippyState,
        message:connection.message??'Moonraker доступен · REST/JSON-RPC',
        latency:probeLatency,
      });
      this.recovery.success();
      this.actorCompatibilityHealthy=true;
      this.actorCompatibilityGate.reset();
      this.actorCompatibilityLastSuccessAt=Date.now();
      const patch=connectionStatusPatch(this.health);
      Object.assign(patch,this.health.klippyState==='ready'?this.compatibilityChannelPatch():{...this.compatibilityChannelPatch(),...patch});
      if(this.lastState==='offline'&&this.health.klippyState==='ready'){
        patch.state='ready';
        this.lastState='ready';
      }
      this.bufferStatus(patch);
      this.flushStatus();
      this.actorCompatibilityObservation={observedAt:this.actorCompatibilityLastSuccessAt,status:{...this.fanControlStatus}};
    }catch(error){
      if(!this.connectionActive(epoch))return;
      this.actorCompatibilityHealthy=false;
      this.actorCompatibilityLastSuccessAt=0;
      this.actorCompatibilityObservation=undefined;
      this.actorCompatibilityGate.failed();
      this.health=connectionFailed(this.health,error);
      this.recovery.failure();
      // The native actor has already completed both bounded WebSocket port
      // attempts. Do not let the compatibility poll re-label that
      // authoritative offline result as an endless initial "connecting"
      // state while its own retry grace is still running.
      const patch=preserveAuthoritativeOffline(this.actorAuthoritativeConnectionState,connectionStatusPatch(this.health));
      this.emitNow(patch);
      diagnosticWarning('printer.actor.compatibility_poll',error,{printerId:this.config.id,operation:'telemetry.compatibility'});
    }finally{
      if(this.actorCompatibilityInFlightEpoch===epoch)this.actorCompatibilityInFlightEpoch=undefined;
      if(this.actorActive&&!this.actorSnapshotConnected&&this.connectionActive(epoch))this.scheduleActorCompatibilityPoll(this.actorCompatibilityHealthy?5_000:this.recovery.nextDelay(2_500),epoch);
    }
  }

  private async nativeRpc(method:string,params?:any,options:NativeRpcOptions={}){
    // Актор перезапускается часто: в базе более четырёх тысяч сессий. Команда, попавшая
    // на смену сессии, отклоняется как STALE_SESSION и раньше уходила наверх как ошибка.
    // Для идемпотентного запроса это не отказ: повторяем один раз с новой сессией.
    const idempotent=IDEMPOTENT_RPC_METHODS.has(method)||/^server\.|^(printer\.info|printer\.objects|machine\.|job_queue\.status|server\.temperature_store)/.test(method);
    if(idempotent){
      try{
        return await this.nativeRpcOnce(method,params,options);
      }catch(error){
        const message=String(error instanceof Error?error.message:String(error));
        if(!/STALE_SESSION/.test(message))throw error;
        diagnosticWarning('printer.actor.stale_session_retry',error,{printerId:this.config.id,operation:method});
        return await this.nativeRpcOnce(method,params,options);
      }
    }
    return await this.nativeRpcOnce(method,params,options);
  }

  private async nativeRpcOnce(method:string,params?:any,options:NativeRpcOptions={}){
    this.assertAuthorizationRetryAllowed();
    try{
      let result:any;
      if(this.actorActive){
        const response=await secureInvoke<PrinterActorOperationResult>('printer_actor_rpc',{
          printerId:this.config.id,
          host:this.config.host,
          method,
          params:params??null,
          preferRest:options.preferRest??false,
          timeoutMs:options.timeoutMs??null,
          expectedSessionEpoch:this.actorEpoch,
          operationId:null,
        });
        if(response.sessionEpoch<this.actorEpoch)throw new Error('STALE_SESSION: PrinterActor вернул устаревший результат');
        this.actorEpoch=response.sessionEpoch;
        if(response.state!=='confirmed'&&response.state!=='recovered')throw new Error(`RESULT_UNKNOWN [${response.operationId}]: состояние операции ${response.state}; проверьте принтер перед повтором`);
        result=response.result;
      }else{
        result=await secureInvoke<any>('moonraker_rpc',{
          printerId:this.config.id,
          host:options.defaultPort?this.moonrakerHostForPort(options.defaultPort):this.config.host,
          apiKey:this.config.apiKey||null,
          method,
          params:params??null,
          preferRest:options.preferRest??false,
          timeoutMs:options.timeoutMs??null,
          defaultPort:options.defaultPort??null,
        });
      }
      this.authorizationRetryUntil=0;
      return result;
    }catch(error){this.captureAuthorizationFailure(error);throw error}
  }

  private async nativeWsRpc(method:string,params?:any,options:NativeRpcOptions={}){
    if(this.actorActive)return this.nativeRpc(method,params,{...options,preferRest:false});
    this.assertAuthorizationRetryAllowed();
    try{
      const result=await secureInvoke<any>('moonraker_ws_rpc',{
        printerId:this.config.id,
        host:options.defaultPort?this.moonrakerHostForPort(options.defaultPort):this.config.host,
        apiKey:this.config.apiKey||null,
        method,
        params:params??null,
        timeoutMs:options.timeoutMs??null,
        defaultPort:options.defaultPort??null,
      });
      this.authorizationRetryUntil=0;
      return result;
    }catch(error){this.captureAuthorizationFailure(error);throw error}
  }

  private authorizationError(error:unknown){return /(?:http(?: error)?[: ]+)?(?:401|403)\b|forbidden|unauthori[sz]ed|api[ _-]?key/i.test(String(error instanceof Error?error.message:error))}
  private assertAuthorizationRetryAllowed(){
    this.assertAddressIdentityAllowed();
    const remaining=this.authorizationRetryUntil-Date.now();
    if(remaining>0)throw new Error(`Moonraker найден — требуется API Key; повторная проверка через ${Math.ceil(remaining/1000)} с`);
  }
  private assertAddressIdentityAllowed(){
    if(this.addressIdentityConflict)throw new Error('ADDRESS_IDENTITY_CONFLICT: адрес принадлежит другому принтеру. Управление приостановлено до подтверждения устройства.');
  }
  private captureAuthorizationFailure(error:unknown){
    if(this.authorizationError(error))this.authorizationRetryUntil=Date.now()+(document.hidden?5*60_000:60_000);
  }
  resetAuthorizationBackoff(){this.authorizationRetryUntil=0;this.recovery=new ConnectionRecovery()}

  prefersK1CCompatibilityMode(){
    if(this.config.profile?.preset==='creality-k1c-2025')return true;
    const detected=this.config.modelSelection?.lastDetection;
    if(detected?.status==='matched'&&detected.model==='creality-k1c-2025'&&!(detected.conflicts?.length??0))return true;
    const facts=this.config.configSnapshot?.facts;
    const identity=[this.config.name,facts?.identity?.manufacturer,facts?.identity?.model,facts?.identity?.product]
      .filter((value):value is string=>typeof value==='string')
      .join(' ')
      .toLowerCase();
    return /\bk1c(?:\s*2025)?\b/.test(identity);
  }

  private configuredMoonrakerPort(){
    const authority=this.config.host.trim().replace(/^http:\/\//i,'').replace(/\/$/,'');
    const match=authority.startsWith('[')
      ?authority.match(/^\[[^\]]+\]:(\d+)$/)
      :authority.split(':').length===2?authority.match(/:(\d+)$/):undefined;
    if(!match)return undefined;
    const port=Number(match[1]);
    return Number.isInteger(port)&&port>0&&port<=65535?port:undefined;
  }

  moonrakerDefaultPort():MoonrakerDefaultPort{
    const actorPort=this.currentActorFilePort();
    if(actorPort!==undefined)return actorPort;
    return this.prefersK1CCompatibilityMode()?this.k1cTelemetryTransport.defaultPort:7125;
  }

  private currentActorFilePort(){
    const actor=this.actorIdentity;
    return this.actorActive&&actor?.printerId===this.config.id&&actor.host===this.config.host?this.actorFilePort:undefined;
  }

  private moonrakerHostForPort(port:MoonrakerDefaultPort){
    // File HTTP requests must follow the same attested route as telemetry.
    // The actor can discover port 80 on Forge-X or 7125 on K1C even when the
    // saved address has no port or the compatibility probe remembers another.
    if(!this.prefersK1CCompatibilityMode()&&this.currentActorFilePort()===undefined)return this.config.host;
    const configured=this.configuredMoonrakerPort();
    if(configured!==undefined&&configured!==80&&configured!==7125)return this.config.host;
    try{
      const value=this.config.host.trim(),url=new URL(/^https?:\/\//i.test(value)?value:`http://${value}`);
      const hostname=url.hostname.replace(/^\[|\]$/g,'');
      return hostname.includes(':')?`[${hostname}]:${port}`:`${hostname}:${port}`;
    }catch{return this.config.host}
  }

  moonrakerEndpoint(){return this.moonrakerHostForPort(this.moonrakerDefaultPort())}

  private channelFromTransport(transport:K1CTransport):MoonrakerChannel{
    return{protocol:transport.protocol as MoonrakerProtocol,port:transport.defaultPort as MoonrakerPort};
  }

  private transportFromChannel(channel:MoonrakerChannel):K1CTransport{
    return{protocol:channel.protocol,defaultPort:channel.port};
  }

  private k1cConnectionMessage(){
    const protocol=this.k1cTelemetryTransport.protocol==='websocket'?'WebSocket':this.k1cTelemetryTransport.protocol==='rest'?'REST':'JSON-RPC';
    const port=this.k1cTelemetryTransport.defaultPort;
    return `K1C · ${protocol} :${port} активен`;
  }

  prefersConservativeBackgroundMode(){return this.prefersLowResourceMode()||this.prefersK1CCompatibilityMode()||this.configuredMoonrakerPort()===80}

  private async acquireConservativeIo(){
    let releaseTicket:()=>void=()=>{};
    const ticket=new Promise<void>(resolve=>{releaseTicket=resolve});
    const previous=this.conservativeIoTail.catch(()=>{});
    this.conservativeIoTail=previous.then(()=>ticket);
    await previous;
    let released=false;
    return()=>{if(released)return;released=true;releaseTicket()};
  }

  prefersLowResourceMode(){
    if(this.config.profile?.preset==='flashforge-ad5m'||this.config.profile?.firmwareFamily==='flashforge-klipper'||this.availableObjects.has('gcode_macro NOLEVELING_PRINT_FILE'))return true;
    const detected=this.config.modelSelection?.lastDetection;
    if(detected?.status==='matched'&&detected.model==='flashforge-ad5m'&&!(detected.conflicts?.length??0))return true;
    const facts=this.config.configSnapshot?.facts,verified=[
      facts?.identity?.manufacturer,facts?.identity?.model,facts?.identity?.product,
      facts?.firmware?.distribution,facts?.firmware?.family,...(facts?.macroNames??[]),
    ].filter((value):value is string=>typeof value==='string').join(' ').toLowerCase();
    return /\b(?:flashforge|ad5m|adventurer 5m|forge[- ]?x)\b/.test(verified);
  }

  private backgroundFileWorkAllowed(){return !this.prefersLowResourceMode()||(this.lastState==='ready'&&Date.now()>=this.resourceQuietUntil)}

  private expectedMoonrakerStopActive(now=Date.now()){
    return this.expectedMoonrakerStopUntil>now&&(this.lastState==='printing'||this.lastState==='paused');
  }

  private nextPollDelay(){
    const lowResource=this.prefersLowResourceMode();
    const k1c=this.prefersK1CCompatibilityMode();
    if(this.authorizationRetryUntil>Date.now())return Math.max(1_000,this.authorizationRetryUntil-Date.now());
    if(this.expectedMoonrakerStopActive())return document.hidden?60_000:30_000;
    if(this.health.phase==='offline')return this.recovery.nextDelay(lowResource?5000:3500,document.hidden?60_000:45_000);
    if(document.hidden)return lowResource||k1c?15000:8000;
    if(lowResource&&(this.lastState==='printing'||this.lastState==='paused'))return 12_000;
    if(lowResource&&Date.now()<this.resourceQuietUntil)return 7000;
    if(lowResource&&this.health.phase==='online')return 5000;
    if(k1c&&this.health.phase==='online')return 5000;
    if(k1c&&this.health.phase==='degraded')return 6000;
    if(this.telemetryQueryMode==='split'&&this.health.phase==='online')return 5000;
    if(this.health.phase==='online')return 2500;
    if(this.health.phase==='degraded')return 3500;
    if(this.health.phase==='connecting')return 1800;
    return this.recovery.nextDelay(lowResource?5000:3500,45_000);
  }

  private schedulePoll(delay=this.nextPollDelay(),epoch=this.connectionEpoch){
    if(this.addressIdentityConflict||this.actorActive||!this.connectionActive(epoch))return;
    if(this.pollTimer)window.clearTimeout(this.pollTimer);
    this.pollTimer=window.setTimeout(()=>this.pollOnce(epoch),delay+(document.hidden?0:Math.round(Math.random()*300)));
  }

  private async readConnectionInfo(){
    let server:any,serverError:unknown;
    const preferRest=this.prefersLowResourceMode();
    try{server=moonrakerRecord(await this.nativeRpc('server.info',undefined,{preferRest}))}catch(error){serverError=error}
    const state=normalizeKlippyState(server?.klippy_state);
    if(!server||state==='unknown'||state==='shutdown'||state==='error'){
      try{
        const printer=moonrakerRecord(await this.nativeRpc('printer.info',undefined,{preferRest}));
        return{klippyState:printer?.state??server?.klippy_state,message:typeof printer?.state_message==='string'?printer.state_message.slice(0,1500):server?'Moonraker доступен · состояние Klipper подтверждено':'Moonraker доступен · совместимый режим API'};
      }catch(printerError){
        if(!server)throw serverError??printerError;
      }
    }
    return{klippyState:server?.klippy_state};
  }

  private async refreshObjectCatalog(epoch:number){
    try{
      const listed=await this.nativeRpc('printer.objects.list');
      if(!this.connectionActive(epoch))return false;
      const names=moonrakerObjectNames(listed);
      this.availableObjects=new Set(names);
      this.sensorObjects=names.filter(name=>name.startsWith('filament_switch_sensor ')||name.startsWith('filament_motion_sensor ')).slice(0,64);
      this.fanObject=names.includes('fan')?'fan':names.find(name=>/^fan_generic (?:fanm106|part|model|aux)/i.test(name))??'fan';
      return true;
    }catch(error){diagnosticWarning('moonraker.objects.catalog',error,{printerId:this.config.id,operation:'background.catalog'});return false}
  }

  private async pollOnce(epoch=this.connectionEpoch){
    if(!this.connectionActive(epoch))return;
    try{
      await this.requestScheduler.run('background','telemetry.poll',()=>this.pollOnceScheduled(epoch),{coalesceKey:'telemetry.poll'});
    }catch(error){
      if(!this.connectionActive(epoch)||error instanceof RequestCancelledError||(error instanceof Error&&error.name==='AbortError'))return;
      diagnosticError('moonraker.poll.scheduler',error,{printerId:this.config.id,operation:'telemetry.poll'});
      this.schedulePoll(this.recovery.nextDelay(1800),epoch);
    }
  }

  private async pollOnceScheduled(epoch=this.connectionEpoch){
    if(!this.connectionActive(epoch)||this.transport!=='http'||this.pollInFlightEpoch===epoch)return;
    if(this.prefersConservativeBackgroundMode()&&this.backgroundInFlight.size){
      this.schedulePoll(750,epoch);
      return;
    }
    this.pollInFlightEpoch=epoch;
    this.pollSettled=new Promise<void>(resolve=>{this.resolvePollSettled=resolve});
    let releaseIo=()=>{};
    try{
      if(this.prefersConservativeBackgroundMode())releaseIo=await this.acquireConservativeIo();
      if(!this.connectionActive(epoch))return;
      this.health=connectionAttempt(this.health);
      const now=Date.now();
      const k1c=this.prefersK1CCompatibilityMode();
      const reuseReadyProbe=this.prefersLowResourceMode()
        &&this.health.klippyState==='ready'
        &&this.health.phase!=='offline'
        &&now-this.lastConnectionProbeAt<30_000;
      const probeStarted=performance.now();
      let statusAlreadyPolled=false;
      const connection=k1c
        ?await (async()=>{
          // Creality OS may stall /server/info and, depending on its current
          // load, either the REST or JSON-RPC object-query transport. A small
          // job snapshot is both the liveness probe and the status source; the
          // client can switch transport without treating one endpoint timeout
          // as a complete printer outage.
          this.lastTelemetryKlippyState='unknown';
          statusAlreadyPolled=await this.pollStatus(epoch);
          if(!statusAlreadyPolled)throw new Error('Опрос K1C был прерван');
          return{
            klippyState:this.lastTelemetryKlippyState==='unknown'?'ready':this.lastTelemetryKlippyState,
            message:this.k1cConnectionMessage(),
          };
        })()
        :reuseReadyProbe
          ?{klippyState:'ready',message:'Forge-X · облегчённый контроль Moonraker'}
          :await this.readConnectionInfo();
      const probeLatency=reuseReadyProbe?this.health.latency:performance.now()-probeStarted;
      if(!reuseReadyProbe)this.lastConnectionProbeAt=now;
      if(!this.connectionActive(epoch))return;
      this.health=connectionReachable(this.health,{klippyState:connection.klippyState,message:connection.message,latency:probeLatency});
      this.recovery.success();
      const klippyState=this.health.klippyState;
      if(klippyState!=='ready'){
        const patch=connectionStatusPatch(this.health);
        Object.assign(patch,{...this.compatibilityChannelPatch(),...patch});
        this.lastState=patch.state??this.lastState;
        this.emitNow(patch);
        return;
      }

      this.pollCount++;
      const lowResourceActive=this.prefersLowResourceMode()&&(this.lastState==='printing'||this.lastState==='paused'||Date.now()<this.resourceQuietUntil);
      const catalogDue=(!this.availableObjects.size&&now-this.lastObjectCatalogAttemptAt>=60_000)
        ||(!!this.availableObjects.size&&this.pollCount%120===0);
      try{
        if((!statusAlreadyPolled&&!await this.pollStatus(epoch))||!this.connectionActive(epoch))return;
        this.health=connectionReachable(this.health,{klippyState:'ready',message:k1c?this.k1cConnectionMessage():'Moonraker и Klipper доступны',latency:probeLatency});
        const patch=connectionStatusPatch(this.health);
        Object.assign(patch,this.compatibilityChannelPatch());
        if(this.expectedMoonrakerStopUntil&&Date.now()-this.expectedMoonrakerStopArmedAt>=10_000){
          this.expectedMoonrakerStopUntil=0;
          this.expectedMoonrakerStopArmedAt=0;
          patch.remoteControlSuspended=false;
        }
        if(this.lastState==='offline'||this.lastState==='error'){
          patch.state='ready';
          this.lastState='ready';
        }
        this.bufferStatus(patch);
        this.flushStatus();
        if(catalogDue&&!lowResourceActive&&!k1c&&!this.objectCatalogInFlight){
          this.lastObjectCatalogAttemptAt=now;
          const task=this.refreshObjectCatalog(epoch);
          this.objectCatalogInFlight=task;
          try{await task}catch(error){diagnosticWarning('moonraker.objects.catalog',error,{printerId:this.config.id,operation:'background.catalog'})}
          finally{if(this.objectCatalogInFlight===task)this.objectCatalogInFlight=undefined}
        }
      }catch(error){
        if(!this.connectionActive(epoch))return;
        if(this.expectedMoonrakerStopActive()){
          this.emitNow({
            state:this.lastState,
            connectionState:'degraded',
            klippyState:'disconnected',
            remoteControlSuspended:true,
            connectionMessage:'Forge-X печатает автономно · Moonraker остановлен командой STOP_MOD',
            lastAttempt:Date.now(),
          });
          return;
        }
        if(this.expectedMoonrakerStopUntil){
          this.expectedMoonrakerStopUntil=0;
          this.expectedMoonrakerStopArmedAt=0;
          this.emitNow({remoteControlSuspended:false});
        }
        const reason=String(error instanceof Error?error.message:error).slice(0,180);
        this.health=connectionReachable(this.health,{klippyState:'ready',degraded:true,message:`Moonraker доступен · телеметрия временно недоступна: ${reason}`,latency:probeLatency});
        const patch=connectionStatusPatch(this.health);
        if(this.lastState==='offline'){
          patch.state='ready';
          this.lastState='ready';
        }
        this.emitNow(patch);
      }
    }catch(e:any){
      if(!this.connectionActive(epoch))return;
      if(this.expectedMoonrakerStopActive()){
        this.emitNow({
          state:this.lastState,
          connectionState:'degraded',
          klippyState:'disconnected',
          remoteControlSuspended:true,
          connectionMessage:'Forge-X печатает автономно · Moonraker остановлен командой STOP_MOD',
          lastAttempt:Date.now(),
        });
        return;
      }
      if(this.expectedMoonrakerStopUntil){
        this.expectedMoonrakerStopUntil=0;
        this.expectedMoonrakerStopArmedAt=0;
        this.emitNow({remoteControlSuspended:false});
      }
      this.health=connectionFailed(this.health,e);
      this.recovery.failure();
      diagnosticWarning('moonraker.connection',e,{printerId:this.config.id,operation:'telemetry.poll'});
      const patch=connectionStatusPatch(this.health);
      if(patch.state)this.lastState=patch.state;
      this.emitNow(patch);
    }finally{
      releaseIo();
      if(this.pollInFlightEpoch===epoch)this.pollInFlightEpoch=undefined;
      this.resolvePollSettled?.();
      this.resolvePollSettled=undefined;
      this.pollSettled=undefined;
      if(this.connectionActive(epoch))this.schedulePoll(undefined,epoch);
    }
  }

  private async queryObjectStatus(objects:Record<string,string[]|null>,options?:NativeRpcOptions){
    const result=await this.nativeRpc('printer.objects.query',{objects},options??{preferRest:this.prefersLowResourceMode()});
    const status=moonrakerStatus(result);
    if(!Object.keys(status).length)throw new Error('Moonraker вернул пустой снимок объектов');
    return status;
  }

  private async queryObjectGroup(objects:Record<string,string[]|null>,epoch:number,repairMissing=true){
    let grouped:Record<string,any>={};
    let groupedError:unknown;
    try{grouped=await this.queryObjectStatus(objects)}catch(error){groupedError=error}
    if(!this.connectionActive(epoch))return grouped;
    if(!repairMissing)return grouped;
    for(const [name,fields] of Object.entries(objects)){
      if(grouped[name]!==undefined)continue;
      try{Object.assign(grouped,await this.queryObjectStatus({[name]:fields}))}
      catch(error){diagnosticWarning('moonraker.objects.repair',`${name}: ${String(error instanceof Error?error.message:error)}`,{printerId:this.config.id,operation:'telemetry.repair'})}
      if(!this.connectionActive(epoch))break;
    }
    if(!Object.keys(grouped).length)throw groupedError??new Error('Объекты Moonraker недоступны');
    return grouped;
  }

  private async splitObjectStatus(objects:Record<string,string[]|null>,epoch:number){
    const merged:Record<string,any>={};
    const coreNames=new Set(['print_stats','virtual_sdcard','extruder','heater_bed','webhooks']);
    const groups:Record<string,string[]|null>[]=[
      {extruder:null,heater_bed:null},
      {print_stats:null,virtual_sdcard:null,webhooks:null},
    ];
    const optional=Object.fromEntries(Object.entries(objects).filter(([name])=>!coreNames.has(name)));
    for(const group of groups){
      try{Object.assign(merged,await this.queryObjectGroup(group,epoch,true))}
      catch(error){diagnosticWarning('moonraker.objects.core_group',error,{printerId:this.config.id,operation:'telemetry.split'})}
      if(!this.connectionActive(epoch))return merged;
    }
    if(Object.keys(optional).length){
      try{Object.assign(merged,await this.queryObjectGroup(optional,epoch,false))}
      catch(error){diagnosticWarning('moonraker.objects.optional_group',error,{printerId:this.config.id,operation:'telemetry.optional'})}
    }
    if(!Object.keys(merged).length)throw new Error('Совместимый покомпонентный запрос Moonraker не вернул данных');
    return merged;
  }

  private hasHeaterTelemetry(status:Record<string,any>){
    const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&Number.isFinite(Number.parseFloat(value));
    return numeric(status.extruder?.temperature)||numeric(status.heater_bed?.temperature);
  }

  private hasJobTelemetry(status:Record<string,any>){
    return status.print_stats?.state!==undefined||status.print_stats?.filename!==undefined||status.virtual_sdcard?.progress!==undefined;
  }

  private k1cAlternateTransportAllowed(error:unknown){
    // Never try another transport to work around an authorization failure.
    // Both channels use the same saved printer identity and API key.
    return !/(?:http(?: error)?[: ]+)?(?:401|403)\b|forbidden|unauthori[sz]ed|api[ _-]?key/i.test(String(error instanceof Error?error.message:error));
  }

  private k1cTransportCandidates(){
    const configured=this.configuredMoonrakerPort();
    const ports:MoonrakerDefaultPort[]=configured===80?[80,7125]:configured===7125?[7125,80]:[80,7125];
    const candidates:K1CTransport[]=[];
    for(const defaultPort of ports)candidates.push({protocol:'websocket',defaultPort});
    for(const defaultPort of ports)candidates.push({protocol:'rest',defaultPort});
    for(const defaultPort of ports)candidates.push({protocol:'jsonrpc',defaultPort});
    return this.channelHealth.ordered(candidates.map(candidate=>this.channelFromTransport(candidate))).map(channel=>this.transportFromChannel(channel));
  }

  private k1cTransportLabel(transport:K1CTransport){
    const protocol=transport.protocol==='websocket'?'WS':transport.protocol==='rest'?'REST':'JSON-RPC';
    return `${protocol}:${transport.defaultPort}`;
  }

  private async queryK1CStatusVia(transport:K1CTransport,objects:Record<string,string[]|null>,timeoutMs:number){
    const params={objects};
    const result=transport.protocol==='websocket'
      ?await this.nativeWsRpc('printer.objects.query',params,{timeoutMs,defaultPort:transport.defaultPort})
      :await this.nativeRpc('printer.objects.query',params,{preferRest:transport.protocol==='rest',timeoutMs,defaultPort:transport.defaultPort});
    const status=moonrakerStatus(result);
    if(!Object.keys(status).length)throw new Error('Moonraker вернул пустой снимок объектов');
    return status;
  }

  private async queryK1CCoreStatus(epoch:number){
    // Job/state data is deliberately separated from heaters and other optional
    // objects. A slow temperature object must not erase the current job or make
    // a reachable K1C appear offline.
    const objects:Record<string,string[]|null>={
      print_stats:null,
      virtual_sdcard:null,
    };
    const candidates=this.k1cTransportCandidates();
    if(!candidates.length)throw new Error('K1C: circuit breaker временно остановил запросы к неисправным портам');
    const errors:string[]=[];
    for(let index=0;index<candidates.length;index++){
      const candidate=candidates[index];
      const requestStarted=performance.now();
      try{
        const status=await this.queryK1CStatusVia(candidate,objects,index===0?2200:1400);
        if(!this.hasJobTelemetry(status))throw new Error('Moonraker вернул частичный снимок без print_stats/virtual_sdcard');
        if(this.connectionActive(epoch)){
          const previous=this.channelHealth.active();
          const active=this.channelHealth.recordSuccess(this.channelFromTransport(candidate),performance.now()-requestStarted);
          this.k1cTelemetryTransport=this.transportFromChannel(active);
          if(previous.protocol!==active.protocol||previous.port!==active.port){
            const route=this.channelHealth.snapshot();
            diagnosticInfo('moonraker.channel_switch',`${previous.protocol}:${previous.port} → ${active.protocol}:${active.port} · ${route.lastSwitchReason??'route_change'}`,{printerId:this.config.id,operation:'telemetry.route'});
          }
        }
        return status;
      }catch(error){
        this.channelHealth.recordFailure(this.channelFromTransport(candidate),error);
        if(!this.connectionActive(epoch)||!this.k1cAlternateTransportAllowed(error))throw error;
        const message=String(error instanceof Error?error.message:error).replace(/\s+/g,' ').slice(0,110);
        errors.push(`${this.k1cTransportLabel(candidate)} — ${message}`);
      }
    }
    throw new Error(`K1C: не ответили ${errors.join('; ')}`);
  }

  private async refreshK1CExtendedTelemetry(epoch:number){
    const now=Date.now();
    if(this.k1cExtendedTelemetryInFlight)return await this.k1cExtendedTelemetryInFlight;
    if(now-this.lastK1cExtendedTelemetryAt<10_000)return;
    this.lastK1cExtendedTelemetryAt=now;
    const task=(async()=>{
      try{
        const status=await this.queryK1CStatusVia(this.k1cTelemetryTransport,{
          extruder:null,
          heater_bed:null,
        },1600);
        if(!this.connectionActive(epoch))return;
        this.applyStatus(status);
        this.flushStatus();
      }catch(error){
        // Optional heater telemetry is best-effort. Core job/state polling has
        // already confirmed the printer, so this must never change it offline.
        diagnosticWarning('moonraker.k1c.extended',error,{printerId:this.config.id,operation:'background.heaters'});
      }
    })();
    this.k1cExtendedTelemetryInFlight=task;
    try{await task}finally{if(this.k1cExtendedTelemetryInFlight===task)this.k1cExtendedTelemetryInFlight=undefined}
  }

  private async pollStatus(epoch:number){
    const core:Record<string,string[]|null>={
      print_stats:null,
      virtual_sdcard:['progress'],
      extruder:['temperature','target'],
      heater_bed:['temperature','target'],
      webhooks:null,
    };
    const objects:Record<string,string[]|null>={...core};
    const catalog=this.availableObjects;
    const k1c=this.prefersK1CCompatibilityMode();
    const lowResourceActive=this.prefersLowResourceMode()&&(this.lastState==='printing'||this.lastState==='paused'||Date.now()<this.resourceQuietUntil);
    const add=(name:string,fields:string[]|null)=>{if(!catalog.size||catalog.has(name))objects[name]=fields};
    if(!lowResourceActive&&!k1c){
      add('display_status',null);
      add('toolhead',['position']);
      add('gcode_move',['speed_factor']);
      add(this.fanObject,['speed']);
      this.sensorObjects.forEach(name=>objects[name]=['filament_detected','enabled']);
    }
    const allFields=Object.fromEntries(Object.keys(objects).map(name=>[name,null])) as Record<string,null>;
    let status:Record<string,any>={};
    let firstError:unknown;
    if(k1c){
      try{
        status=await this.queryK1CCoreStatus(epoch);
        await this.refreshK1CExtendedTelemetry(epoch);
      }catch(error){firstError=error}
    }else if(this.telemetryQueryMode==='split'){
      status=await this.splitObjectStatus(objects,epoch);
    }else{
      try{
        status=await this.queryObjectStatus(this.telemetryQueryMode==='all'?allFields:objects);
      }catch(error){firstError=error}
      if(!this.connectionActive(epoch))return false;

      // Creality OS forks can accept the query yet silently omit heaters when
      // a requested field or companion object is unsupported.  A bounded
      // all-fields probe distinguishes this from a genuinely empty printer.
      if((!Object.keys(status).length||!this.hasHeaterTelemetry(status)||!this.hasJobTelemetry(status))&&!lowResourceActive&&this.telemetryQueryMode==='fields'){
        try{
          const compatible=await this.queryObjectStatus(allFields);
          status={...status,...compatible};
          if(this.hasHeaterTelemetry(compatible)&&this.hasJobTelemetry(compatible))this.telemetryQueryMode='all';
        }catch(error){firstError??=error}
      }
      if((!Object.keys(status).length||!this.hasHeaterTelemetry(status)||!this.hasJobTelemetry(status))&&!lowResourceActive){
        try{
          const split=await this.splitObjectStatus(objects,epoch);
          status={...status,...split};
          if(this.hasHeaterTelemetry(split)&&this.hasJobTelemetry(split))this.telemetryQueryMode='split';
        }catch(error){firstError??=error}
      }
    }
    if(!this.connectionActive(epoch))return false;
    if(!Object.keys(status).length)throw firstError??new Error('Moonraker вернул пустой снимок объектов');
    if(!this.hasJobTelemetry(status)){
      this.applyStatus(status);
      throw firstError??new Error('Moonraker не вернул print_stats/virtual_sdcard ни одним совместимым способом');
    }
    this.applyStatus(status);
    return true;
  }

  disconnect(){
    this.lightTarget=undefined;
    this.fanControlStatus={state:'offline',connectionState:'offline'};
    this.connectionEpoch++;
    this.closedByUser=true;
    if(this.actorAckTimer!==undefined)window.clearTimeout(this.actorAckTimer);
    this.actorAckTimer=undefined;
    void this.flushActorEventAcks();
    this.uploadController=undefined;
    this.activeUploadId=undefined;
    this.actorActive=false;
    this.actorIdentity=undefined;
    this.actorFilePort=undefined;
    this.actorEpoch=0;
    this.actorEventId=0;
    this.actorEventTail=Promise.resolve();
    this.actorUnlisten?.();
    this.actorUnlisten=undefined;
    this.actorBridgeUnsubscribe?.();
    this.actorBridgeUnsubscribe=undefined;
    this.actorSnapshotConnected=false;
    this.actorSnapshotMissing=0;
    this.actorBridgeFailures=0;
    this.actorCompatibilityHealthy=false;
    this.actorCompatibilityLastSuccessAt=0;
    this.actorCompatibilityObservation=undefined;
    this.actorAuthoritativeConnectionState='connecting';
    this.actorCompatibilityGate.reset();
    this.stopActorCompatibilityPoll();
    this.requestScheduler.close();
    this.objectCatalogInFlight=undefined;
    this.k1cExtendedTelemetryInFlight=undefined;
    this.lastK1cExtendedTelemetryAt=0;
    this.thumbnailGeneration++;
    this.resourceQuietUntil=0;
    this.expectedMoonrakerStopUntil=0;
    this.expectedMoonrakerStopArmedAt=0;
    this.lastTelemetryKlippyState='unknown';
    document.removeEventListener('visibilitychange',this.visibilityHandler);
    if(this.pollTimer)window.clearTimeout(this.pollTimer);
    this.pollTimer=undefined;
    if(this.statusTimer)window.clearTimeout(this.statusTimer);
    this.statusTimer=undefined;
    this.statusBuffer={};
    this.gcodeTextCache.clear();
    this.metadataCache.clear();
    this.thumbnailCache.clear();
    this.uploadedHashes.clear();
    this.uploadedFiles.clear();
    this.fileEntriesInFlight=undefined;
    this.queueStatusInFlight=undefined;
    this.temperatureStoreInFlight=undefined;
  }
  async reconnect(){ this.disconnect(); this.closedByUser=false; await this.connect(); }
  onStatus(fn:Listener){ this.listeners.add(fn); return ()=>{this.listeners.delete(fn)}; }
  onResponse(fn:ResponseListener){this.responseListeners.add(fn);return()=>{this.responseListeners.delete(fn)}}
  onPhysicalIdentity(fn:(observation:PrinterPhysicalIdentityObservation)=>void){this.physicalIdentityListeners.add(fn);return()=>{this.physicalIdentityListeners.delete(fn)}}
  private emitPhysicalIdentity(value:unknown,host:string,printerId:string,sessionEpoch:number){
    if(this.closedByUser||host!==this.config.host||printerId!==this.config.id||sessionEpoch<this.actorEpoch||!value||typeof value!=='object'||Array.isArray(value))return;
    const attestation=value as NativeIdentityAttestation,at=attestation.attestedAt;
    if(typeof at!=='number'||!Number.isFinite(at)||at<=0||at>Date.now()+5000||!attestation.signals||typeof attestation.signals!=='object'||Array.isArray(attestation.signals))return;
    const raw=attestation.signals as Record<string,unknown>,signals:PrinterDeviceIdentity['signals']={};
    for(const key of ['machineId','uuid','serial','mcuSerial','macAddress','hostname','board','manufacturer','product'] as const){
      const item=raw[key];if(typeof item==='string'&&item.trim())signals[key]=item.trim().slice(0,256);
    }
    if(!Object.keys(signals).length)return;
    const key=`${host}\u0000${sessionEpoch}\u0000${at}\u0000${JSON.stringify(signals)}`;
    if(key===this.lastPhysicalIdentityKey)return;
    this.lastPhysicalIdentityKey=key;
    const observation:PrinterPhysicalIdentityObservation={signals,attestedAt:at,host,printerId,sessionEpoch};
    // Consumers compare actual anchors, never the native and JS hash formats.
    // Publish before online telemetry so a contradictory responder is masked immediately.
    for(const listener of this.physicalIdentityListeners)try{listener(observation)}catch(error){diagnosticWarning('printer.identity.listener',error,{printerId,operation:'identity.observed'})}
  }
  private emitNow(p:Partial<PrinterStatus>){ this.fanControlStatus={...this.fanControlStatus,...p};this.listeners.forEach(fn=>fn(p)); }


      private bufferStatus(p:Partial<PrinterStatus>){

        this.fanControlStatus={...this.fanControlStatus,...p};
        this.statusBuffer={...this.statusBuffer,...p};

        if(this.statusTimer)return;

        this.statusTimer=window.setTimeout(()=>{

          this.statusTimer=undefined;

          const patch=this.statusBuffer;

          this.statusBuffer={};

          if(Object.keys(patch).length)this.emitNow(patch);

        },document.hidden?2000:800);

      }


      private flushStatus(){

        if(this.statusTimer)window.clearTimeout(this.statusTimer);

        this.statusTimer=undefined;

        const patch=this.statusBuffer;

        this.statusBuffer={};

        if(Object.keys(patch).length)this.emitNow(patch);

      }

  private rpc(method:string, params?:any,options:NativeRpcOptions={}){
    if(this.prefersK1CCompatibilityMode()&&this.k1cTelemetryTransport.protocol==='websocket'){
      return this.nativeWsRpc(method,params,{defaultPort:this.k1cTelemetryTransport.defaultPort,...options});
    }
    return this.nativeRpc(method,params,{
      preferRest:this.prefersK1CCompatibilityMode()&&this.k1cTelemetryTransport.protocol==='rest',
      defaultPort:this.moonrakerDefaultPort(),
      ...options,
    });
  }

  private applyStatus(s:any,observedAt=Date.now(),sourceTimestamps?:PrinterStatusTimestamps,controllerLive=true){
    const fanObject=printerFanTelemetryObject(s,this.fanObject);
    const ps=s.print_stats ?? {}; const vs=s.virtual_sdcard ?? {}; const ex=s.extruder ?? {}; const bed=s.heater_bed ?? {}; const th=s.toolhead ?? {}; const gm=s.gcode_move ?? {}; const fan=fanObject?s[fanObject]:{}; const webhooks=s.webhooks ?? {};
    const mapped:Partial<PrinterStatus>={};
    const previousState=this.lastState;
    const number=(value:unknown)=>{const parsed=typeof value==='number'?value:typeof value==='string'?Number.parseFloat(value):Number.NaN;return Number.isFinite(parsed)?parsed:undefined};
    const heaterNumber=(value:unknown)=>{const text=typeof value==='string'?value.trim():'';const parsed=typeof value==='number'?value:/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)?Number(text):Number.NaN;return Number.isFinite(parsed)?parsed:undefined};
    const telemetryKlippyState=normalizeKlippyState(webhooks.state);
    if(telemetryKlippyState!=='unknown')this.lastTelemetryKlippyState=telemetryKlippyState;
    if(ps.state){ const state=String(ps.state).toLowerCase();mapped.state=state==='printing'?'printing':state==='paused'?'paused':state==='error'?'error':'ready'; this.lastState=mapped.state; }
    if(ps.filename!==undefined){
      mapped.filename=ps.filename;
      if(typeof ps.filename==='string'){
        if(this.lastStatusFilename!==undefined&&this.lastStatusFilename!==ps.filename&&ps.filament_used===undefined)mapped.filamentUsedMm=undefined;
        this.lastStatusFilename=ps.filename;
      }
    }
    if((mapped.state==='printing'||mapped.state==='paused')&&previousState!=='printing'&&previousState!=='paused'&&ps.filament_used===undefined)mapped.filamentUsedMm=undefined;
    if(typeof ps.state==='string')mapped.printStatsState=ps.state.trim().toLowerCase().slice(0,64);
    if(ps.filament_used!==undefined){
      const used=typeof ps.filament_used==='number'?ps.filament_used:typeof ps.filament_used==='string'&&ps.filament_used.trim()?Number(ps.filament_used):Number.NaN;
      mapped.filamentUsedMm=Number.isFinite(used)&&used>=0?used:undefined;
    }
    const printDuration=number(ps.print_duration),totalDuration=number(ps.total_duration),currentLayer=number(ps.info?.current_layer),totalLayers=number(ps.info?.total_layer),progress=number(vs.progress);
    const nozzle=heaterNumber(ex.temperature),nozzleTarget=heaterNumber(ex.target),bedTemperature=heaterNumber(bed.temperature),bedTarget=heaterNumber(bed.target),speedFactor=number(gm.speed_factor),fanSpeed=number(fanObject?.startsWith('output_pin ')?fan.value:fan.speed);
    if(printDuration!==undefined)mapped.printDuration=printDuration;
    if(totalDuration!==undefined)mapped.totalDuration=totalDuration;
    if(currentLayer!==undefined)mapped.currentLayer=currentLayer;
    if(totalLayers!==undefined)mapped.totalLayers=totalLayers;
    if(progress!==undefined)mapped.progress=Math.max(0,Math.min(1,progress));
    const timestamp=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
    const separateHeaterDates=sourceTimestamps!==undefined&&('nozzleUpdatedAt'in sourceTimestamps||'bedUpdatedAt'in sourceTimestamps);
    const heaterTimestamp=(sensor:'nozzleUpdatedAt'|'bedUpdatedAt')=>timestamp(sourceTimestamps===undefined?observedAt:separateHeaterDates?sourceTimestamps[sensor]:sourceTimestamps.telemetryUpdatedAt);
    // New actors date each heater independently. An older cache for one heater
    // must not replace its newer read or prevent the other heater from advancing.
    // Legacy actors only provide a shared date; preserve that older contract.
    const mergeHeater=(sensor:'nozzle'|'bed',temperature:number|undefined,target:number|undefined)=>{
      const dateKey=sensor==='nozzle'?'nozzleUpdatedAt':'bedUpdatedAt',targetKey=sensor==='nozzle'?'nozzleTarget':'bedTarget';
      const incomingAt=heaterTimestamp(dateKey),previousAt=this.fanControlStatus[dateKey];
      if(previousAt!==undefined&&(incomingAt===undefined||incomingAt<previousAt))return;
      if(temperature!==undefined){mapped[sensor]=temperature;if(incomingAt!==undefined)mapped[dateKey]=incomingAt;}
      if(target!==undefined)mapped[targetKey]=target;
    };
    mergeHeater('nozzle',nozzle,nozzleTarget);mergeHeater('bed',bedTemperature,bedTarget);
    if(mapped.nozzle!==undefined||mapped.bed!==undefined){
      const nozzleAt=mapped.nozzleUpdatedAt??this.fanControlStatus.nozzleUpdatedAt,bedAt=mapped.bedUpdatedAt??this.fanControlStatus.bedUpdatedAt;
      // Overall freshness promises both displayed temperatures, including the
      // initial state: an unobserved heater's default zero is never confirmed.
      mapped.telemetryUpdatedAt=nozzleAt!==undefined&&bedAt!==undefined?Math.min(nozzleAt,bedAt):undefined;
    }
    const jobObservedAt=timestamp(sourceTimestamps===undefined?observedAt:sourceTimestamps.jobUpdatedAt);
    if((ps.state!==undefined||ps.filename!==undefined||ps.filament_used!==undefined||printDuration!==undefined||totalDuration!==undefined||progress!==undefined)&&jobObservedAt!==undefined)mapped.jobUpdatedAt=jobObservedAt;
    if(Array.isArray(th.position))mapped.position=th.position.map((value:unknown)=>number(value)??0).slice(0,4);
    if(speedFactor!==undefined)mapped.speedFactor=speedFactor;
    if(fanSpeed!==undefined&&fanSpeed>=0&&fanSpeed<=1)mapped.fanSpeed=fanSpeed;
    if(ps.message!==undefined) mapped.message=ps.message;
    if(webhooks.state_message||webhooks.message) mapped.connectionMessage=String(webhooks.state_message??webhooks.message).slice(0,1500);
    if(controllerLive&&(telemetryKlippyState==='shutdown'||telemetryKlippyState==='error')){
      mapped.state='error';
      mapped.klippyState=telemetryKlippyState;
      mapped.connectionState='degraded';
      mapped.connectionReason=telemetryKlippyState==='shutdown'?'klipper_shutdown':'klipper_error';
      mapped.connectionMessage??=telemetryKlippyState==='shutdown'?'Klipper shutdown':'Ошибка Klipper';
      this.lastState='error';
    }else if(controllerLive&&telemetryKlippyState!=='unknown')mapped.klippyState=telemetryKlippyState;
    for(const key of this.sensorObjects){const sensor=s[key];if(sensor?.filament_detected!==undefined)mapped.filamentDetected=!!sensor.filament_detected}
    this.bufferStatus(mapped);
  }

  pause(assertApplicable?:()=>void){ return this.runControlRequest(()=>{assertApplicable?.();return this.rpc('printer.print.pause')},'control.pause'); }
  /** Opt-in camera control: the actor rechecks the live job and never replays this pause. */
  guardedPause(expected:{filename:string;minimumPrintDuration:number},stillApplicable:()=>boolean){
    const epoch=this.connectionEpoch,host=this.config.host;
    return this.runControlRequest(()=>{
      if(!this.actorActive||this.closedByUser||this.connectionEpoch!==epoch||this.config.host!==host||!stillApplicable())throw new Error('CAMERA_GUARD_BLOCKED: задание, подключение или режим защиты изменились');
      return this.nativeRpc('printer.print.pause',{_cameraGuard:{filename:expected.filename,minimumPrintDuration:expected.minimumPrintDuration,requestedAtMs:Date.now(),maxAgeMs:10_000}},{timeoutMs:8_000});
    },'control.camera_pause');
  }
  resume(assertApplicable?:()=>void){ return this.runControlRequest(()=>{assertApplicable?.();return this.rpc('printer.print.resume')},'control.resume'); }
  cancel(){ return this.runControlRequest(()=>this.rpc('printer.print.cancel'),'control.cancel'); }
  emergencyStop(){
    if(this.pollTimer)window.clearTimeout(this.pollTimer);
    this.pollTimer=undefined;
    return this.nativeRpc('printer.emergency_stop',undefined,{preferRest:true,timeoutMs:2_500,defaultPort:this.moonrakerDefaultPort()})
      .finally(()=>{if(this.connectionActive(this.connectionEpoch))this.schedulePoll(300)});
  }
  restart(){ return this.runControlRequest(()=>this.rpc('printer.restart'),'control.restart'); }
  firmwareRestart(){ return this.runControlRequest(()=>this.rpc('printer.firmware_restart'),'control.firmware_restart'); }
  async start(filename:string,options:PrintStartOptions={}){
    let attempted=false,operation:Promise<any>|undefined;
    try{
      assertModelDependentOperationAllowed(this.config);
      if(this.pendingPrintStart)throw new Error('Запуск уже отправлен. Дождитесь подтверждения состояния принтера.');
      operation=this.runControlRequest(signal=>this.startInternal(filename,options,signal,()=>{attempted=true}),'control.print_start');
      this.pendingPrintStart=operation;
      return await operation;
    }catch(error){
      if(!attempted)throw printStartDefinitelyNotSent(error)?error:new PrintStartNotSentError(error);
      // A typed marker from a nested/injected transport cannot overrule this
      // invocation's dispatch boundary once the RPC method has been called.
      if(printStartDefinitelyNotSent(error))throw new Error(error.message,{cause:error});
      throw error;
    }finally{if(operation&&this.pendingPrintStart===operation)this.pendingPrintStart=undefined}
  }
  private printStartRootKey(path:string){return `${this.config.id}\u0000${this.config.host}\u0000${this.connectionEpoch}\u0000${this.actorEpoch}\u0000${path}`}
  private async observePrintStart(path:string,timeoutMs=this.prefersConservativeBackgroundMode()?4000:2500){
    const target=`${this.config.id}\u0000${this.config.host}\u0000${this.connectionEpoch}`;
    const deadline=Date.now()+timeoutMs;
    const value=await this.rpc('printer.objects.query',{objects:{print_stats:null,virtual_sdcard:null}},{timeoutMs});
    if(target!==`${this.config.id}\u0000${this.config.host}\u0000${this.connectionEpoch}`)throw new RequestCancelledError('Принтер изменился во время проверки запуска');
    const status=moonrakerStatus(value);
    const key=this.printStartRootKey(path);
    let root=this.printStartFileRoot?.key===key?this.printStartFileRoot.path:undefined;
    let observation=printStartObservation(status,path,root);
    const absoluteFile=[status.print_stats?.filename,status.virtual_sdcard?.file_path].some(value=>typeof value==='string'&&/^(?:\/|[a-z]:[\\/])/i.test(value));
    if(!observation.confirmed&&absoluteFile&&(observation.state==='printing'||observation.state==='paused'||status.virtual_sdcard?.is_active===true)
      &&this.printStartFileRoot?.key!==key&&deadline-Date.now()>=250){
      // Read settings once per pending file/target/session. An arbitrary suffix
      // or equal basename cannot establish which file is active on the printer.
      this.printStartFileRoot={key};
      try{
        const config=moonrakerStatus(await this.rpc('printer.objects.query',{objects:{configfile:['settings']}},{timeoutMs:Math.min(2500,deadline-Date.now())}));
        if(this.printStartRootKey(path)!==key)throw new RequestCancelledError('Сессия принтера изменилась во время проверки запуска');
        const configured=config.configfile?.settings?.virtual_sdcard?.path;
        if(typeof configured==='string'&&configured.length<=2048&&!/[\p{Cc}]/u.test(configured)){
          root=configured;this.printStartFileRoot={key,path:root};
        }
      }catch(error){
        if(error instanceof RequestCancelledError)throw error;
        diagnosticWarning('print.start_root',error,{printerId:this.config.id,operation:'control.check_print_start'});
      }
      observation=printStartObservation(status,path,root);
    }
    this.applyStatus(status);
    if(observation.confirmed)this.applyStatus({print_stats:{state:observation.state,filename:path}});
    this.flushStatus();
    return observation;
  }
  async checkPrintStart(filename:string){
    const path=rawPrintFilePath(filename);if(!path)throw new Error('Некорректное имя файла печати');
    return this.runControlRequest(()=>this.observePrintStart(path),'control.check_print_start');
  }
  /** Read the existing job identity as data, including absolute firmware paths.
   * No filename is sent to a print-start or file endpoint by this operation. */
  async checkPrintJob(filename:string){
    if(typeof filename!=='string'||!filename.trim()||filename.length>4096||/[\p{Cc}]/u.test(filename))throw new Error('Нет корректного имени текущего задания');
    const identity=`${this.config.id}\u0000${this.config.host}\u0000${this.connectionEpoch}`;
    return this.runControlRequest(async()=>{
      if(identity!==`${this.config.id}\u0000${this.config.host}\u0000${this.connectionEpoch}`)throw new RequestCancelledError('Подключение принтера изменилось');
      const status=moonrakerStatus(await this.rpc('printer.objects.query',{objects:{print_stats:null,virtual_sdcard:null}},{timeoutMs:2500}));
      if(identity!==`${this.config.id}\u0000${this.config.host}\u0000${this.connectionEpoch}`)throw new RequestCancelledError('Подключение принтера изменилось');
      const state=String(status.print_stats?.state??'unknown').trim().toLowerCase();
      const actual=typeof status.print_stats?.filename==='string'?status.print_stats.filename:typeof status.virtual_sdcard?.file_path==='string'?status.virtual_sdcard.file_path:'';
      const normalized=(value:string)=>value.replace(/\\/g,'/').normalize('NFC');
      const confirmed=normalized(actual)===normalized(filename)&&(state==='printing'||state==='paused');
      this.applyStatus(status);this.flushStatus();
      return{confirmed,state,filename:actual};
    },'control.check_print_job');
  }
  private async startInternal(filename:string,options:PrintStartOptions={},signal?:AbortSignal,onDispatch?:()=>void){
    const path=rawPrintFilePath(filename);
    if(!path)throw new Error('Некорректное имя файла печати');
    this.printStartFileRoot=undefined;
    const target=`${this.config.id}\u0000${this.config.host}\u0000${this.connectionEpoch}`;
    const assertTarget=()=>{
      if(signal?.aborted||target!==`${this.config.id}\u0000${this.config.host}\u0000${this.connectionEpoch}`)throw new RequestCancelledError('Проверка запуска прервана: подключение принтера изменилось. Команда уже могла быть принята.');
    };
    const lowResource=this.prefersLowResourceMode();
    const conservative=this.prefersConservativeBackgroundMode();
    let releaseIo=()=>{};
    if(conservative){
      if(lowResource)this.resourceQuietUntil=Date.now()+90_000;
      this.thumbnailGeneration++;
      this.thumbnailCache.clear();
      if(this.pollTimer)window.clearTimeout(this.pollTimer);
      this.pollTimer=undefined;
      releaseIo=await this.acquireConservativeIo();
    }
    try{
      assertTarget();
      // Remote clients must use Moonraker's virtual-SD start endpoint.  The
      // Forge-X NOLEVELING_PRINT_FILE macro is explicitly a Stock Screen bridge
      // and must never be selected automatically by a desktop application.
      const actorVerified=this.actorActive;
      let result:any,needsObservation=!actorVerified;
      try{onDispatch?.();result=await this.rpc('printer.print.start',{filename:path})}
      catch(error){
        if(!uncertainPrintStart(error))throw error;
        // The actor may finish its short verification before vendor preparation.
        // Recover by querying the job, never by sending printer.print.start again.
        needsObservation=true;
        diagnosticWarning('print.start_pending',error,{printerId:this.config.id,operation:'control.print_start'});
      }
      assertTarget();
      let confirmedState:'printing'|'paused'='printing';
      const actorStatus=moonrakerStatus(result);
      if(actorVerified&&!Object.keys(actorStatus).length)needsObservation=true;
      if(actorVerified&&Object.keys(actorStatus).length){
        this.applyStatus(actorStatus);
        if(actorStatus.print_stats?.state==='paused')confirmedState='paused';
        if(!printStartObservation(actorStatus,path).confirmed)needsObservation=true;
      }
      // The actor verifies a fresh job status before returning confirmed.
      // Direct transport fallback needs the same observation in this client.
      if(needsObservation){
        const deadline=Date.now()+PRINT_START_CONFIRMATION_MS;
        let detail='принтер не подтвердил состояние задания';
        let observed=false;
        while(Date.now()<deadline&&!signal?.aborted){
          assertTarget();
          try{
            const observation=await this.observePrintStart(path,Math.max(250,Math.min(conservative?4000:2500,deadline-Date.now())));
            assertTarget();
            if(observation.confirmed){confirmedState=observation.state==='paused'?'paused':'printing';observed=true;break}
            detail=`state=${observation.state}, filename=${observation.filename}; ${observation.message}`;
            if(observation.state==='error')throw new Error(`PRINT_START_REJECTED: ${observation.message||'Принтер сообщил ошибку запуска'}`);
          }catch(error){if(String(error).includes('PRINT_START_REJECTED'))throw error;detail=String(error instanceof Error?error.message:error)}
          if(Date.now()<deadline&&!signal?.aborted)await new Promise<void>(resolve=>window.setTimeout(resolve,Math.min(conservative?1000:500,deadline-Date.now())));
        }
        if(signal?.aborted)throw new RequestCancelledError('Ожидание подтверждения прервано. Команда уже могла быть принята; проверьте принтер.');
        if(!observed)throw new Error(`PRINT_START_UNCONFIRMED: команда отправлена, запуск печати не подтверждён; ${detail}. Проверьте принтер перед повтором`);
      }
      assertTarget();
      this.lastState=confirmedState;
      const now=Date.now(),estimated=Number(options.estimatedDuration);
      if(lowResource&&options.expectsMoonrakerStop){
        const windowMs=Number.isFinite(estimated)&&estimated>0
          ?Math.min(7*24*60*60_000,Math.max(30*60_000,estimated*1000+30*60_000))
          :24*60*60_000;
        this.expectedMoonrakerStopArmedAt=now;
        this.expectedMoonrakerStopUntil=now+windowMs;
      }else{
        this.expectedMoonrakerStopArmedAt=0;
        this.expectedMoonrakerStopUntil=0;
      }
      this.bufferStatus({
        state:confirmedState,
        filename:path,
        progress:0,
        remoteControlSuspended:!!(lowResource&&options.expectsMoonrakerStop),
        connectionMessage:lowResource&&options.expectsMoonrakerStop
          ?'Автономная печать · Moonraker будет временно остановлен файлом'
          :'Запуск печати подтверждён принтером',
      });
      this.flushStatus();
      if(conservative)this.schedulePoll(lowResource?(options.expectsMoonrakerStop?30_000:12_000):1200);
      return result;
    }catch(error){
      if(conservative){
        if(lowResource)this.resourceQuietUntil=0;
        this.expectedMoonrakerStopUntil=0;
        this.expectedMoonrakerStopArmedAt=0;
        this.emitNow({remoteControlSuspended:false});
        this.schedulePoll(350);
      }
      throw error;
    }finally{releaseIo()}
  }
  gcode(script:string){ return this.runControlRequest(()=>this.rpc('printer.gcode.script',{script}),'control.gcode').then(result=>{this.responseListeners.forEach(listener=>listener('ok'));return result}); }
  setNozzle(temp:number){ return this.gcode(`SET_HEATER_TEMPERATURE HEATER=extruder TARGET=${temp}`); }
  setBed(temp:number){ return this.gcode(`SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=${temp}`); }
  async setFan(percent:number):Promise<PrinterFanState>{
    if(!Number.isFinite(percent)||percent<0||percent>100)throw new Error('Скорость вентилятора должна быть от 0 до 100%.');
    const p=Math.round(percent),printerId=this.config.id,host=this.config.host,epoch=this.connectionEpoch;
    const assertTarget=(signal?:AbortSignal)=>{
      if(signal?.aborted)throw new RequestCancelledError('Изменение скорости вентилятора отменено.');
      if(!printerId?.trim()||!host?.trim())throw new Error('Принтер для управления вентилятором не определён.');
      if(this.config.id!==printerId||this.config.host!==host||this.connectionEpoch!==epoch)throw new Error('Адрес или сеанс принтера изменился. Подтверждение вентилятора отменено.');
      if(this.closedByUser||this.fanControlStatus.connectionState!=='online'||this.fanControlStatus.remoteControlSuspended)throw new Error('Управление вентилятором недоступно: нет подтверждённого подключения к принтеру.');
    };
    assertTarget();
    return this.runControlRequest(async signal=>{
      assertTarget(signal);
      const listed=checkedFanPayload(await this.rpc('printer.objects.list',undefined,{timeoutMs:2500}));
      assertTarget(signal);
      const objects=moonrakerObjectNames(listed);
      let settings:Record<string,unknown>|undefined;
      if(!objects.includes('fan')||objects.includes('output_pin fan0')||objects.some(name=>name.startsWith('fan_generic '))){
        const config=checkedFanPayload(await this.rpc('printer.objects.query',{objects:{configfile:['settings']}},{timeoutMs:2500}));
        assertTarget(signal);
        const reported=moonrakerStatus(config).configfile?.settings;
        if(reported&&typeof reported==='object'&&!Array.isArray(reported))settings=reported;
      }
      const target=resolvePrinterFan(objects,settings);
      const read=async()=>{
        assertTarget(signal);
        const value=checkedFanPayload(await this.rpc('printer.objects.query',{objects:{[target.object]:[target.kind==='output'?'value':'speed']}},{timeoutMs:2500}));
        assertTarget(signal);
        const mapped=moonrakerStatus(value),status=Object.keys(mapped).length?mapped:moonrakerRecord(value),speed=printerFanSpeed(status,target);
        return{status,speed};
      };
      const before=await read();
      if(before.speed===undefined)throw new Error('Принтер не сообщает скорость выбранного вентилятора. Команда не отправлена.');
      this.fanObject=target.object;
      const confirmed=(speed:number)=>Math.abs(speed-p/100)<=1/255+.00001;
      const accept=(status:Record<string,any>,speed:number):PrinterFanState=>{
        assertTarget(signal);
        this.applyStatus(status);this.flushStatus();
        return{target:target.object,percent:Math.round(speed*100),confirmedAt:Date.now()};
      };
      if(confirmed(before.speed))return accept(before.status,before.speed);
      assertTarget(signal);
      checkedFanPayload(await this.rpc('printer.gcode.script',{script:printerFanCommand(target,p)},{timeoutMs:5000}));
      assertTarget(signal);
      let reported:number|undefined;
      for(let attempt=0;attempt<3;attempt++){
        if(attempt)await new Promise<void>(resolve=>window.setTimeout(resolve,250));
        assertTarget(signal);
        try{
          const observed=await read();
          if(observed.speed!==undefined){reported=observed.speed;if(confirmed(observed.speed))return accept(observed.status,observed.speed)}
        }catch(error){
          assertTarget(signal);
          if(this.authorizationError(error)||String(error instanceof Error?error.message:error).startsWith('Вентилятор:'))throw error;
          if(attempt===2&&reported===undefined)throw error;
        }
      }
      throw new Error(reported===undefined
        ?'Состояние вентилятора после команды не получено. Проверьте принтер перед повтором.'
        :`Принтер не подтвердил ${p}% вентилятора: получено ${Math.round(reported*100)}%. Команда повторно не отправлялась.`);
    },'control.fan');
  }
  setSpeed(percent:number){ return this.gcode(`M220 S${Math.max(10,Math.min(300,Math.round(percent)))}`); }
  home(axis:'ALL'|'X'|'Y'|'Z'='ALL'){ return this.gcode(axis==='ALL'?'G28':`G28 ${axis}`); }
  jog(axis:'X'|'Y'|'Z',distance:number,speed=3000){ return this.gcode(`G91\nG0 ${axis}${distance} F${speed}\nG90`); }
  extrude(distance:number,speed=300){ return this.gcode(`M83\nG1 E${distance} F${speed}`); }
  runMacro(name:string){ return this.gcode(name); }
  serviceCommand(script:string){if(this.lastState==='printing'||this.lastState==='paused')return Promise.reject(new Error('Сервисная команда заблокирована во время печати'));try{assertModelDependentOperationAllowed(this.config)}catch(error){return Promise.reject(error)}return this.gcode(script)}
  private async crealityLight(on:boolean|null):Promise<PrinterLightState>{
    const observed=await secureInvoke<boolean>('creality_light',{printerId:this.config.id,host:this.config.host,on});
    if(typeof observed!=='boolean')throw new Error('Creality не передала состояние подсветки');
    if(on!==null&&observed!==on)throw new Error('Creality не подтвердила переключение подсветки');
    return {supported:true,on:observed,target:'Creality LAN · 9999'};
  }
  async lightStatus():Promise<PrinterLightState>{
    let objects:string[]=[],discoveryError:unknown,configStatus:Record<string,any>={};
    try{objects=await this.objectList()}catch(error){discoveryError=error}
    let target=discoverPrinterLight(objects);
    // Some vendor catalogs omit outputs. Read the live configuration as a
    // second source; never infer an actuator from arbitrary pins or fan names.
    if(!target){
      try{
        configStatus=await this.runBackgroundRequest(async()=>moonrakerStatus(await this.rpc('printer.objects.query',{objects:{configfile:['settings','config']}})),'background.light.config');
        const sections={...configStatus.configfile?.config,...configStatus.configfile?.settings};
        const names=Object.keys(sections).filter(name=>sections[name]?.static_value===undefined);
        target=discoverPrinterLight(names);
      }catch(error){discoveryError=error}
    }
    // Stock K1 firmware can drive its light outside Klipper. Only an actual
    // lightSw reply proves native light support; never invent output_pin LED.
    const k1=this.prefersK1CCompatibilityMode()||this.config.profile?.preset==='creality-k1-max';
    if(!target&&k1){
      try{const state=await this.runBackgroundRequest(()=>this.crealityLight(null),'background.light.creality');this.lightTarget={kind:'creality'};return state}
      catch(error){this.lightTarget=undefined;if(this.authorizationError(error))throw error;return {supported:false,detail:'Штатный канал подсветки Creality недоступен: '+String(error instanceof Error?error.message:error).slice(0,180)}}
    }
    this.lightTarget=target;
    if(!target){
      if(discoveryError)throw discoveryError;
      return {supported:false,detail:'Выход подсветки не найден. Повторите определение после подключения принтера.'};
    }
    if(Object.keys(configStatus).length)printerLightState(target,configStatus);
    try{return await this.readLightStatus(objects.includes('configfile'))}
    catch(error){
      if(this.authorizationError(error))throw error;
      return {supported:true,target:target.kind==='macro'?target.onCommand:target.kind==='creality'?'Creality LAN · 9999':target.object,detail:'Состояние подсветки не подтверждено. '+String(error instanceof Error?error.message:error).slice(0,180)};
    }
  }
  private lightPayload(value:any){
    const rows=[value];
    for(let i=0;i<rows.length&&i<12;i++){
      const row=rows[i];if(!row||typeof row!=='object')continue;
      if(row.error!==undefined&&row.error!==null){const error=row.error;throw new Error('Подсветка: '+String(typeof error==='string'?error:error.message??JSON.stringify(error)).slice(0,300))}
      for(const key of ['result','data','response'])if(row[key]&&typeof row[key]==='object')rows.push(row[key]);
    }
    return value;
  }
  private async lightGet(path:string){
    const response=await this.nativeHttp('GET',path,2500);
    return this.lightPayload(JSON.parse(new TextDecoder().decode(Uint8Array.from(response.body))));
  }
  private async readLightStatus(includeConfig=false):Promise<PrinterLightState>{
    const target=this.lightTarget;
    if(!target)return {supported:false};
    if(target.kind==='creality')return this.runBackgroundRequest(()=>this.crealityLight(null),'background.light.creality');
    if(target.kind==='macro')return {supported:true,target:`${target.onCommand} / ${target.offCommand}`,detail:'Макросы не сообщают состояние подсветки.'};
    return this.runBackgroundRequest(async()=>{
      const objects:Record<string,string[]|null>={[target.object]:null};if(includeConfig)objects.configfile=['settings'];
      let state:PrinterLightState|undefined;
      try{state=printerLightState(target,moonrakerStatus(this.lightPayload(await this.rpc('printer.objects.query',{objects},{timeoutMs:2500}))))}
      catch(error){if(this.authorizationError(error))throw error}
      // Read-only fallback for firmware omitting outputs in RPC snapshots.
      if(state?.on===undefined){
        const query=encodeURIComponent(target.object)+(includeConfig?'&configfile=settings':'');
        state=printerLightState(target,moonrakerStatus(await this.lightGet('/printer/objects/query?'+query)));
      }
      return {...state,target:target.object,...(state.on===undefined?{detail:'Принтер не сообщает состояние подсветки.'}:{})};
    },'background.light');
  }

  async light(on:boolean,assertApplicable?:()=>void):Promise<PrinterLightState>{
    assertApplicable?.();
    if(!this.lightTarget)await this.lightStatus();
    assertApplicable?.();
    const target=this.lightTarget;
    if(!target)throw new Error('У принтера не найден управляемый выход подсветки');
    if(target.kind==='creality')return this.runControlRequest(()=>{assertApplicable?.();return this.crealityLight(on)},'control.light.creality');
    this.lightPayload(await this.runControlRequest(()=>{assertApplicable?.();return this.rpc('printer.gcode.script',{script:printerLightCommand(target,on)})},'control.light'));
    if(target.kind==='macro')return {...await this.readLightStatus(),detail:'Состояние после команды макроса не подтверждено.'};
    // The UI follows the printer response, never an optimistic local toggle.
    let reported=false;
    for(let attempt=0;attempt<3;attempt++){
      await new Promise(resolve=>window.setTimeout(resolve,250));
      let state:PrinterLightState;
      try{state=await this.readLightStatus()}catch(error){if(this.authorizationError(error))throw error;continue}
      if(state.on!==undefined)reported=true;
      if(state.on===on)return state;
    }
    if(!reported)throw new Error('LIGHT_STATE_UNCONFIRMED: состояние после команды не получено. Переключение подсветки не подтверждено.');
    throw new Error('Принтер не подтвердил переключение подсветки. Проверьте консоль принтера.');
  }

  async objectList(signal?:AbortSignal):Promise<string[]>{ return await this.runBackgroundRequest(async()=>moonrakerObjectNames(await this.rpc('printer.objects.list')),'background.objects',signal); }
  async macros(signal?:AbortSignal):Promise<string[]>{ const objects=await this.objectList(signal); return objects.filter(x=>x.startsWith('gcode_macro ')).map(x=>x.substring(12)).sort(); }

  private async nativeHttp(method:'GET'|'DELETE',path:string,timeoutMs?:number){
    this.assertAddressIdentityAllowed();
    const response=await secureInvoke<NativeHttpResponse>('moonraker_http',{printerId:this.config.id,host:this.moonrakerEndpoint(),method,path,timeoutMs:timeoutMs??null,defaultPort:this.moonrakerDefaultPort()});
    if(response.status<200||response.status>=300)throw new Error(`${path} HTTP ${response.status}`);
    return response;
  }

  private async getJson(path:string){
    const response=await this.nativeHttp('GET',path,this.prefersK1CCompatibilityMode()?6000:undefined);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(response.body)));
  }

  private trackBackgroundRequest<T>(promise:Promise<T>){
    this.backgroundInFlight.add(promise);
    void promise.finally(()=>this.backgroundInFlight.delete(promise)).catch(()=>{});
    return promise;
  }

  private async runBackgroundRequest<T>(worker:(signal:AbortSignal)=>Promise<T>,label='background.request',signal?:AbortSignal){
    const task=this.requestScheduler.run('background',label,worker,{signal});
    return await this.trackBackgroundRequest(task);
  }

  private async settleRequests(workers:Array<()=>Promise<any>>,limit=2){
    const results=new Array<PromiseSettledResult<any>>(workers.length);let cursor=0;
    await Promise.all(Array.from({length:Math.min(Math.max(1,limit),workers.length)},async()=>{
      while(cursor<workers.length){
        const index=cursor++;
        try{results[index]={status:'fulfilled',value:await workers[index]()}}
        catch(reason){results[index]={status:'rejected',reason}}
      }
    }));
    return results;
  }

  private async runControlRequest<T>(worker:(signal:AbortSignal)=>Promise<T>,label='control.request'):Promise<T>{
    this.assertAddressIdentityAllowed();
    if(this.pollTimer)window.clearTimeout(this.pollTimer);
    this.pollTimer=undefined;
    try{return await this.requestScheduler.run('control',label,active=>{this.assertAddressIdentityAllowed();return worker(active)})}
    finally{
      if(this.connectionActive(this.connectionEpoch))this.schedulePoll(500);
    }
  }

  async runFileTransfer<T>(worker:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal,label='upload.transfer'):Promise<T>{
    this.assertAddressIdentityAllowed();
    if(!this.backgroundFileWorkAllowed())throw new Error('Forge-X: передача G-code отложена до завершения печати');
    if(this.pollTimer)window.clearTimeout(this.pollTimer);
    this.pollTimer=undefined;
    try{return await this.requestScheduler.run('upload',label,active=>{this.assertAddressIdentityAllowed();return worker(active)},{signal})}
    finally{
      if(this.connectionActive(this.connectionEpoch))this.schedulePoll(750);
    }
  }


  async uploadLocalLibrary(relativePath:string,expectedSha256:string,libraryId:string,onProgress?:(progress:LocalTransferProgress)=>void,signal?:AbortSignal){
    const printerId=this.config.id,savedHost=this.config.host;
    return await this.runFileTransfer(async active=>{
      if(active.aborted)throw new RequestCancelledError();
      if(this.config.id!==printerId||this.config.host!==savedHost)throw new Error('Принтер или адрес изменились до отправки файла. Проверьте файл заново');
      // Resolve the route when the queued transfer actually starts: the actor
      // may have recovered on another supported port while it was waiting.
      const host=this.moonrakerEndpoint(),defaultPort=this.moonrakerDefaultPort();
      onProgress?.({phase:'sending',done:0,total:0});
      try{
        // Use the R94 native local-library route: it verifies a private source
        // snapshot against preflight and streams that snapshot to Moonraker.
        // Its in-flight native call cannot be cancelled. Keep the request
        // occupied until it settles, then prevent any follow-up print/queue.
        const path=await localLibraryUploadToPrinter(relativePath,expectedSha256,libraryId,printerId,host,defaultPort);
        this.invalidateFileCaches(path);
        this.uploadedHashes.set(path,expectedSha256);
        while(this.uploadedHashes.size>32)this.uploadedHashes.delete(this.uploadedHashes.keys().next().value as string);
        if(active.aborted)throw new RequestCancelledError();
        return path;
      }catch(error){
        if(active.aborted)throw new RequestCancelledError();
        diagnosticWarning('upload.local_library',error,{printerId,operation:'upload.local_library'});
        throw error;
      }
    },signal,'upload.local_library');
  }

  async temperatureStore(includeMonitors=true):Promise<TemperatureStore>{
    if(!this.backgroundFileWorkAllowed())throw new Error('Forge-X: история температур отложена до завершения печати');
    if(this.temperatureStoreInFlight)return this.temperatureStoreInFlight;
    const task=this.runBackgroundRequest(async()=>{
      const j=await this.getJson(`/server/temperature_store?include_monitors=${includeMonitors?'true':'false'}`);
      return j.result ?? j;
    });
    this.temperatureStoreInFlight=task;
    void task.finally(()=>{if(this.temperatureStoreInFlight===task)this.temperatureStoreInFlight=undefined}).catch(()=>{});
    return task;
  }
  resolveUrl(value?:string){
    if(!value)return undefined;
    try{
      const host=this.config.host.trim().replace(/^http:\/\//i,'').replace(/\/$/,'');
      const base=new URL(`http://${host}`),url=new URL(value,`${base.origin}/`);
      if(url.protocol!=='http:'||url.hostname!==base.hostname||url.username||url.password)return undefined;
      return url.toString();
    }catch{return undefined}
  }
  /** Fresh, read-only preflight used immediately before a confirmed local launch. */
  async checkIdleReady(){
    return this.runControlRequest(async()=>{
      const printer=moonrakerRecord(await this.rpc('printer.info'));
      if(printer?.state!=='ready')return false;
      const status=moonrakerStatus(await this.rpc('printer.objects.query',{objects:{print_stats:['state'],virtual_sdcard:['is_active']}}));
      return ['standby','complete','cancelled','ready'].includes(String(status.print_stats?.state??'').toLowerCase())&&status.virtual_sdcard?.is_active!==true;
    },'control.preflight');
  }

  async isReady(){
    try{
      return await this.runBackgroundRequest(async()=>{
        const printer=moonrakerRecord(await this.rpc('printer.info'));
        if(printer?.state!=='ready')return false;
        const status=moonrakerStatus(await this.rpc('printer.objects.query',{objects:{print_stats:['state'],virtual_sdcard:['is_active']}}));
        const printState=String(status.print_stats?.state??'').toLowerCase();
        return printState!=='printing'&&printState!=='paused'&&status.virtual_sdcard?.is_active!==true;
      });
    }catch(error){diagnosticWarning('moonraker.ready_check',error,{printerId:this.config.id,operation:'control.preflight'});return false}
  }

  async detect():Promise<PrinterDetection>{
    if(this.detectionInFlight)return this.detectionInFlight;
    const task=this.runBackgroundRequest(()=>this.detectOnce());
    this.detectionInFlight=task;
    try{return await task}
    finally{if(this.detectionInFlight===task)this.detectionInFlight=undefined}
  }

  private async detectOnce():Promise<PrinterDetection>{
    const started=performance.now();
    const probeNames=['server.info','printer.info','machine.system_info','printer.objects.list','configfile.settings','toolhead.geometry'] as const;
    const detectionOptions:NativeRpcOptions={timeoutMs:3000,...(this.prefersK1CCompatibilityMode()?{defaultPort:this.moonrakerDefaultPort()}: {})};
    const probeWorkers=(options:NativeRpcOptions)=>[
      ()=>this.nativeRpc('server.info',undefined,options),
      ()=>this.nativeRpc('printer.info',undefined,options),
      ()=>this.nativeRpc('machine.system_info',undefined,options),
      ()=>this.nativeRpc('printer.objects.list',undefined,options),
      ()=>this.nativeRpc('printer.objects.query',{objects:{configfile:['settings']}},options),
      ()=>this.nativeRpc('printer.objects.query',{objects:{toolhead:['axis_minimum','axis_maximum']}},options)
    ];
    // Identification is intentionally sequential per printer. Discovery has
    // already rendered the row, so parallel background RPCs buy little time
    // but can overwhelm small vendor Moonraker builds during an active scan.
    let probes=await this.settleRequests(probeWorkers(detectionOptions),1);
    if(probes.every(item=>item.status==='rejected')){
      const configured=this.configuredMoonrakerPort();
      const ports:MoonrakerDefaultPort[]=configured===80?[80,7125]:configured===7125?[7125,80]:[80,7125];
      for(const defaultPort of ports){
        let server:any;
        try{server=await this.nativeWsRpc('server.info',undefined,{timeoutMs:2500,defaultPort})}
        catch(error){diagnosticWarning('moonraker.detect.websocket',error,{printerId:this.config.id,operation:`detect.ws:${defaultPort}`});continue}
        const remaining=await this.settleRequests([
          ()=>this.nativeWsRpc('printer.info',undefined,{timeoutMs:2500,defaultPort}),
          ()=>this.nativeWsRpc('machine.system_info',undefined,{timeoutMs:2500,defaultPort}),
          ()=>this.nativeWsRpc('printer.objects.list',undefined,{timeoutMs:2500,defaultPort}),
          ()=>this.nativeWsRpc('printer.objects.query',{objects:{configfile:['settings']}},{timeoutMs:2500,defaultPort}),
          ()=>this.nativeWsRpc('printer.objects.query',{objects:{toolhead:['axis_minimum','axis_maximum']}},{timeoutMs:2500,defaultPort}),
        ],1);
        probes=[{status:'fulfilled',value:server},...remaining];
        if(probes.some(item=>item.status==='fulfilled'))break;
      }
    }
    // Discovery already proved the endpoint. If a fast WebSocket pass omitted
    // model-defining facts, retry only those probes through REST. Vendor forks
    // often expose configfile reliably on one channel but not the other.
    if(probes.some(item=>item.status==='fulfilled')&&probes.some(item=>item.status==='rejected')){
      const missingIndexes=probes.flatMap((item,index)=>item.status==='rejected'?[index]:[]);
      const repairWorkers=probeWorkers({...detectionOptions,preferRest:true,timeoutMs:5000});
      const repaired=await this.settleRequests(missingIndexes.map(index=>repairWorkers[index]),1);
      missingIndexes.forEach((index,repairIndex)=>{
        if(repaired[repairIndex]?.status==='fulfilled')probes[index]=repaired[repairIndex];
      });
    }
    const value=(index:number)=>probes[index].status==='fulfilled'?(probes[index] as PromiseFulfilledResult<any>).value:{};
    const server=moonrakerRecord(value(0)),printer=moonrakerRecord(value(1)),machine=moonrakerRecord(value(2));
    const listed={objects:moonrakerObjectNames(value(3))},configStatus=moonrakerRecord(value(4)),toolheadStatus=moonrakerRecord(value(5));
    const available=probeNames.filter((_,index)=>probes[index].status==='fulfilled');
    const missing=probeNames.filter((_,index)=>probes[index].status==='rejected');
    const probeWarnings=missing.map(name=>`${name} недоступен`);
    if(!available.length){
      const errors=probes.map(item=>item.status==='rejected'?String(item.reason instanceof Error?item.reason.message:item.reason):'').filter(Boolean);
      throw new Error(errors[0]||'Moonraker не ответил ни на один безопасный диагностический запрос');
    }
    const currentFacts=printerDetectionFactsFromMoonraker({server,printer,machine,listed,configStatus,toolheadStatus});
    const facts=mergePrinterDetectionFacts(currentFacts,this.config.configSnapshot?.facts);
    const deviceIdentity=printerDeviceIdentity(facts);
    const hostname=facts.identity?.hostname;
    const objects=facts.objectNames??[];
    const classified=classifyPrinterModel(facts);
    const detectedName=classified.model==='custom'?(hostname?`Klipper · ${hostname}`:'Klipper Printer'):printerPresetDisplayName(classified.model);
    const klippyState=String(server?.klippy_state??printer?.state??'unknown');
    return {...classified,reachable:true,ready:normalizeKlippyState(klippyState)==='ready',name:detectedName,klippyState,moonrakerVersion:boundedText(server?.moonraker_version),hostname,objectCount:objects.length,latency:Math.round(performance.now()-started),probeWarnings,probeCoverage:{successful:available.length,total:probeNames.length,available:[...available],missing:[...missing]},facts,deviceIdentity};
  }

  async webcams(signal?:AbortSignal):Promise<Webcam[]>{ const j=await this.runBackgroundRequest(()=>this.getJson('/server/webcams/list'),'background.webcams',signal); return j.result?.webcams ?? j.webcams ?? j.result ?? []; }
  async fileEntries():Promise<GCodeFileEntry[]>{
    if(!this.backgroundFileWorkAllowed())throw new Error('Forge-X: синхронизация файлов отложена до завершения печати');
    if(this.fileEntriesInFlight)return this.fileEntriesInFlight;
    const task=this.runBackgroundRequest(signal=>readGCodeFileEntries({
      list:()=>this.rpc('server.files.list',{root:'gcodes'},{timeoutMs:6000}),
      directory:path=>this.getJson(`/server/files/directory?path=${encodeURIComponent(path)}&extended=false`),
      signal,
    }),'background.files');
    this.fileEntriesInFlight=task;
    void task.finally(()=>{if(this.fileEntriesInFlight===task)this.fileEntriesInFlight=undefined}).catch(()=>{});
    return task;
  }
  async files():Promise<string[]>{ return (await this.fileEntries()).map(item=>item.path); }
  async deleteFile(filename:string){return await this.runFileTransfer(async()=>{const r=await this.nativeHttp('DELETE',`/server/files/gcodes/${filename.split('/').map(encodeURIComponent).join('/')}`);this.invalidateFileCaches(filename);this.uploadedHashes.delete(filename);this.uploadedFiles.delete(filename);return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.body)))})}
  async history(limit=25,signal?:AbortSignal):Promise<HistoryJob[]>{ const j=await this.runBackgroundRequest(()=>this.getJson(`/server/history/list?limit=${limit}&order=desc`),'background.history',signal); return j.result?.jobs ?? j.jobs ?? []; }
  /** History counters are reported millimetres; count is the page length, not the total history size. */
  async historyPage({limit=100,start=0,since,order='desc',signal}:MoonrakerHistoryPageOptions={}):Promise<MoonrakerHistoryPage>{
    if(!Number.isInteger(limit)||limit<1||limit>250||!Number.isInteger(start)||start<0||start>1_000_000)throw new Error('Некорректная страница истории печати');
    if(since!==undefined&&(!Number.isFinite(since)||since<0))throw new Error('Некорректное начало истории печати');
    if(order!=='asc'&&order!=='desc')throw new Error('Некорректный порядок истории печати');
    const query=new URLSearchParams({limit:String(limit),start:String(start),order});
    if(since!==undefined)query.set('since',String(since));
    const response=await this.runBackgroundRequest(()=>this.getJson(`/server/history/list?${query}`),'background.filament_history',signal);
    const page=response.result??response;
    if(!page||!Array.isArray(page.jobs)||page.jobs.length>limit)throw new Error('Moonraker вернул некорректную страницу истории печати');
    return{jobs:page.jobs,count:page.jobs.length};
  }


  /** Read one retained history entry without widening the normal reconciliation window. */
  async historyJob(jobId:string,signal?:AbortSignal):Promise<HistoryJob>{
    if(typeof jobId!=='string'||!jobId.trim()||jobId.trim()!==jobId||jobId.length>160)throw new Error('Некорректный идентификатор истории печати');
    const query=new URLSearchParams({uid:jobId});
    const response=await this.runBackgroundRequest(()=>this.getJson(`/server/history/job?${query}`),'background.filament_history',signal);
    const job=(response.result??response)?.job;
    if(!job||Array.isArray(job)||typeof job!=='object'||job.job_id!==jobId)throw new Error('Moonraker вернул другое задание истории печати');
    return job;
  }

  async metadata(filename:string,signal?:AbortSignal):Promise<GCodeMetadata>{
    if(!this.backgroundFileWorkAllowed())throw new Error('Forge-X: чтение метаданных отложено до завершения печати');
    if(signal)return this.runBackgroundRequest(async()=>{const j=await this.getJson(`/server/files/metadata?filename=${encodeURIComponent(filename)}`);return j.result ?? j},'background.metadata',signal);
    const now=Date.now(),cached=this.metadataCache.get(filename);
    if(cached&&cached.expires>now)return cached.promise;
    if(cached)this.metadataCache.delete(filename);
    const promise=this.runBackgroundRequest(async()=>{const j=await this.getJson(`/server/files/metadata?filename=${encodeURIComponent(filename)}`);return j.result ?? j});
    this.metadataCache.set(filename,{promise,expires:now+5000});
    promise.catch(()=>{if(this.metadataCache.get(filename)?.promise===promise)this.metadataCache.delete(filename)});
    while(this.metadataCache.size>128)this.metadataCache.delete(this.metadataCache.keys().next().value as string);
    return promise;
  }
  async gcodeText(filename:string,signal?:AbortSignal){
    if(!this.backgroundFileWorkAllowed())throw new Error('Forge-X: чтение полного G-code отложено до завершения печати');
    const fetchText=()=>this.runBackgroundRequest(()=>this.nativeHttp('GET',`/server/files/gcodes/${filename.split('/').map(encodeURIComponent).join('/')}`).then(r=>new TextDecoder().decode(Uint8Array.from(r.body))),'background.gcode_text',signal);
    if(signal)return await fetchText();
    const now=Date.now(),cached=this.gcodeTextCache.get(filename);
    if(cached&&cached.expires>now)return cached.promise;
    if(cached)this.gcodeTextCache.delete(filename);
    const promise=fetchText();
    this.gcodeTextCache.set(filename,{promise,expires:now+5000});
    while(this.gcodeTextCache.size>4)this.gcodeTextCache.delete(this.gcodeTextCache.keys().next().value as string);
    window.setTimeout(()=>{const current=this.gcodeTextCache.get(filename);if(current?.promise===promise)this.gcodeTextCache.delete(filename)},5200);
    promise.catch(()=>{const current=this.gcodeTextCache.get(filename);if(current?.promise===promise)this.gcodeTextCache.delete(filename)});
    return promise;
  }
  async diagnostics(){const started=performance.now(),probes=await this.runBackgroundRequest(()=>this.settleRequests([()=>this.rpc('server.info'),()=>this.rpc('printer.info')],this.prefersConservativeBackgroundMode()?1:2));const value=(index:number)=>probes[index].status==='fulfilled'?(probes[index] as PromiseFulfilledResult<any>).value:undefined;if(!value(0)&&!value(1)){const rejected=probes.find(item=>item.status==='rejected') as PromiseRejectedResult|undefined;throw new Error(String(rejected?.reason instanceof Error?rejected.reason.message:rejected?.reason??'Moonraker не отвечает'))}return{latency:Math.round(performance.now()-started),server:value(0),printer:value(1),transport:this.prefersK1CCompatibilityMode()?this.k1cConnectionMessage():this.transport,sensors:this.sensorObjects,warnings:['server.info','printer.info'].filter((_,index)=>probes[index].status==='rejected')}}
  reliabilitySnapshot():PrinterReliabilitySnapshot{
    return{
      scheduler:this.requestScheduler.snapshot(),
      recovery:this.recovery.snapshot(),
      channelHealth:this.channelHealth.snapshot(),
      activePort:this.moonrakerDefaultPort(),
      activeProtocol:this.prefersK1CCompatibilityMode()?this.k1cTelemetryTransport.protocol:'http',
      endpoint:this.config.host,
    };
  }
  async healthCheck(signal?:AbortSignal){
    const started=performance.now(),names=['server.info','printer.info','objects.list','configfile','webcams'];
    const probes=await this.runBackgroundRequest(()=>this.settleRequests([
      ()=>this.rpc('server.info'),
      ()=>this.rpc('printer.info'),
      ()=>this.rpc('printer.objects.list'),
      ()=>this.rpc('printer.objects.query',{objects:{configfile:null}}),
      ()=>this.getJson('/server/webcams/list').then(j=>j.result?.webcams??j.webcams??j.result??[]),
    ],this.prefersConservativeBackgroundMode()?1:2),'background.health_check',signal);
    const value=(index:number)=>probes[index].status==='fulfilled'?(probes[index] as PromiseFulfilledResult<any>).value:undefined;
    const available=names.filter((_,index)=>probes[index].status==='fulfilled'),missing=names.filter((_,index)=>probes[index].status==='rejected');
    if(!available.length){
      const first=probes.find(item=>item.status==='rejected') as PromiseRejectedResult|undefined;
      throw new Error(String(first?.reason instanceof Error?first.reason.message:first?.reason??'Moonraker не отвечает'));
    }
    const server=moonrakerRecord(value(0)),printer=moonrakerRecord(value(1)),config=moonrakerRecord(value(3)),webcams=value(4)??[];
    const objects=moonrakerObjectNames(value(2));
    const klippyState=normalizeKlippyState(server?.klippy_state??printer?.state);
    return{latency:Math.round(performance.now()-started),transport:this.transport,klippyState,klippyReady:klippyState==='ready',hasMcu:objects.includes('mcu'),hasExtruder:objects.includes('extruder'),hasBed:objects.includes('heater_bed'),hasConfig:!!(config?.status?.configfile??config?.configfile),webcamCount:Array.isArray(webcams)?webcams.filter((item:Webcam)=>item.enabled).length:0,objectCount:objects.length,probeCoverage:{successful:available.length,total:names.length},probeWarnings:missing.map(name=>`${name} недоступен`),reliability:this.reliabilitySnapshot()}}
  async thumbnails(filename:string,signal?:AbortSignal):Promise<GCodeThumbnail[]>{
    if(!this.backgroundFileWorkAllowed())return [];
    const j=await this.runBackgroundRequest(()=>this.getJson(`/server/files/thumbnails?filename=${encodeURIComponent(filename)}`),'background.thumbnails',signal);
    const rows=j.result?.thumbnails??j.result??j.thumbnails??j;
    return Array.isArray(rows)?rows:[];
  }
  private async withThumbnailSlot<T>(worker:()=>Promise<T>){
    const limit=this.prefersConservativeBackgroundMode()?1:4;
    if(this.thumbnailActive>=limit)await new Promise<void>(resolve=>this.thumbnailWaiters.push(resolve));
    this.thumbnailActive++;
    try{return await worker()}
    finally{this.thumbnailActive--;this.thumbnailWaiters.shift()?.()}
  }
  private invalidateFileCaches(filename?:string){
    if(!filename){this.thumbnailCache.clear();this.gcodeTextCache.clear();this.metadataCache.clear();return}
    this.gcodeTextCache.delete(filename);
    this.metadataCache.delete(filename);
    const prefix=`${filename}\u0000`;
    for(const key of this.thumbnailCache.keys())if(key.startsWith(prefix))this.thumbnailCache.delete(key);
  }
  private async loadThumbnailDataUrl(filename:string,metadata?:GCodeMetadata,options:ThumbnailReadOptions={}){
    if(options.signal?.aborted)throw new RequestCancelledError();
    if(!this.backgroundFileWorkAllowed())return undefined;
    const details=await this.thumbnails(filename,options.signal).catch(error=>{if(options.signal?.aborted)throw error;return []});
    if(options.signal?.aborted)throw new RequestCancelledError();
    const parent=safeGcodePath(filename)?.split('/').slice(0,-1).join('/')??'';
    const ranked=[...details.map(item=>({item,detail:true})),...(metadata?.thumbnails??[]).map(item=>({item,detail:false}))]
      .sort((left,right)=>(Number(right.item.width)||0)*(Number(right.item.height)||0)-(Number(left.item.width)||0)*(Number(left.item.height)||0));
    for(const {item} of ranked){
      if(item.data){const inline=dataUrlFromBase64Image(item.data);if(inline)return inline}
    }
    const paths:string[]=[];
    const add=(value:string|undefined,relativeToParent:boolean)=>{
      if(!value)return;
      const joined=relativeToParent&&parent?`${parent}/${value}`:value,normalized=safeGcodePath(joined);
      if(normalized&&!paths.includes(normalized))paths.push(normalized);
    };
    for(const {item,detail} of ranked){
      if(item.thumbnail_path){add(item.thumbnail_path,false);add(item.thumbnail_path,true)}
      if(item.relative_path){add(item.relative_path,!detail);add(item.relative_path,detail)}
    }
    for(const path of paths){
      if(options.signal?.aborted)throw new RequestCancelledError();
      const encoded=encodedGcodePath(path);
      if(!encoded)continue;
      try{
        const response=await this.runBackgroundRequest(()=>this.nativeHttp('GET',`/server/files/gcodes/${encoded}`),'background.thumbnail_image',options.signal);
        if(options.signal?.aborted)throw new RequestCancelledError();
        const dataUrl=dataUrlFromImageBytes(Uint8Array.from(response.body));
        if(dataUrl)return dataUrl;
      }catch(error){if(options.signal?.aborted)throw error;diagnosticWarning('moonraker.thumbnail.path',`${path}: ${String(error instanceof Error?error.message:error)}`,{printerId:this.config.id,operation:'thumbnail.load'})}
    }
    if(options.allowEmbeddedGcode===false)return undefined;
    if(!this.backgroundFileWorkAllowed())return undefined;
    try{return embeddedGCodeThumbnailDataUrl(await this.gcodeText(filename))}
    catch(error){diagnosticWarning('moonraker.thumbnail.embedded',error,{printerId:this.config.id,operation:'thumbnail.extract'});return undefined}
  }
  thumbnailDataUrl(filename:string,metadata?:GCodeMetadata,identity?:Pick<GCodeFileEntry,'size'|'modified'>,options:ThumbnailReadOptions={}){
    if(options.signal)return this.withThumbnailSlot(()=>this.loadThumbnailDataUrl(filename,metadata,options));
    const key=`${filename}\u0000${identity?.size??''}\u0000${identity?.modified??''}\u0000${JSON.stringify(metadata?.thumbnails??[])}${options.allowEmbeddedGcode===false?'\u0000thumbnail-only':''}`;
    const cached=this.thumbnailCache.get(key);
    if(cached)return cached;
    const generation=this.thumbnailGeneration;
    const promise=this.withThumbnailSlot(()=>generation===this.thumbnailGeneration&&this.backgroundFileWorkAllowed()?this.loadThumbnailDataUrl(filename,metadata,options):Promise.resolve(undefined));
    this.thumbnailCache.set(key,promise);
    promise.then(value=>{
      if(value)return;
      window.setTimeout(()=>{if(this.thumbnailCache.get(key)===promise)this.thumbnailCache.delete(key)},30_000);
    },()=>{if(this.thumbnailCache.get(key)===promise)this.thumbnailCache.delete(key)});
    while(this.thumbnailCache.size>192)this.thumbnailCache.delete(this.thumbnailCache.keys().next().value as string);
    return promise;
  }
  async queueStatus():Promise<QueueStatus>{
    if(!this.backgroundFileWorkAllowed())throw new Error('Forge-X: очередь будет обновлена после завершения печати');
    if(this.queueStatusInFlight)return this.queueStatusInFlight;
    const task=this.runBackgroundRequest(async()=>{const j=await this.getJson('/server/job_queue/status');return j.result ?? j});
    this.queueStatusInFlight=task;
    void task.finally(()=>{if(this.queueStatusInFlight===task)this.queueStatusInFlight=undefined}).catch(()=>{});
    return task;
  }
  enqueue(filenames:string[],reset=false){ return this.runControlRequest(()=>this.rpc('server.job_queue.post_job',{filenames,reset})); }
  queueStart(){ return this.runControlRequest(()=>this.rpc('server.job_queue.start')); }
  queuePause(){ return this.runControlRequest(()=>this.rpc('server.job_queue.pause')); }
  queueRemove(job_ids:string[]){ return this.runControlRequest(()=>this.rpc('server.job_queue.delete_job',{job_ids})); }


  async spoolmanStatus(){ return await this.runBackgroundRequest(async()=>{const j=await this.getJson('/server/spoolman/status');return j.result??j}); }
  setActiveSpool(spool_id:number|null){ return this.runControlRequest(()=>this.rpc('server.spoolman.post_spool_id',{spool_id})); }
  async spoolmanSpools(){
    const r=await this.runBackgroundRequest(()=>this.rpc('server.spoolman.proxy',{use_v2_response:true,request_method:'GET',path:'/v1/spool',query:'allow_archived=false',body:null}));
    if(r?.error) throw new Error(r.error.message||'Spoolman error');
    return r?.response ?? [];
  }

  async snapshot(url:string){return await this.runBackgroundRequest(()=>secureInvoke<NativeHttpResponse>('moonraker_snapshot',{printerId:this.config.id,host:this.moonrakerEndpoint(),url}))}

  async upload(file:File,onProgress?:(percent:number)=>void,externalSignal?:AbortSignal):Promise<string>{
    if(file.size>100*1024*1024)throw new Error('G-code превышает лимит 100 MiB');
    if(file.size===0)throw new Error('G-code пуст');
    if(this.uploadInFlight)throw new Error('На этот принтер уже загружается G-code');
    if(externalSignal?.aborted)throw new RequestCancelledError('Загрузка отменена');
    const controller=new AbortController();
    const externalAbort=()=>controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort',externalAbort,{once:true});
    this.uploadController=controller;
    const task=this.runFileTransfer(async signal=>{
      const ensureActive=()=>{if(signal.aborted)throw new RequestCancelledError('Загрузка отменена пользователем')};
      ensureActive();
      onProgress?.(1);
      const expectedSha256=await blobSha256(file);
      ensureActive();
      onProgress?.(3);
      const started=await secureInvoke<NativeUploadBegin>('transactional_upload_begin',{
        ...this.uploadTarget(),
        filename:file.name,
        fileSize:file.size,
        expectedSha256,
      });
      this.activeUploadId=started.uploadId;
      if(started.completedPath){
        this.uploadedHashes.set(started.completedPath,expectedSha256);
        this.uploadedFiles.set(started.completedPath,file);
        this.activeUploadId=undefined;
        onProgress?.(100);
        return started.completedPath;
      }
      const chunkSize=Math.max(64*1024,Math.min(512*1024,Math.trunc(started.chunkSize)||512*1024));
      let offset=Math.max(0,Math.min(file.size,Math.trunc(started.receivedSize)||0)),finished=false;
      if(offset>0)onProgress?.(Math.max(3,Math.min(94,Math.round(offset/file.size*91)+3)));
      try{
        while(offset<file.size){
          ensureActive();
          const end=Math.min(file.size,offset+chunkSize);
          const data=Array.from(new Uint8Array(await file.slice(offset,end).arrayBuffer()));
          ensureActive();
          const received=await secureInvoke<number>('transactional_upload_chunk',{uploadId:started.uploadId,offset,data});
          if(received!==end)throw new Error('Staging-журнал подтвердил неверный размер блока G-code');
          offset=end;
          onProgress?.(Math.max(3,Math.min(94,Math.round(offset/file.size*91)+3)));
        }
        ensureActive();
        onProgress?.(95);
        const result=await secureInvoke<NativeUploadFinish>('transactional_upload_finish',{uploadId:started.uploadId});
        finished=true;
        this.uploadedHashes.set(result.path,result.sha256);
        this.uploadedFiles.set(result.path,file);
        while(this.uploadedHashes.size>32)this.uploadedHashes.delete(this.uploadedHashes.keys().next().value as string);
        while(this.uploadedFiles.size>8)this.uploadedFiles.delete(this.uploadedFiles.keys().next().value as string);
        this.invalidateFileCaches(result.path);
        onProgress?.(100);
        return result.path;
      }finally{
        if(this.activeUploadId===started.uploadId)this.activeUploadId=undefined;
        // Transport errors preserve the staged file for resume. Only an
        // explicit user cancellation destroys the resumable transaction.
        if(!finished&&signal.aborted)await secureInvoke<boolean>('transactional_upload_abort',{uploadId:started.uploadId}).catch(error=>{diagnosticWarning('moonraker.upload.abort',error,{printerId:this.config.id,operation:'upload.abort'});return false});
      }
    },controller.signal,'upload.gcode');
    this.uploadInFlight=task;
    try{return await task}
    finally{
      externalSignal?.removeEventListener('abort',externalAbort);
      if(this.uploadInFlight===task)this.uploadInFlight=undefined;
      if(this.uploadController===controller)this.uploadController=undefined;
    }
  }
  cancelUpload(){if(!this.uploadController)return false;this.uploadController.abort('Загрузка отменена пользователем');return true}
  uploadActive(){return!!this.uploadController}
  uploadedSha256(filename:string){return this.uploadedHashes.get(filename)}
  uploadedFile(filename:string){return this.uploadedFiles.get(filename)}
}
