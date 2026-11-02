import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, Bot, CheckCircle2, Factory, Gauge, LayoutDashboard, ListOrdered, Minus, MonitorUp, Moon, Package, Printer, Radar, Shield, Sun, Wrench, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PrintersPage } from './components/PrintersPage';
import { deferredPanel } from './components/DeferredPanel';
import { CameraGuardHost } from './components/CameraGuardHost';
import { useCameraGuard } from './lib/cameraGuardRuntime';
import { MoonrakerClient } from './lib/moonraker';
import type { DiscoveredPrinter, DiscoveryResult, NetworkEnvironmentSnapshot, PrintRecord, PrinterConfig, PrinterModel, PrinterProfile, PrinterStatus, ScheduledJob, Spool } from './types';
import { dbGet, dbSet, migrateLocal, audit } from './lib/db';
import { headlessEngineStatus, nativeNotify, printerActorRemove, secretDelete, secretSet, snapshotStore, type HeadlessEngineStatus } from './lib/native';
import { SetupWizard } from './components/SetupWizard';
import { useMaintenance } from './lib/maintenanceRuntime';
import { useFilamentAccounting } from './lib/useFilamentAccounting';
import { usePrintNearEndNotifications } from './lib/usePrintNearEndNotifications';
import { trySpeakNeuralAnnouncement } from './lib/neuralSpeech';
import { voiceEventSpeechPreferences, voiceEventSpeechText } from './lib/voiceEventSpeech';
import { FleetDashboard } from './components/FleetDashboard';
import { VoiceAssistantPanel } from './components/VoiceAssistantPanel';
import { NotificationToastHost } from './components/NotificationToastHost';
import { showAppNotification } from './lib/appNotifications';
import { installNotificationSound, playNotificationSound } from './lib/notificationSound';
import { observePrinterVisualActivity, publishPrinterVisualCompletion } from './lib/printerVisualActivity';
import { ConnectionNoticeTracker } from './lib/connectionFeedback';
import { PrinterFaultNoticeTracker } from './lib/printerFault';
import { NotificationCenter } from './components/NotificationCenter';
import { DiscoveryPanel, type IdentifiedDiscoveredPrinter } from './components/DiscoveryPanel';
import { telegramSend, telegramSettings } from './lib/telegram';
import brandMark from './assets/brand-mark-v1144.svg';
import { normalizePrinterModelDisplayName, uniquePrinterName } from './lib/printerName';
import { iconForPreset, profileForPreset } from './lib/printerProfile';
import { FLASHFORGE_5M_DISPLAY_NAME, PRINTER_DETECTION_ENGINE_VERSION, printerDetectionFactsFromMoonraker } from './lib/printerDetection';
import { printerAddressKey, printerHostDisplay, samePrinterEndpoint } from './lib/printerEndpoint';
import { hasStrongPrinterIdentity, planPrinterAddressRecovery, printerAddressConfigurationKey, strongPrinterIdentityMatch, type PrinterAddressObservation } from './lib/printerAddressRecovery';
import { printerIsReachable } from './lib/printerHealth';
import { printerBlocksUpdate } from './lib/printerTelemetry';
import { printerHasActiveJob, printerCompletionNotificationAllowed } from './lib/printerJob';
import { printStartOptionsFromValidation, validateGCode } from './lib/gcodeValidation';
import { getAuthStatus, logout, secureInvoke, setAuthSession, type AuthSession } from './lib/auth';
import { browserInternetAvailable, offlineFirstStatus, subscribeInternetAvailability } from './lib/offlineFirst';
import { LoginPanel } from './components/LoginPanel';
import { applyModelDetection, type CompleteDetection } from './lib/modelSelection';
import { findPhysicalPrinter, printerDeviceIdentity, refreshDeviceIdentityEvidence, samePhysicalPrinter } from './lib/deviceIdentity';
import { appAlert, appConfirm } from './lib/appDialogs';
import { diagnosticError, diagnosticWarning } from './lib/diagnosticLog';
import { holdMonitoringActivity } from './lib/backgroundActivity';
import { catalogModelName, getCatalogModel } from './lib/printerCatalog';
import { applyCatalogModel, normalizeCatalogIdentity } from './lib/printerCatalogSelection';
import { createPrinterConfigStore, persistablePrinterConfigs } from './lib/printerConfigStore';
import './styles.css';

// Only view modules are deferred. Authentication, the first dashboard and
// printer page, monitoring, accounting and camera guard controllers stay ready.
const ControlPanel = deferredPanel(() => import('./components/ControlPanel').then(module => ({ default: module.ControlPanel })), { title: 'Принтер' });
const CameraModal = deferredPanel(() => import('./components/CameraModal').then(module => ({ default: module.CameraModal })), { title: 'Камера' });
const QueuePanel = deferredPanel(() => import('./components/QueuePanel').then(module => ({ default: module.QueuePanel })), { title: 'Очередь' });
const PrinterSettings = deferredPanel(() => import('./components/PrinterSettings').then(module => ({ default: module.PrinterSettings })), { title: 'Настройки принтера' });
const AnalyticsPanel = deferredPanel(() => import('./components/AnalyticsPanel').then(module => ({ default: module.AnalyticsPanel })), { title: 'История и статистика' });
const TvDashboard = deferredPanel(() => import('./components/TvDashboard').then(module => ({ default: module.TvDashboard })), { title: 'TV-панель фермы' });
const CameraGuardPanel = deferredPanel(() => import('./components/CameraGuardPanel').then(module => ({ default: module.CameraGuardPanel })), { title: 'Контроль камеры' });
const AutoDispatchPanel = deferredPanel(() => import('./components/AutoDispatchPanel').then(module => ({ default: module.AutoDispatchPanel })), { title: 'Диспетчер' });
const ProductionPanel = deferredPanel(() => import('./components/ProductionPanel').then(module => ({ default: module.ProductionPanel })), { title: 'Файлы и производство', embedded: true });
const SystemPanel = deferredPanel(() => import('./components/SystemPanel').then(module => ({ default: module.SystemPanel })), { title: 'Настройки' });
const MaintenancePanel = deferredPanel(() => import('./components/MaintenancePanel').then(module => ({ default: module.MaintenancePanel })), { title: 'Обслуживание' });
const FleetHealthPanel = deferredPanel(() => import('./components/FleetHealthPanel').then(module => ({ default: module.FleetHealthPanel })), { title: 'Самодиагностика' });
const PrinterFilesPanel = deferredPanel(() => import('./components/PrinterFilesPanel').then(module => ({ default: module.PrinterFilesPanel })), { title: 'Моя флешка' });

const emptyStatus:PrinterStatus={state:'offline',connectionState:'connecting',connectionReason:'connecting',klippyState:'unknown',connectionMessage:'Устанавливаем защищённое соединение с Moonraker',progress:0,printDuration:0,nozzle:0,nozzleTarget:0,bed:0,bedTarget:0};
const engineFailureDetail=(value:string|null)=>{
  if(!value)return'';
  const clean=value
    .replace(/(?:HEADLESS_ENGINE_(?:EMBEDDED_FALLBACK|START_FAILED):\s*)+/g,'')
    .replace(/((?:authorization|api[_ -]?key|access[_ -]?token)\s*[:=]\s*)\S+/gi,'$1[скрыто]')
    .replace(/\s+/g,' ')
    .trim();
  return Array.from(clean).slice(0,260).join('');
};
const AUTOMATIC_MODEL_REFRESH_MS=7*24*60*60*1_000;
const INCOMPLETE_MODEL_RETRY_MS=5*60*1_000;
type ThemeMode='light'|'dark';
type MainPage='dashboard'|'printers'|'tools'|'queue'|'files'|'history'|'stats'|'settings';
type SavedPrinterIdentityProbe={server:unknown;printer:unknown;machine:unknown;configStatus?:unknown;protocol:'rest'|'websocket';port:number};
type AddressEvidence={configurationKey:string;observations:PrinterAddressObservation[];checkedAt:number};
const THEME_STORAGE_KEY='klipper-productivity-theme-v2';
const storedTheme=():ThemeMode=>{try{return localStorage.getItem(THEME_STORAGE_KEY)==='dark'?'dark':'light'}catch{return 'light'}};
const applyTheme=(theme:ThemeMode)=>{
  document.documentElement.dataset.theme=theme;
  document.documentElement.style.colorScheme=theme;
};
applyTheme(storedTheme());
const normalizeConfig=(printer:PrinterConfig):PrinterConfig=>{
  const savedPreset=printer.profile?.preset;
  const profile=printer.profile?{...profileForPreset(printer.profile.preset),...printer.profile}:undefined;
  const normalizedName=savedPreset==='flashforge-ad5m'&&printer.nameSource!=='custom'
    ?normalizePrinterModelDisplayName(printer.name,savedPreset)
    :printer.name;
  // A known saved preset is an intentional legacy selection. A generic/custom
  // profile is not: migrate it into automatic detection so old installations
  // do not remain permanently labelled as an arbitrary Klipper printer.
  const legacySelection=savedPreset&&savedPreset!=='custom'
    ?{mode:'manual' as const,selectedPreset:savedPreset,source:'legacy' as const}
    :{mode:'automatic' as const,selectedPreset:'custom' as const,source:'legacy' as const};
  return normalizeCatalogIdentity({...printer,name:normalizedName||printer.name,profile,modelSelection:printer.modelSelection??legacySelection});
};
const load=():PrinterConfig[]=>{try{return createPrinterConfigStore().cached().map(normalizeConfig)}catch{return []}};
// Match the effective modelId passed to printer_actor_upsert. An explicit
// supported catalogue choice updates this selection together with its profile.
const operationalModelId=(config:PrinterConfig)=>config.modelSelection?.selectedPreset??config.profile?.preset??'custom';
const sameStatusValue=(key:keyof PrinterStatus,current:unknown,next:unknown)=>key==='position'&&Array.isArray(current)&&Array.isArray(next)
  ?current.length===next.length&&current.every((value,index)=>Object.is(value,next[index]))
  :Object.is(current,next);
const detectedPreset=(row:IdentifiedDiscoveredPrinter):PrinterProfile['preset']=>{
  const detection=(row.detection??{}) as unknown as Record<string,unknown>;
  const status=String(detection.status??'');
  if(status==='ambiguous'||status==='unknown')return 'custom';
  const raw=String(detection.model??detection.selectedModelId??detection.modelId??row.model??'custom');
  const preset=raw==='creality-k1c'?'creality-k1c-2025':raw;
  return ['ender3-v3-ke','ender3-v3-se','creality-k1c-2025','creality-k1-max','flashforge-ad5m'].includes(preset)?preset as PrinterProfile['preset']:'custom';
};

const automaticName=(row:IdentifiedDiscoveredPrinter,preset:PrinterProfile['preset'])=>{
  const detection=(row.detection??{}) as unknown as Record<string,unknown>;
  const supplied=typeof detection.name==='string'?detection.name:row.detectedName;
  const normalized=normalizePrinterModelDisplayName(supplied,preset);
  if(normalized)return normalized;
  const names:Partial<Record<NonNullable<PrinterProfile['preset']>,string>>={
    'ender3-v3-ke':'Ender-3 V3 KE','ender3-v3-se':'Ender-3 V3 SE','creality-k1c-2025':'Creality K1C',
    'creality-k1-max':'Creality K1 Max','flashforge-ad5m':FLASHFORGE_5M_DISPLAY_NAME
  };
  return names[preset??'custom']??`Klipper · ${row.ip}`;
};

const discoveryDecision=(row:IdentifiedDiscoveredPrinter)=>row.detection?.decision??(
  row.detection?.status==='matched'&&row.detection.confidence==='high'?'confirmed':
  row.detection?.status==='matched'&&row.detection.confidence==='medium'?'probable':
  row.detection?.status==='ambiguous'?'conflict':'unknown'
);

const discoveredIdentity=(row:IdentifiedDiscoveredPrinter)=>row.deviceIdentity??row.detection?.deviceIdentity;
const savedIdentityConflictsWithDiscovery=(saved:PrinterModel,row:IdentifiedDiscoveredPrinter)=>{
  const detected=discoveredIdentity(row);
  const savedUuid=saved.deviceIdentity?.signals.uuid?.trim().toLowerCase();
  const detectedUuid=(detected?.signals.uuid??row.moonraker_uuid)?.trim().toLowerCase();
  if(savedUuid&&detectedUuid)return savedUuid!==detectedUuid;
  return !!saved.deviceIdentity?.dedupeSafe&&!!detected?.dedupeSafe&&saved.deviceIdentity.stableId!==detected.stableId;
};
const existingForDiscovery=(printers:PrinterModel[],row:IdentifiedDiscoveredPrinter)=>{
  const byIdentity=findPhysicalPrinter(printers,discoveredIdentity(row));
  if(byIdentity&&!savedIdentityConflictsWithDiscovery(byIdentity,row))return byIdentity;
  return printers.find(printer=>samePrinterEndpoint(printer.host,row.host)&&!savedIdentityConflictsWithDiscovery(printer,row));
};

const discoveredConfig=(row:IdentifiedDiscoveredPrinter,usedNames:string[],confirmProbable=false,existing?:PrinterModel):PrinterModel=>{
  const preset=detectedPreset(row);
  const catalog=getCatalogModel(row.catalogModelId);
  const name=existing?.name??uniquePrinterName(catalog?catalogModelName(catalog):automaticName(row,preset),usedNames);
  if(!existing)usedNames.push(name);
  const base:PrinterConfig=existing
    ?{...normalizeCatalogIdentity(existing),host:row.host,deviceIdentity:refreshDeviceIdentityEvidence(existing.deviceIdentity,row.deviceIdentity??row.detection?.deviceIdentity)}
    :{
      id:crypto.randomUUID(),name,nameSource:'automatic',host:row.host,catalogModelId:catalog?.id,icon:iconForPreset('custom'),profile:profileForPreset('custom'),
      deviceIdentity:row.deviceIdentity??row.detection?.deviceIdentity,
      modelSelection:{mode:'automatic',selectedPreset:'custom',source:'automatic',updatedAt:Date.now()},
    };
  const detectedConfig=row.detection?.facts
    ?applyModelDetection(base,row.detection as CompleteDetection,confirmProbable)
    :base;
  // Rediscovery updates the endpoint/evidence without replacing an explicit
  // operator-selected management profile.
  const configured=existing?.modelSelection?.mode==='manual'
    ?{...detectedConfig,profile:existing.profile,icon:existing.icon,modelSelection:{...existing.modelSelection,lastDetection:detectedConfig.modelSelection?.lastDetection??existing.modelSelection.lastDetection}}
    :detectedConfig;
  const discoveredChannel={connectionProtocol:row.working_protocol,connectionPort:row.working_port};
  const endpointChanged=!!existing&&!samePrinterEndpoint(existing.host,row.host);
  const status=existing
    ?endpointChanged
      ?{...existing.status,...discoveredChannel,connectionState:'connecting' as const,connectionReason:'connecting' as const,connectionMessage:`Адрес обновлён: ${printerHostDisplay(existing.host)} → ${printerHostDisplay(row.host)}`}
      :{...existing.status,...discoveredChannel}
    :{...emptyStatus,...discoveredChannel};
  return {...(catalog?applyCatalogModel(configured,catalog):configured),status,webcams:existing?.webcams??[]};
};

export function FarmApp({session,onLogout}:{session:AuthSession;onLogout:()=>void}){
  const [voiceAssistantOpen,setVoiceAssistantOpen]=useState(false);
  const [theme,setTheme]=useState<ThemeMode>(storedTheme);
  const [page,setPage]=useState<MainPage>('dashboard');
  const [production,setProduction]=useState(false);
  const [productionTab,setProductionTab]=useState<'library'|'spools'>('library');
  const [system,setSystem]=useState(false);
  const [setup,setSetup]=useState(localStorage.getItem('klipper-setup-v07')!=='done'&&load().length===0);
  const [rawPrinters,setPrinters]=useState<PrinterModel[]>(()=>load().map(p=>({...p,status:{...emptyStatus},webcams:[]})));
  const [addressEvidence,setAddressEvidence]=useState<AddressEvidence>();
  const [addressVerificationPending,setAddressVerificationPending]=useState<ReadonlySet<string>>(()=>new Set());
  const addressConfigurationKey=printerAddressConfigurationKey(rawPrinters);
  const addressPlan=useMemo(()=>planPrinterAddressRecovery(rawPrinters,addressEvidence?.configurationKey===addressConfigurationKey?addressEvidence.observations:[],{verificationRequiredIds:addressVerificationPending}),[rawPrinters,addressEvidence,addressConfigurationKey,addressVerificationPending]);
  const addressPlanRef=useRef(addressPlan);addressPlanRef.current=addressPlan;
  const addressEvidenceRef=useRef(addressEvidence);addressEvidenceRef.current=addressEvidence;
  const nativeAddressPause=useRef<Promise<void>>(Promise.resolve());
  const addressProbeCursor=useRef(0);
  const printers=useMemo(()=>rawPrinters.map(printer=>addressPlan.blockedIds.has(printer.id)?{...printer,status:{...emptyStatus,remoteControlSuspended:true,connectionMessage:addressPlan.reasons.get(printer.id)},webcams:[]}:printer),[rawPrinters,addressPlan]);
  const [selected,setSelected]=useState<string>();
  const [camera,setCamera]=useState<string>();
  const [settings,setSettings]=useState<string>();
  const [queue,setQueue]=useState(false);
  const [analytics,setAnalytics]=useState(false);
  const [tv,setTv]=useState(false);
  const [cameraGuardOpen,setCameraGuardOpen]=useState(false);
  const [dispatch,setDispatch]=useState(false);
  const [maintenance,setMaintenance]=useState(false);
  const [health,setHealth]=useState(false);
  const [showDiscovery,setShowDiscovery]=useState(false);
  const [printerConfigReady,setPrinterConfigReady]=useState(false);
  const [printerConfigError,setPrinterConfigError]=useState('');
  const printerStore=useMemo(()=>createPrinterConfigStore(),[]);
  const printerSaveRevision=useRef(0);
  const printerConfigSaveInFlight=useRef(false);
  const printerConfigLoaded=useRef(false);
  const [filesPrinterId,setFilesPrinterId]=useState<string>();
  const [internetAvailable,setInternetAvailable]=useState(browserInternetAvailable);
  const [engineRuntime,setEngineRuntime]=useState<HeadlessEngineStatus>({status:'starting',error:null});
  const engineRuntimeDetail=engineFailureDetail(engineRuntime.error);
  const clients=useRef(new Map<string,MoonrakerClient>()), previousStates=useRef(new Map<string,string>()),connectionNotices=useRef(new ConnectionNoticeTracker()),previousFilament=useRef(new Map<string,boolean>()),notificationTimers=useRef(new Map<string,number>()),cancelledPrints=useRef(new Map<string,{filename:string;ts:number}>()),printRecordChain=useRef<Promise<void>>(Promise.resolve()),printersRef=useRef<PrinterModel[]>(printers);
  const discoveryRecheckInFlight=useRef(false),discoveryRecheckLastRun=useRef(0),discoveryRecheckOperation=useRef<string>(),networkFingerprint=useRef<string>(),networkHeartbeat=useRef(Date.now());
  const activePrintNotices=useRef(new Map<string,{filename:string;key:string}>());
  const faultNotices=useRef(new PrinterFaultNoticeTracker());
  const engineRuntimeReported=useRef('');
  const isTauri='__TAURI_INTERNALS__' in window;
  const minimizeWindow=()=>{if(isTauri)getCurrentWindow().minimize().catch(()=>{})};
  const closeWindow=()=>{if(isTauri)getCurrentWindow().close().catch(()=>{})};

  useEffect(()=>{
    let timer:number|undefined;
    const show=()=>{document.documentElement.classList.add('scrollbarVisible');if(timer)window.clearTimeout(timer);timer=window.setTimeout(()=>document.documentElement.classList.remove('scrollbarVisible'),900)};
    const move=(e:PointerEvent)=>{if(window.innerWidth-e.clientX<=22)show();else if(!timer)document.documentElement.classList.remove('scrollbarVisible')};
    window.addEventListener('pointermove',move,{passive:true});window.addEventListener('scroll',show,{passive:true});
    return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('scroll',show);if(timer)window.clearTimeout(timer);document.documentElement.classList.remove('scrollbarVisible')};
  },[]);

  useEffect(()=>{
    const pause=()=>document.documentElement.classList.add('kfAmbientPaused');
    const resume=()=>document.documentElement.classList.remove('kfAmbientPaused');
    const visibility=()=>document.hidden?pause():resume();
    window.addEventListener('blur',pause);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',visibility);
    return()=>{window.removeEventListener('blur',pause);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',visibility);resume()};
  },[]);

  useEffect(()=>{
    const root=document.documentElement;
    if('__TAURI_INTERNALS__' in window)root.classList.add('tauri-runtime');
    return()=>root.classList.remove('tauri-runtime');
  },[]);

  useEffect(()=>{
    applyTheme(theme);
    localStorage.setItem(THEME_STORAGE_KEY,theme);
    localStorage.removeItem('klipper-theme');
  },[theme]);
  useEffect(()=>{localStorage.removeItem('klipper-page')},[]);
  useEffect(()=>subscribeInternetAvailability(setInternetAvailable),[]);

  useEffect(()=>{
    let stopped=false,timer:number|undefined;
    const refresh=async()=>{
      let nextDelay=10_000;
      try{
        const status=await headlessEngineStatus();
        if(stopped)return;
        setEngineRuntime(status);
        nextDelay=status.status==='starting'||status.status==='failed'?1_000:10_000;
        const marker=`${status.status}:${status.error??''}`;
        if(marker!==engineRuntimeReported.current){
          engineRuntimeReported.current=marker;
          if(status.status==='failed')diagnosticError('engine.startup',status.error??'klipper-farmd не запущен',{operation:'engine.status'});
          else if(status.status==='embeddedFallback')diagnosticWarning('engine.failover',status.error??'Встроенный движок активен',{operation:'engine.status'});
        }
      }catch(error){
        if(!stopped)diagnosticWarning('engine.status',error,{operation:'engine.status'});
      }finally{
        if(!stopped)timer=window.setTimeout(refresh,nextDelay);
      }
    };
    void refresh();
    return()=>{stopped=true;if(timer!==undefined)window.clearTimeout(timer)};
  },[]);

  useEffect(()=>{
    let active=true,retry:number|undefined;
    const hydrate=async()=>{const revision=printerSaveRevision.current;try{
      const loaded=await printerStore.load({canWrite:session.user.role==='admin'});
      const cfg=loaded.configs;
      let rewrite=false;
      const runtime=await Promise.all(cfg.map(async source=>{const p=normalizeConfig(source);
        if(!source.modelSelection||p.name!==source.name||p.nameSource!==source.nameSource)rewrite=true;
        let apiKeyStored=!!p.apiKeyStored;
        if(p.apiKey&&session.user.role==='admin'){await secretSet(p.id,p.apiKey);apiKeyStored=true;rewrite=true}
        return {...p,apiKey:undefined,apiKeyStored,status:{...emptyStatus},webcams:[]}
      }));
      if(!active||revision!==printerSaveRevision.current)return;
      const clean=persistablePrinterConfigs(runtime);
      if((rewrite||loaded.needsSave)&&session.user.role==='admin')await printerStore.save(clean);
      if(!active||revision!==printerSaveRevision.current)return;
      printerConfigLoaded.current=true;
      setPrinters(current=>runtime.map(printer=>{
        const live=current.find(item=>item.id===printer.id&&samePrinterEndpoint(item.host,printer.host));
        return {...printer,status:live?.status??printer.status,webcams:live?.webcams??printer.webcams};
      }));
      if(runtime.length)setSetup(false);
      setPrinterConfigError(loaded.pending?'Есть незавершённое сохранение настроек принтеров. Войдите как администратор, чтобы завершить запись.':'');
    }catch(error){
      diagnosticError('printers.migration',error,{operation:'printers.config'});
      if(active){setPrinterConfigError('Не удалось прочитать или сохранить настройки принтеров. Показана последняя локальная копия; проверка повторится автоматически.');retry=window.setTimeout(()=>void hydrate(),5_000)}
    }finally{if(active)setPrinterConfigReady(true)}};
    void hydrate();
    return()=>{active=false;if(retry!==undefined)window.clearTimeout(retry)};
  },[session.user.role,printerStore]);

  // Printer connections must not wait for unrelated production preferences.
  useEffect(()=>{
    if(!printerConfigReady)return;
    void Promise.all([
      migrateLocal('production.schedule',['klipper-schedule-v06'],[]),
      migrateLocal('production.cost',['klipper-cost-v06'],{electricityPerKwh:.25,printerWatts:250,laborPerHour:0,currency:'€'}),
      migrateLocal('dispatch.smartJobs',['klipper-smart-jobs-v06','klipper-smart-jobs-v05'],[]),
    ]).catch(error=>diagnosticError('production.migration',error,{operation:'production.preferences'}));
  },[printerConfigReady,session.user.role]);

  const role=session.user.role;
  const canOperate=role!=='viewer';
  const isAdmin=role==='admin';
  // Stop by the authoritative native printer ID binding, never by a guessed
  // frontend/native stable-ID hash. Configuration and print history stay intact.
  const suspendAddressActors=(ids:ReadonlySet<string>)=>{
    if(!isAdmin||!ids.size)return Promise.resolve();
    const operation=nativeAddressPause.current.catch(()=>{}).then(async()=>{
      const actors=await secureInvoke<Array<{printerId:string;stableId:string}>>('printer_actor_list',{});
      for(const actor of actors)if(ids.has(actor.printerId))await printerActorRemove(actor.stableId);
    });
    nativeAddressPause.current=operation;
    return operation;
  };
  const maintenanceController=useMaintenance(printers,canOperate&&printerConfigReady);
  useFilamentAccounting({printers,clients:clients.current,enabled:canOperate&&printerConfigReady});
  usePrintNearEndNotifications(printers,printerConfigReady);
  const cameraGuardController=useCameraGuard({printers,clients:clients.current,enabled:canOperate&&printerConfigReady});
  // FarmApp exists only for an authenticated session. Viewer telemetry also
  // needs background delivery; control permissions remain in each controller.
  const monitoringActive=printerConfigReady&&printers.length>0;
  useEffect(()=>monitoringActive?holdMonitoringActivity(reason=>diagnosticWarning('monitoring.background_activity',reason)):undefined,[monitoringActive]);

  useEffect(()=>{
    if(!printerConfigReady)return;
    let cancelled=false;
    const blocked=addressPlanRef.current.blockedIds;
    for(const id of blocked){
      clients.current.get(id)?.disconnect();clients.current.delete(id);
      previousStates.current.delete(id);previousFilament.current.delete(id);
      for(const [key,timer] of notificationTimers.current)if(key.startsWith(`${id}:`)){window.clearTimeout(timer);notificationTimers.current.delete(key)}
    }
    const sync=async()=>{
      await suspendAddressActors(blocked);
      if(cancelled)return;
      printers.forEach(p=>{
        if(blocked.has(p.id))return;
        const existing=clients.current.get(p.id);
        if(existing){
          const endpointChanged=!samePrinterEndpoint(existing.config.host,p.host);
          const credentialChanged=existing.config.apiKey!==p.apiKey||!!existing.config.apiKeyStored!==!!p.apiKeyStored;
          const operationalModelChanged=operationalModelId(existing.config)!==operationalModelId(p);
          existing.config=p;
          if(credentialChanged)existing.resetAuthorizationBackoff();
          if(endpointChanged||credentialChanged||operationalModelChanged)existing.reconnect().then(()=>existing.webcams()).then(webcams=>{
            if(!cancelled&&clients.current.get(p.id)===existing&&samePrinterEndpoint(existing.config.host,p.host)&&!addressPlanRef.current.blockedIds.has(p.id))setPrinters(xs=>xs.map(x=>x.id===p.id?{...x,webcams}:x));
          }).catch(error=>diagnosticWarning('printer.reconnect',error,{printerId:p.id,operation:'printer.reconnect'}));
          return;
        }
        const c=new MoonrakerClient(p);
        clients.current.set(p.id,c);
        c.onPhysicalIdentity(observation=>{
          if(clients.current.get(p.id)!==c)return;
          const current=printersRef.current,printer=current.find(value=>value.id===p.id);
          if(!printer||!samePrinterEndpoint(printer.host,observation.host))return;
          const identity=printerDeviceIdentity({identity:observation.signals});
          if(!hasStrongPrinterIdentity(identity))return;
          const configurationKey=printerAddressConfigurationKey(current),previous=addressEvidenceRef.current;
          const prior=previous?.configurationKey===configurationKey?previous.observations:[];
          const address=printerAddressKey(observation.host);
          if(prior.some(value=>printerAddressKey(value.host)===address&&(value.observedAt??0)>observation.attestedAt))return;
          const observations=[...prior.filter(value=>printerAddressKey(value.host)!==address),{host:observation.host,identity,confirmed:true,observedAt:observation.attestedAt}];
          const evidence={configurationKey,observations,checkedAt:Date.now()};
          const nextPlan=planPrinterAddressRecovery(current,observations,{verificationRequiredIds:addressVerificationPending});
          // Invalidate callbacks synchronously, before the client can publish
          // the same snapshot's online status for a foreign physical device.
          addressEvidenceRef.current=evidence;addressPlanRef.current=nextPlan;
          for(const id of nextPlan.blockedIds){clients.current.get(id)?.disconnect();clients.current.delete(id)}
          setAddressEvidence(evidence);
          if(nextPlan.blockedIds.size||nextPlan.assignments.length||nextPlan.learnedIdentities.length){
            void suspendAddressActors(nextPlan.blockedIds).catch(error=>diagnosticWarning('printer.address_identity',error,{printerId:p.id}));
            window.dispatchEvent(new Event('klipper-printer-address-recheck'));
          }
        });
        c.onStatus(patch=>setPrinters(xs=>{
          const idx=xs.findIndex(x=>x.id===p.id);
          if(idx<0||clients.current.get(p.id)!==c||addressPlanRef.current.blockedIds.has(p.id)||!samePrinterEndpoint(xs[idx].host,c.config.host))return xs;
          const current=xs[idx];
          const entries=Object.entries(patch) as [keyof PrinterStatus, any][];
          if(entries.every(([k,v])=>sameStatusValue(k,current.status[k],v)))return xs;
          const next=xs.slice();next[idx]={...current,status:{...current.status,...patch}};return next;
        }));
        c.connect().then(async()=>{
          if(clients.current.get(p.id)!==c||addressPlanRef.current.blockedIds.has(p.id))return;
          const webcams=await c.webcams().catch(()=>[]);
          if(!cancelled&&clients.current.get(p.id)===c&&!addressPlanRef.current.blockedIds.has(p.id)&&samePrinterEndpoint(c.config.host,p.host))setPrinters(xs=>xs.map(x=>x.id===p.id?{...x,webcams}:x));
        }).catch(error=>diagnosticError('printer.connect',error,{printerId:p.id,operation:'printer.connect'}));
      });
      const ids=new Set(printers.map(p=>p.id));
      for(const [id,c] of clients.current)if(!ids.has(id)){c.disconnect();clients.current.delete(id)}
    };
    void sync().catch(error=>diagnosticWarning('printer.address_pause',error,{operation:'printer.address_pause'}));
    return()=>{cancelled=true};
  },[printerConfigReady,printers.map(p=>`${p.id}:${p.host}:${p.name}:${operationalModelId(p)}:${p.catalogModelId??''}:${p.apiKeyStored?'stored':'none'}`).join('|'),addressEvidence?.checkedAt]);

  useEffect(()=>()=>{clients.current.forEach(c=>c.disconnect())},[]);
  useEffect(()=>{printersRef.current=printers},[printers]);
  useEffect(()=>{observePrinterVisualActivity(printers)},[printers]);
  useEffect(()=>()=>{notificationTimers.current.forEach(t=>window.clearTimeout(t));notificationTimers.current.clear()},[]);

  useEffect(()=>{
    const cancel=(key:string)=>{const t=notificationTimers.current.get(key);if(t)window.clearTimeout(t);notificationTimers.current.delete(key)};
    const confirmStable=(key:string,delay:number,test:()=>boolean,run:()=>void)=>{cancel(key);notificationTimers.current.set(key,window.setTimeout(()=>{notificationTimers.current.delete(key);if(test())run()},delay))};
    faultNotices.current.retain(new Set(printers.map(printer=>printer.id)));
    for(const p of printers){
      const prev=previousStates.current.get(p.id);
      const wasActive=prev==='printing'||prev==='paused';
      if(p.status.state==='printing'||p.status.state==='paused'){
        const previous=activePrintNotices.current.get(p.id);
        if(!previous||prev==='ready'||prev==='error')activePrintNotices.current.set(p.id,{filename:p.status.filename||'Текущее задание',key:crypto.randomUUID()});
        else if(p.status.filename)previous.filename=p.status.filename;
      }
      const activity=activePrintNotices.current.get(p.id);
      const cancellation=cancelledPrints.current.get(p.id);
      if(wasActive&&p.status.state==='ready'&&cancellation&&Date.now()-cancellation.ts<90_000){cancelledPrints.current.delete(p.id);cancel(`${p.id}:complete`)}
      else if(wasActive&&printerCompletionNotificationAllowed(p.status)){
        const filename=p.status.filename||activity?.filename||'Задание завершено';
        confirmStable(`${p.id}:complete`,6000,()=>{const current=printersRef.current.find(x=>x.id===p.id);return !!current&&printerCompletionNotificationAllowed(current.status)},()=>{notify(`${p.name}: печать завершена`,filename,'complete',`${p.id}:complete:${activity?.key??filename}`,30*60_000);publishPrinterVisualCompletion(p.id);audit('print.complete',`${p.name} · ${filename}`);recordPrint(p,'completed',filename);if(voiceEventSpeechPreferences().complete)void trySpeakNeuralAnnouncement(voiceEventSpeechText('complete',p.name,filename)).catch(()=>{})});
      }else if(!printerCompletionNotificationAllowed(p.status))cancel(`${p.id}:complete`);
      const fault=faultNotices.current.observe(p.id,p.status);
      if(fault){
        cancel(`${p.id}:complete`);
        notify(`${p.name}: ${fault.controller?'ошибка принтера':'ошибка печати'}`,fault.message,'error',`${p.id}:fault:${activity?.key??'controller'}:${fault.episode}`,0);
        if(voiceEventSpeechPreferences().error)void trySpeakNeuralAnnouncement(voiceEventSpeechText('error',p.name,fault.message)).catch(()=>{});
        audit('printer.error',`${p.name} · ${fault.message}`);
        if(wasActive||(activity&&p.status.printStatsState==='error'))recordPrint(p,'error',p.status.filename||activity?.filename||'Неизвестное задание',fault.message);
      }
      const filamentPrev=previousFilament.current.get(p.id);
      if(filamentPrev===true&&p.status.filamentDetected===false&&(p.status.state==='printing'||p.status.state==='paused')){
        if(p.status.state==='printing'&&canOperate)clients.current.get(p.id)?.pause().catch(error=>diagnosticWarning('filament.runout_pause',error,{printerId:p.id}));
        notify(`${p.name}: закончился филамент`,p.status.state==='paused'?'Печать на паузе. Проверьте катушку и заправку пластика.':'Пластик не обнаружен. Проверьте катушку и состояние печати.','runout',`${p.id}:filament:${activity?.key??'current'}`,30*60_000);
        if(voiceEventSpeechPreferences().runout)void trySpeakNeuralAnnouncement(voiceEventSpeechText('runout',p.name)).catch(()=>{});
        audit('filament.runout',p.name);
      }
      if(p.status.filamentDetected!==undefined)previousFilament.current.set(p.id,p.status.filamentDetected);
      previousStates.current.set(p.id,p.status.state)
    }
  },[printers]);

  useEffect(()=>{
    if(!canOperate)return;
    let stopped=false,inFlight=false,timer:number|undefined;
    const tick=async()=>{
      if(inFlight){if(!stopped)timer=window.setTimeout(tick,15_000);return}
      inFlight=true;
      try{
        const jobs=await dbGet<ScheduledJob[]>('production.schedule',[]);
        let changed=false;
        for(const j of jobs){
          if(stopped||!j.enabled||j.scheduledAt>Date.now())continue;
          const candidates=printersRef.current.filter(p=>(!j.printerId||p.id===j.printerId)&&p.status.state==='ready'&&p.status.connectionState==='online');
          const p=candidates[0],c=p&&clients.current.get(p.id);
          if(!c)continue;
          try{
            const report=await validateGCode(c,p,j.filename);
            if(!report.ok){j.enabled=false;changed=true;await audit('schedule.blocked',`${p.name} · ${j.filename} · ${report.issues.filter(x=>x.level==='error').map(x=>x.message).join('; ')}`);continue}
            const live=printersRef.current.find(value=>value.id===p.id);
            if(stopped||!live||live.status.state!=='ready'||live.status.connectionState!=='online'||!await c.isReady())continue;
            await c.start(j.filename,printStartOptionsFromValidation(report));
            notify(`${p.name}: запланированный запуск`,j.filename,'complete',`${p.id}:scheduled:${j.id}:${j.scheduledAt}`,10*60_000);
            const interval=j.repeat==='daily'?86_400_000:j.repeat==='weekly'?604_800_000:0;
            if(interval){do{j.scheduledAt+=interval}while(j.scheduledAt<=Date.now())}
            else j.enabled=false;
            changed=true
          }catch(error){diagnosticError('schedule.tick',error,{printerId:p?.id,operation:'schedule.start'})}
        }
        if(changed&&!stopped)await dbSet('production.schedule',jobs)
      }finally{inFlight=false;if(!stopped)timer=window.setTimeout(tick,15_000)}
    };
    timer=window.setTimeout(tick,3_000);
    return()=>{stopped=true;if(timer)window.clearTimeout(timer)}
  },[canOperate]);

  const notify=(title:string,body:string,kind:'complete'|'error'|'offline'|'runout'='complete',eventKey=`${kind}:${title}:${body}`,cooldown=10*60_000)=>{
    const storageKey='klipper-notification-history';let history:Record<string,number>={};try{history=JSON.parse(localStorage.getItem(storageKey)||'{}')}catch(error){diagnosticWarning('notifications.history',error)}
    if(!history||typeof history!=='object'||Array.isArray(history))history={};
    const now=Date.now();if(now-(history[eventKey]||0)<cooldown)return;
    history[eventKey]=now;for(const [key,time] of Object.entries(history))if(now-time>24*60*60_000)delete history[key];try{localStorage.setItem(storageKey,JSON.stringify(history))}catch(error){diagnosticWarning('notifications.history_save',error)}
    showAppNotification(title,body,kind==='complete'?'success':'danger',kind==='offline'?{expiresAfterMs:8000,dedupeKey:eventKey}:{});
    void playNotificationSound(kind,eventKey);
    nativeNotify(title,body).catch(error=>{diagnosticWarning('notifications.native',error);if('Notification'in window&&Notification.permission==='granted')new Notification(title,{body,tag:eventKey})});
    telegramSettings().then(s=>{const allowed=kind==='complete'?s.notifyComplete:kind==='offline'?s.notifyOffline:s.notifyError;if(s.enabled&&allowed)telegramSend(`🖨️ ${title}\n${body}`).catch(error=>diagnosticWarning('notifications.telegram',error))})
  };
  useEffect(()=>{
    const sample=()=>{
      const current=printersRef.current;
      connectionNotices.current.retain(new Set(current.map(printer=>printer.id)));
      for(const printer of current){
        if(printer.status.remoteControlSuspended)continue;
        const state=printer.status.connectionState??(printer.status.state==='offline'?'offline':'online');
        const event=connectionNotices.current.observe(printer.id,state);
        if(event==='lost'){
          notify(`${printer.name}: нет связи`,'Принтер недоступен. Фоновая проверка продолжится с увеличенным интервалом.','offline',`${printer.id}:offline`,60*60_000);
          void audit('printer.offline',`${printer.name} · ${printer.host}`);
        }else if(event==='restored')void audit('printer.online',`${printer.name} · связь восстановлена`);
      }
    };
    const timer=window.setInterval(sample,5_000);
    return()=>window.clearInterval(timer);
  },[]);
  const recordPrint=(p:PrinterModel,status:PrintRecord['status'],filename:string,message?:string)=>{printRecordChain.current=printRecordChain.current.then(async()=>{if(!canOperate)return;const client=clients.current.get(p.id),camera=p.webcams.find(item=>item.enabled&&item.snapshot_url),metadata=client?await client.metadata(filename).catch(error=>{diagnosticWarning('history.metadata',error,{printerId:p.id,operation:'history.record'});return undefined}):undefined;let snapshotId:string|undefined;if(client&&camera){try{const response=await client.snapshot(camera.snapshot_url);snapshotId=await snapshotStore(p.id,response.contentType||'image/jpeg',response.body)}catch(error){diagnosticWarning('history.snapshot',error,{printerId:p.id,operation:'history.record'})}}const record:PrintRecord={id:crypto.randomUUID(),ts:Date.now(),printerId:p.id,printerName:p.name,filename,status,duration:p.status.printDuration||p.status.totalDuration||0,filamentUsed:p.status.filename===filename?p.status.filamentUsedMm:undefined,material:metadata?.filament_type,nozzle:metadata?.nozzle_diameter,objectHeight:metadata?.object_height,slicer:metadata?.slicer,snapshotId,message};const current=await dbGet<PrintRecord[]>('production.printRecords',[]);await dbSet('production.printRecords',[record,...current].slice(0,500));window.dispatchEvent(new CustomEvent('klipper-print-records-updated'))}).catch(error=>diagnosticError('history.record',error,{printerId:p.id,operation:'history.record'}))};
  const save=async(xs:PrinterModel[],expectedRevision?:number)=>{
    if(!printerConfigReady||!printerConfigLoaded.current)throw new Error('Дождитесь успешной загрузки сохранённых настроек принтеров. Последняя локальная копия пока доступна для просмотра.');
    if(printerConfigSaveInFlight.current)throw new Error('Настройки принтеров уже сохраняются. Дождитесь завершения и повторите сохранение.');
    if(expectedRevision!==undefined&&expectedRevision!==printerSaveRevision.current)throw new Error('Настройки принтеров изменились во время проверки. Повторите добавление принтера.');
    // Full configuration snapshots must not be queued from the same old state.
    // Reject a second edit before it can replace the first edit's journal.
    printerConfigSaveInFlight.current=true;
    printerSaveRevision.current++;
    try{
      await printerStore.save(persistablePrinterConfigs(xs));
      const mergeRuntime=(current:PrinterModel[])=>xs.map(printer=>{
        const live=current.find(item=>item.id===printer.id&&samePrinterEndpoint(item.host,printer.host));
        return {...printer,status:live?.status??{...emptyStatus},webcams:live?.webcams??[]};
      });
      // Publish committed configuration synchronously before another save may
      // build its snapshot. React still merges any more recent live telemetry.
      printersRef.current=mergeRuntime(printersRef.current);
      setPrinters(current=>mergeRuntime(current));
      setPrinterConfigError('');
    }catch(error){setPrinterConfigError('Не удалось подтвердить сохранение настроек принтеров. Повторите сохранение.');diagnosticError('printers.save',error,{operation:'printers.config'});throw error}
    finally{printerConfigSaveInFlight.current=false}
  };
  useEffect(()=>{
    if(!isAdmin||!printerConfigReady||showDiscovery)return;
    let stopped=false,timer:number|undefined,networkTimer:number|undefined,addressRetry:number|undefined,lastTransitionAt=0,networkPolling=false;
    const run=async(reason:'startup'|'periodic'|'resume'|'network'|'address')=>{
      const now=Date.now(),blocked=addressPlanRef.current.blockedIds;
      const minimumGap=reason==='periodic'?(blocked.size?30_000:60_000):5_000;
      if(stopped||showDiscovery)return;
      if(discoveryRecheckInFlight.current||now-discoveryRecheckLastRun.current<minimumGap){
        if(reason!=='periodic'&&addressRetry===undefined)addressRetry=window.setTimeout(()=>{addressRetry=undefined;void run(reason)},2_000);
        return;
      }
      const original=printersRef.current.slice(),revision=printerSaveRevision.current,configurationKey=printerAddressConfigurationKey(original);
      const recoveryTargets=original.filter(printer=>blocked.has(printer.id)||hasStrongPrinterIdentity(printer.deviceIdentity)||!printerIsReachable(printer.status));
      if(!recoveryTargets.length)return;
      discoveryRecheckInFlight.current=true;discoveryRecheckLastRun.current=now;
      try{
        const operationId=`background-${now}`;discoveryRecheckOperation.current=operationId;
        let selectedAdapterAddresses:string[]|undefined;try{const saved=JSON.parse(localStorage.getItem('klipper-discovery-adapters-v208')||'[]');if(Array.isArray(saved)&&saved.every(value=>typeof value==='string')&&saved.length)selectedAdapterAddresses=saved.slice(0,32)}catch{}
        const result=await secureInvoke<DiscoveryResult>('discover_moonraker',{knownHosts:printersRef.current.map(printer=>printer.host),operationId,manualRange:undefined,selectedAdapterAddresses,fastRecovery:reason!=='periodic'});
        if(stopped)return;
        try{
          const key='klipper-discovery-history-v206',saved=JSON.parse(localStorage.getItem(key)||'[]'),history=Array.isArray(saved)?saved:[];
          const counts={...(result.diagnostics?.counts??{})};
          const entry={
            id:operationId,startedAt:new Date(now).toISOString(),durationMs:result.duration_ms??Date.now()-now,
            found:result.printers?.length??0,confirmed:(result.printers??[]).filter(candidate=>candidate.moonraker_confirmed).length,
            timedOut:!!result.timed_out,fastRecovery:!!result.fast_recovery,subnets:(result.scanned_subnets??[]).slice(0,32),counts,
            adapters:(result.diagnostics?.adapters??[]).filter(adapter=>adapter.eligible!==false||selectedAdapterAddresses?.includes(adapter.name)||selectedAdapterAddresses?.includes(adapter.address)).map(adapter=>`${adapter.name} · ${adapter.address}`),
            routes:[...new Set((result.printers??[]).filter(candidate=>candidate.working_protocol&&candidate.working_port).map(candidate=>`${candidate.working_protocol}:${candidate.working_port}`))],
            errors:Object.entries(counts).filter(([outcome])=>['closed_port','timeout','network_error','http_404','not_moonraker'].includes(outcome)).reduce((sum,[,count])=>sum+count,0),routeSwitches:0,
          };
          localStorage.setItem(key,JSON.stringify([entry,...history.filter(item=>item?.id!==operationId)].slice(0,10)));
        }catch{}
        // Discovery hints never choose a card by model/hostname. Re-read the
        // physical identity at each actual address using saved credentials.
        const candidatePriority=(candidate:DiscoveredPrinter)=>original.some(printer=>printerAddressKey(printer.host)===printerAddressKey(candidate.host))?0:original.some(printer=>strongPrinterIdentityMatch(printer.deviceIdentity,candidate.deviceIdentity))?1:2;
        const availableCandidates=[...new Map((result.printers??[]).filter(candidate=>candidate.moonraker_confirmed).map(candidate=>[printerAddressKey(candidate.host),candidate])).values()].sort((a,b)=>candidatePriority(a)-candidatePriority(b)||printerAddressKey(a.host).localeCompare(printerAddressKey(b.host)));
        const start=availableCandidates.length?addressProbeCursor.current%availableCandidates.length:0;
        const candidates=[...availableCandidates.slice(start),...availableCandidates.slice(0,start)].slice(0,32);
        const observations:PrinterAddressObservation[]=[];
        const proofDeadline=Date.now()+12_000;
        let cursor=0,processed=0,proofIncomplete=availableCandidates.length>candidates.length;
        const worker=async()=>{
          while(cursor<candidates.length){
            const candidate=candidates[cursor++];
            if(stopped||revision!==printerSaveRevision.current)return;
            if(Date.now()>=proofDeadline){proofIncomplete=true;return}
            processed++;
            const preferred=original.filter(printer=>printerAddressKey(printer.host)===printerAddressKey(candidate.host)||strongPrinterIdentityMatch(printer.deviceIdentity,candidate.deviceIdentity));
            const credentials=[...preferred,...recoveryTargets.filter(printer=>!preferred.some(value=>value.id===printer.id))].slice(0,8);
            for(const saved of credentials){
              if(Date.now()>=proofDeadline){proofIncomplete=true;return}
              try{
                const probe=await secureInvoke<SavedPrinterIdentityProbe>('recheck_saved_printer_identity',{printerId:saved.id,host:candidate.host});
                if(stopped||revision!==printerSaveRevision.current)return;
                const identity=printerDeviceIdentity(printerDetectionFactsFromMoonraker({server:probe.server,printer:probe.printer,machine:probe.machine,configStatus:probe.configStatus}));
                observations.push({host:candidate.host,identity,confirmed:true,protocol:probe.protocol,port:probe.port,observedAt:Date.now()});
                break;
              }catch(error){if(stopped)return;diagnosticWarning('discovery.ip_recheck',error,{printerId:saved.id,operation:reason})}
            }
          }
        };
        await Promise.all([worker(),worker()]);
        if(availableCandidates.length)addressProbeCursor.current=(start+processed)%availableCandidates.length;
        if(stopped||revision!==printerSaveRevision.current||configurationKey!==printerAddressConfigurationKey(printersRef.current))return;
        const previous=addressEvidenceRef.current;
        const observedAddresses=new Set(observations.map(value=>printerAddressKey(value.host)));
        // A partial scan cannot invalidate previously confirmed untouched
        // addresses. Positive contradictory evidence always replaces old data.
        const retained=(result.timed_out||result.cancelled||proofIncomplete)&&previous?.configurationKey===configurationKey?previous.observations.filter(value=>!observedAddresses.has(printerAddressKey(value.host))):[];
        const currentObservations=[...retained,...observations];
        const plan=planPrinterAddressRecovery(original,currentObservations);
        setAddressEvidence({configurationKey,observations:currentObservations,checkedAt:Date.now()});
        if(!plan.assignments.length&&!plan.learnedIdentities.length)return;
        const learnedById=new Map(plan.learnedIdentities.map(value=>[value.printerId,value.identity]));
        const byId=new Map(plan.assignments.map(value=>[value.printerId,value]));
        const changing=new Set(plan.assignments.map(value=>value.printerId));
        for(const id of changing){clients.current.get(id)?.disconnect();clients.current.delete(id)}
        await suspendAddressActors(changing);
        if(stopped||revision!==printerSaveRevision.current)return;
        const next=printersRef.current.map(printer=>{
          const assignment=byId.get(printer.id);
          return assignment?{...printer,host:assignment.host,deviceIdentity:refreshDeviceIdentityEvidence(printer.deviceIdentity,assignment.identity),status:{...emptyStatus,connectionProtocol:assignment.protocol,connectionPort:assignment.port,connectionMessage:'Актуальный IP подтверждён по физическому принтеру'},webcams:[]}:learnedById.has(printer.id)?{...printer,deviceIdentity:learnedById.get(printer.id)}:printer;
        });
        // One committed snapshot handles swaps and three-way collisions without
        // letting the first candidate overwrite another printer's ownership.
        await save(next,revision);
        setAddressEvidence({configurationKey:printerAddressConfigurationKey(next),observations:currentObservations,checkedAt:Date.now()});
        for(const assignment of plan.assignments){const before=original.find(printer=>printer.id===assignment.printerId);if(before)void audit('printer.ip_changed',`${before.name} · ${before.host} → ${assignment.host} · physical identity confirmed`)}

      }catch(error){
        if(!/\bDISCOVERY_BUSY\b/i.test(String(error)))diagnosticWarning('discovery.background',error,{operation:reason});
      }finally{discoveryRecheckInFlight.current=false;discoveryRecheckOperation.current=undefined}
    };
    const markNetworkTransition=(reason:'resume'|'network')=>{
      if(Date.now()-lastTransitionAt<5_000)return;
      lastTransitionAt=Date.now();
      const staleAt=Date.now()-21_000;
      const next=printersRef.current.map(printer=>({...printer,status:{...printer.status,connectionState:'connecting' as const,connectionReason:'connecting' as const,connectionMessage:reason==='resume'?'Windows вышла из сна · проверяем сохранённый принтер':'Сеть изменилась · проверяем сохранённый принтер',telemetryUpdatedAt:printer.status.telemetryUpdatedAt===undefined?undefined:Math.min(printer.status.telemetryUpdatedAt,staleAt),jobUpdatedAt:printer.status.jobUpdatedAt===undefined?undefined:Math.min(printer.status.jobUpdatedAt,staleAt)}}));
      printersRef.current=next;setPrinters(next);
      clients.current.forEach(client=>void client.reconnect().catch(()=>{}));
      void run(reason);
    };
    const pollNetwork=async()=>{
      const before=Date.now(),gap=before-networkHeartbeat.current;
      networkPolling=true;
      try{
        const snapshot=await secureInvoke<NetworkEnvironmentSnapshot>('network_environment_snapshot',{});
        if(stopped)return;
        if(networkFingerprint.current&&networkFingerprint.current!==snapshot.fingerprint){networkFingerprint.current=snapshot.fingerprint;markNetworkTransition('network')}
        else networkFingerprint.current=snapshot.fingerprint;
        if(gap>10_000)markNetworkTransition('resume');
      }catch(error){if(!stopped)diagnosticWarning('network.snapshot',error,{operation:'network.watch'})}
      finally{networkPolling=false;networkHeartbeat.current=Date.now();if(!stopped)networkTimer=window.setTimeout(pollNetwork,2_500)}
    };
    const schedule=()=>{timer=window.setTimeout(async()=>{await run('periodic');if(!stopped)schedule()},addressPlanRef.current.blockedIds.size?30_000:90_000)};
    const immediate=addressPlanRef.current.blockedIds.size>0||printersRef.current.some(printer=>hasStrongPrinterIdentity(printer.deviceIdentity));
    timer=window.setTimeout(async()=>{await run(immediate?'address':'startup');if(!stopped)schedule()},immediate?0:15_000);
    networkTimer=window.setTimeout(pollNetwork,250);
    const resume=()=>{if(!networkPolling&&!document.hidden&&Date.now()-networkHeartbeat.current>10_000)markNetworkTransition('resume')};
    const addressRecheck=()=>void run('address');
    window.addEventListener('klipper-printer-address-recheck',addressRecheck);
    window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',resume);
    return()=>{stopped=true;if(timer)window.clearTimeout(timer);if(networkTimer)window.clearTimeout(networkTimer);if(addressRetry!==undefined)window.clearTimeout(addressRetry);const operationId=discoveryRecheckOperation.current;if(operationId)void secureInvoke<boolean>('cancel_moonraker_discovery',{operationId}).catch(()=>false);window.removeEventListener('klipper-printer-address-recheck',addressRecheck);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',resume)};
  },[isAdmin,printerConfigReady,showDiscovery,addressConfigurationKey]);
  const updateConfig=async(cfg:PrinterConfig)=>{
    const submittedKey=cfg.apiKey?.trim(),credentialChanged=!!submittedKey;
    if(submittedKey){await secretSet(cfg.id,submittedKey);cfg={...cfg,apiKey:undefined,apiKeyStored:true}}
    else cfg={...cfg,apiKey:undefined};
    const next=printersRef.current.map(p=>p.id===cfg.id?{...p,...cfg,apiKey:undefined}:p);
    const previous=printersRef.current.find(printer=>printer.id===cfg.id);
    await save(next);
    const updated=next.find(p=>p.id===cfg.id),client=clients.current.get(cfg.id);
    const physicalAddressChanged=!!previous&&printerAddressKey(previous.host)!==printerAddressKey(cfg.host);
    if(physicalAddressChanged&&hasStrongPrinterIdentity(cfg.deviceIdentity)){
      setAddressVerificationPending(current=>new Set([...current,cfg.id]));
      client?.disconnect();clients.current.delete(cfg.id);
      await suspendAddressActors(new Set([cfg.id]));
      return;
    }
    if(updated&&client&&!planPrinterAddressRecovery(next,[]).blockedIds.has(cfg.id)){
      // Compare the actual client before replacing it. The connection effect
      // may already have applied the committed configuration.
      const storedCredentialChanged=!!client.config.apiKeyStored!==!!updated.apiKeyStored;
      const endpointChanged=!samePrinterEndpoint(client.config.host,updated.host);
      const operationalModelChanged=operationalModelId(client.config)!==operationalModelId(updated);
      client.config=updated;
      if(credentialChanged||storedCredentialChanged)client.resetAuthorizationBackoff();
      if(credentialChanged||storedCredentialChanged||endpointChanged||operationalModelChanged)client.reconnect().then(()=>client.webcams()).then(webcams=>{
        if(clients.current.get(cfg.id)===client&&samePrinterEndpoint(client.config.host,updated.host))setPrinters(xs=>xs.map(x=>x.id===cfg.id?{...x,webcams}:x));
      }).catch(()=>{});
    }
  };
  const automaticRefreshKey=printers.map(p=>`${p.id}:${p.host}:${p.modelSelection?.mode??'legacy'}:${p.modelSelection?.lastDetection?.engineVersion??0}:${p.modelSelection?.updatedAt??0}`).join('|');
  useEffect(()=>{
    if(!isAdmin||!printerConfigReady)return;
    let cancelled=false;
    const timer=window.setTimeout(async()=>{
      const refreshStarted=Date.now(),revision=printerSaveRevision.current;
      const stale=printersRef.current.filter(p=>{
        const selection=p.modelSelection;
        if(selection?.mode!=='automatic')return false;
        const report=selection.lastDetection;
        if(!report||report.engineVersion!==PRINTER_DETECTION_ENGINE_VERSION)return true;
        const incomplete=selection.selectedPreset==='custom'||report.decision!=='confirmed'||!!selection.confirmationRequired;
        const interval=incomplete?INCOMPLETE_MODEL_RETRY_MS:AUTOMATIC_MODEL_REFRESH_MS;
        return refreshStarted-(selection.updatedAt??0)>=interval;
      });
      if(!stale.length)return;
      const reports=new Map<string,{detected:Awaited<ReturnType<MoonrakerClient['detect']>>;endpoint:string}>();
      // One worker keeps startup traffic bounded even for a large farm.
      for(const printer of stale){
        if(cancelled)return;
        try{reports.set(printer.id,{detected:await (clients.current.get(printer.id)??new MoonrakerClient({...printer})).detect(),endpoint:printer.host})}
        catch(error){diagnosticWarning('model.refresh',error,{printerId:printer.id,operation:'detect'})}
      }
      if(cancelled||!reports.size||revision!==printerSaveRevision.current)return;
      const next=printersRef.current.map(printer=>{
        const report=reports.get(printer.id);
        if(!report||printer.modelSelection?.mode!=='automatic'||!samePrinterEndpoint(printer.host,report.endpoint))return printer;
        const safelyUpdated=applyModelDetection(printer,report.detected);
        return {...printer,...safelyUpdated};
      });
      if(cancelled)return;
      try{await save(next)}catch{return}
      for(const printer of next){
        if(reports.has(printer.id)){
          const client=clients.current.get(printer.id);
          if(client){
            const operationalModelChanged=operationalModelId(client.config)!==operationalModelId(printer);
            client.config=printer;
            if(operationalModelChanged)client.reconnect().then(()=>client.webcams()).then(webcams=>{
              if(clients.current.get(printer.id)===client&&samePrinterEndpoint(client.config.host,printer.host))setPrinters(xs=>xs.map(item=>item.id===printer.id?{...item,webcams}:item));
            }).catch(error=>diagnosticWarning('printer.reconnect',error,{printerId:printer.id,operation:'model.refresh'}));
          }
        }
      }
    },5_000);
    return()=>{cancelled=true;window.clearTimeout(timer)};
  },[isAdmin,printerConfigReady,automaticRefreshKey]);
  const confirmDiscoveredIpChange=async(row:IdentifiedDiscoveredPrinter,existing?:PrinterModel)=>{
    if(!existing||samePrinterEndpoint(existing.host,row.host))return true;
    const identity=row.deviceIdentity??row.detection?.deviceIdentity;
    const stableId=identity?.stableId??row.stable_id??'не подтверждён';
    const model=automaticName(row,detectedPreset(row));
    return appConfirm(
      `Подтвердите изменение адреса:\n\n${printerHostDisplay(existing.host)} → ${printerHostDisplay(row.host)}\n\nМодель: ${model}\nStable ID: ${stableId}`,
      {title:'Принтер сменил IP-адрес',confirmLabel:'Обновить адрес',cancelLabel:'Оставить старый'}
    );
  };
  const addDiscovered=async(row:IdentifiedDiscoveredPrinter)=>{
    if(printerConfigSaveInFlight.current)throw new Error('Настройки принтеров уже сохраняются. Дождитесь завершения и повторите сохранение.');
    if(!row.moonraker_confirmed)throw new Error('Устройство ответило по HTTP, но Moonraker не подтверждён');
    if(row.auth_required)throw new Error('Сначала введите и проверьте API Key Moonraker');
    if(row.identity_conflict&&!row.identityConflictAccepted)throw new Error('Конфликт Stable ID/IP требует явного выбора строки');
    const current=printersRef.current,revision=printerSaveRevision.current;
    const existing=existingForDiscovery(current,row);
    if(!await confirmDiscoveredIpChange(row,existing))return false;
    const probable=discoveryDecision(row)==='probable';
    const confirmed=!probable||await appConfirm(`Предполагаемая модель — ${automaticName(row,detectedPreset(row))}. Применить этот профиль?`,{title:'Требуется подтверждение модели',confirmLabel:'Применить профиль',cancelLabel:'Оставить универсальный'});
    let configured=discoveredConfig(row,current.map(printer=>printer.name),confirmed&&probable,existing);
    if(row.apiKeyForAdd){
      await secretSet(configured.id,row.apiKeyForAdd);
      configured={...configured,apiKey:undefined,apiKeyStored:true};
    }
    const next=existing?current.map(printer=>printer.id===existing.id?configured:printer):[...current,configured];
    await save(next,revision);
    return true;
  };
  const addAllDiscovered=async(rows:IdentifiedDiscoveredPrinter[])=>{
    if(printerConfigSaveInFlight.current)throw new Error('Настройки принтеров уже сохраняются. Дождитесь завершения и повторите сохранение.');
    if(rows.some(row=>!row.moonraker_confirmed))throw new Error('Добавлять можно только устройства с подтверждённым Moonraker');
    if(rows.some(row=>row.auth_required))throw new Error('Принтер с обязательным API Key нельзя добавить без проверки ключа');
    if(rows.some(row=>row.identity_conflict&&!row.identityConflictAccepted))throw new Error('Сначала разрешите каждый конфликт Stable ID/IP отдельно');
    const revision=printerSaveRevision.current;
    let next=printersRef.current.slice();
    for(const row of rows){
      const existing=existingForDiscovery(next,row);
      if(!await confirmDiscoveredIpChange(row,existing))return false;
    }
    const names=next.map(printer=>printer.name);
    for(const row of rows){
      const existing=existingForDiscovery(next,row);
      let configured=discoveredConfig(row,names,false,existing);
      if(row.apiKeyForAdd){
        await secretSet(configured.id,row.apiKeyForAdd);
        configured={...configured,apiKey:undefined,apiKeyStored:true};
      }
      next=existing?next.map(printer=>printer.id===existing.id?configured:printer):[...next,configured];
    }
    await save(next,revision);
    return true;
  };
  const remove=async(id:string)=>{
    if(!await appConfirm('Удалить принтер из Klipper Farm?',{title:'Удаление принтера',confirmLabel:'Удалить',danger:true}))return;
    const printer=printersRef.current.find(item=>item.id===id);
    const stableId=printer?.deviceIdentity?.dedupeSafe?printer.deviceIdentity.stableId:id;
    const next=printersRef.current.filter(item=>item.id!==id);
    try{await save(next)}catch(error){await appAlert(String(error),{title:'Не удалось удалить принтер'});return}
    clients.current.get(id)?.disconnect();
    clients.current.delete(id);
    setSelected(current=>current===id?undefined:current);
    setCamera(current=>current===id?undefined:current);
    setSettings(current=>current===id?undefined:current);
    setFilesPrinterId(current=>current===id?undefined:current);
    void printerActorRemove(stableId).catch(error=>diagnosticWarning('printer.actor.remove',error,{printerId:id}));
    void secretDelete(id).catch(error=>diagnosticWarning('credentials.delete',error,{printerId:id}));
  };
  const scan=()=>{if(isAdmin)setShowDiscovery(true)};
  const action=async(id:string,a:string)=>{if(!canOperate)return;const c=clients.current.get(id),printer=printersRef.current.find(item=>item.id===id);if(!c)return;try{if(a==='reconnect')await c.reconnect();if(a==='pause')await c.pause();if(a==='resume')await c.resume();if(a==='cancel'&&await appConfirm('Отменить текущую печать?',{title:'Отмена печати',confirmLabel:'Отменить печать',danger:true})){const filename=printer?.status.filename||'Неизвестное задание';cancelledPrints.current.set(id,{filename,ts:Date.now()});try{await c.cancel();if(printer){await audit('print.cancelled',`${printer.name} · ${filename}`);recordPrint(printer,'cancelled',filename)}}catch(error){cancelledPrints.current.delete(id);throw error}}if(a==='estop')await c.emergencyStop()}catch(error){diagnosticError('printer.action',error,{printerId:id,operation:a});await appAlert(String(error),{title:'Команда не выполнена'})}};
  const selectedPrinter=useMemo(()=>printers.find(p=>p.id===selected),[printers,selected]);
  const cameraPrinter=useMemo(()=>printers.find(p=>p.id===camera),[printers,camera]);
  const settingsPrinter=useMemo(()=>printers.find(p=>p.id===settings),[printers,settings]);
  const filesPrinter=useMemo(()=>printers.find(p=>p.id===filesPrinterId),[printers,filesPrinterId]);
  const {online,printing}=useMemo(()=>({
    online:printers.filter(p=>printerIsReachable(p.status)).length,
    printing:printers.filter(p=>printerHasActiveJob(p.status)).length
  }),[printers]);
  const attentionCount=useMemo(()=>printers.filter(p=>!p.status.remoteControlSuspended&&(p.status.connectionState==='offline'||p.status.connectionState==='degraded'||p.status.state==='error')).length,[printers]);
  const loadPercent=printers.length?Math.round(printing/printers.length*100):0;
  const networkStatus=useMemo(()=>offlineFirstStatus(internetAvailable,online,printers.length),[internetAvailable,online,printers.length]);
  const navigate=(destination:MainPage)=>{
    setQueue(false);setAnalytics(false);setProduction(false);setSystem(false);
    setDispatch(false);setMaintenance(false);setHealth(false);setTv(false);setCameraGuardOpen(false);
    setSelected(undefined);setCamera(undefined);setSettings(undefined);setFilesPrinterId(undefined);setShowDiscovery(false);
    setPage(destination);
    if(destination==='queue')setQueue(true);
    if(destination==='files')setProduction(true);
    if(destination==='history'||destination==='stats')setAnalytics(true);
    if(destination==='settings'&&isAdmin)setSystem(true);
  };
  const openVoiceTarget=(target:string,printerId?:string):boolean|void=>{
    const closeOverlays=()=>{setQueue(false);setAnalytics(false);setDispatch(false);setMaintenance(false);setHealth(false);setTv(false);setCameraGuardOpen(false);setSystem(false);setSelected(undefined);setCamera(undefined);setSettings(undefined);setShowDiscovery(false)};
    if(target==='dashboard'){closeOverlays();setFilesPrinterId(undefined);setPage('dashboard');return}
    if(target==='printers'){closeOverlays();setFilesPrinterId(undefined);setPage('printers');return}
    if(target==='tools'){closeOverlays();setFilesPrinterId(undefined);setPage('tools');return}
    if(target==='queue'){closeOverlays();setFilesPrinterId(undefined);setPage('queue');setQueue(true);return}
    if(target==='files'){closeOverlays();setFilesPrinterId(undefined);setPage('files');setProductionTab('library');setProduction(true);return}
    if(target==='history'){closeOverlays();setFilesPrinterId(undefined);setPage('history');setAnalytics(true);return}
    if(target==='settings'){if(!isAdmin)return false;closeOverlays();setFilesPrinterId(undefined);setPage('settings');setSystem(true);return}
    if(target==='spools'){closeOverlays();setFilesPrinterId(undefined);setPage('files');setProductionTab('spools');setProduction(true);return}
    if(target==='tv'){if(!canOperate)return false;closeOverlays();setFilesPrinterId(undefined);setPage('dashboard');setTv(true);return}
    if(target==='assistant'){setVoiceAssistantOpen(true);return}
    if(target==='camera-guard'){if(!canOperate)return false;closeOverlays();setFilesPrinterId(undefined);setPage('dashboard');setCameraGuardOpen(true);return}
    if(target==='flash'){const id=printerId??filesPrinterId;if(!id||!printersRef.current.some(x=>x.id===id))return false;closeOverlays();setFilesPrinterId(id);return}
    return false;
  };
  const pageMeta={
    dashboard:{title:'Панель фермы',subtitle:'Состояние всех принтеров и статистика за 30 дней'},
    printers:{title:'Принтеры',subtitle:'Подключение, управление и параметры оборудования'},
    tools:{title:'Инструменты',subtitle:'Поиск, обслуживание и автоматизация фермы'},
    queue:{title:'Очередь',subtitle:'Порядок и распределение заданий'},
    files:{title:'Файлы и производство',subtitle:'Библиотека, пластик и планирование печати'},
    history:{title:'История',subtitle:'Результаты печати и отчёты фермы'},
    stats:{title:'Статистика',subtitle:'Загрузка, расход и эффективность'},
    settings:{title:'Настройки',subtitle:'Пользователи, безопасность и приложение'},
  }[page];

  if(setup&&printerConfigReady&&!printerConfigError)return <SetupWizard onFinish={()=>setSetup(false)} onAdd={async cfg=>{if(cfg.apiKey){await secretSet(cfg.id,cfg.apiKey);cfg={...cfg,apiKey:undefined,apiKeyStored:true}}await save([...printersRef.current,{...cfg,status:{...emptyStatus},webcams:[]}])}}/>;

  return <div className={`kfShell ${page==='dashboard'?'dashboardShell':''}`}>
    {isTauri&&<div className="kfWindowBar" data-tauri-drag-region>
      <span data-tauri-drag-region>Klipper Farm</span>
      <div className="kfWindowControls" aria-label="Управление окном">
        <button title="Свернуть" aria-label="Свернуть окно" onClick={minimizeWindow}><Minus/></button>
        <button className="close" title="Закрыть" aria-label="Закрыть окно" onClick={closeWindow}><X/></button>
      </div>
    </div>}
    <aside className="kfSidebar">
      <div className="kfBrand"><div className="kfLogo"><img src={brandMark} alt="Klipper Farm"/></div><b>KLIPPER FARM</b></div>
      <nav>
        <button className={page==='dashboard'?'active':''} onClick={()=>navigate('dashboard')}><LayoutDashboard/>Панель</button>
        <button className={page==='printers'?'active':''} onClick={()=>navigate('printers')}><Printer/>Принтеры</button>
        <button className={page==='tools'?'active':''} onClick={()=>navigate('tools')}><Wrench/>Инструменты</button>
        <button type="button" className={voiceAssistantOpen?'active':''} aria-label="Голосовой помощник" title="Голосовой помощник · без интернета" onClick={()=>setVoiceAssistantOpen(value=>!value)}><Bot/>Помощник</button>
        <button className={page==='queue'?'active':''} onClick={()=>navigate('queue')}><ListOrdered/>Очередь</button>
        <button className={page==='files'?'active':''} onClick={()=>navigate('files')}><Factory/>Файлы</button>
        <button className={page==='history'?'active':''} onClick={()=>navigate('history')}><BarChart3/>История</button>
        {isAdmin&&<button className={page==='settings'?'active':''} onClick={()=>navigate('settings')}><Shield/>Настройки</button>}
      </nav>
      <div className="kfSidebarUtilities" aria-label="Оформление и уведомления">
        <div className="kfThemeSwitch kfSidebarTheme" role="group" aria-label="Оформление">
          <button className={theme==='light'?'active':''} title="Светлая тема" aria-label="Светлая тема" aria-pressed={theme==='light'} onClick={()=>setTheme('light')}><Sun/><span>Светлая</span></button>
          <button className={theme==='dark'?'active':''} title="Тёмная тема" aria-label="Тёмная тема" aria-pressed={theme==='dark'} onClick={()=>setTheme('dark')}><Moon/><span>Тёмная</span></button>
        </div>
        <NotificationCenter printers={printers} userId={session.user.id} onOpenPrinter={setSelected}/>
      </div>
    </aside>

    <main className={`kfMain ${page==='dashboard'?'dashboardMain':''} ${page==='printers'?'printersMain':''}`}>
      <header className="kfTopbar">
        <div className="kfPageIdentity"><span className={`kfCyberEyebrow mode-${networkStatus.mode} ${online?'farmOnline':''}`} title={networkStatus.detail} aria-live="polite">{networkStatus.label}</span><h1>{pageMeta.title}</h1><p>{pageMeta.subtitle}</p></div>
        {page==='dashboard'&&<div className="dashboardTopSummary" aria-label="Сводка фермы">
          <article className="online"><i><CheckCircle2/></i><span>В сети</span><strong>{online} из {printers.length}</strong></article>
          <article className="printing"><i><Printer/></i><span>Печатают</span><strong>{printing}</strong></article>
          <article className={attentionCount?'attention':'healthy'}><i>{attentionCount?<AlertTriangle/>:<CheckCircle2/>}</i><span>Требует внимания</span><strong>{attentionCount}</strong></article>
          <article className="load"><i><Gauge/></i><span>Загрузка</span><strong>{loadPercent}%</strong></article>
        </div>}
      </header>

      {printerConfigError&&<div className="kfEngineNotice failed" role="alert"><AlertTriangle/><div><b>Настройки принтеров требуют внимания</b><span>{printerConfigError}</span></div></div>}

      {(engineRuntime.status==='failed'||engineRuntime.status==='embeddedFallback')&&<div className={`kfEngineNotice ${engineRuntime.status==='failed'?'failed':'fallback'}`} role="status">
        <AlertTriangle/>
        <div><b>{engineRuntime.status==='failed'?'Модуль связи восстанавливается':'Включён резервный движок связи'}</b><span>{engineRuntime.status==='failed'?'Ожидаем klipper-farmd; принтеры автоматически переключатся на защищённый встроенный движок.':'klipper-farmd не запустился, но локальная связь с принтерами продолжает работать через то же single-owner ядро.'}{engineRuntimeDetail?` Причина: ${engineRuntimeDetail}`:''}</span></div>
      </div>}

      {page==='dashboard'&&<FleetDashboard printers={printers} clients={clients.current} onOpen={setSelected} onPrinters={()=>navigate('printers')} onScan={scan} onReports={()=>navigate('history')} canOperate={canOperate} onWarehouse={()=>{navigate('files');setProductionTab('spools');setProduction(true)}}/>}

      {page==='printers'&&<PrintersPage printers={printers} canOperate={canOperate} onAction={action} onOpen={setSelected} onCamera={setCamera} onFiles={setFilesPrinterId}
        onSettings={isAdmin?setSettings:undefined} onRemove={isAdmin?remove:undefined} onWarehouse={()=>{navigate('files');setProductionTab('spools');setProduction(true)}}/>}

      {page==='printers'&&!printers.length&&<div className="kfEmpty"><Printer size={64}/><h2>Добавьте первый принтер</h2><button onClick={scan}><Radar/>Найти в сети</button></div>}

      {page==='tools'&&<section className="kfToolsPage">
        <button disabled={!isAdmin} onClick={scan}><span><Radar/></span><div><b>Найти принтеры</b><small>Автоматический поиск Moonraker в локальной сети</small></div></button>
        <button disabled={!canOperate} onClick={()=>{setPage('queue');setQueue(true)}}><span><ListOrdered/></span><div><b>Очередь</b><small>Загрузка и порядок заданий для всех принтеров</small></div></button>
        <button disabled={!canOperate} onClick={()=>setDispatch(true)}><span><Bot/></span><div><b>Диспетчер</b><small>Автоматическое распределение печати по ферме</small></div></button>
        <button disabled={!canOperate} onClick={()=>{setPage('files');setProductionTab('library');setProduction(true)}}><span><Factory/></span><div><b>Производство</b><small>G-code, расписание, катушки и себестоимость</small></div></button>
        <button onClick={()=>{setPage('files');setProductionTab('spools');setProduction(true)}}><span><Package/></span><div><b>Пластик</b><small>Запас по материалам, расход принтеров и резерв</small></div></button>
        <button disabled={!canOperate} onClick={()=>setMaintenance(true)}><span><Wrench/></span><div><b>Обслуживание</b><small>Сопло, оси, ремни и регламент Ender-3 V3 KE</small></div></button>
        <button onClick={()=>setHealth(true)}><span><Shield/></span><div><b>Самодиагностика</b><small>Moonraker, Klipper, MCU, нагреватели, камера и конфигурация</small></div></button>
        <button onClick={()=>setTv(true)}><span><MonitorUp/></span><div><b>TV-панель</b><small>Полноэкранный мониторинг состояния фермы</small></div></button>
        <button disabled={!canOperate} onClick={()=>setCameraGuardOpen(true)}><span><Shield/></span><div><b>Контроль камеры</b><small>Распознавание «каши», уведомления и автопауза</small></div></button>
      </section>}
    {production&&<ProductionPanel embedded printers={printers} clients={clients.current} canOperate={canOperate} initialTab={productionTab} onClose={()=>navigate('dashboard')}/>}
    </main>

    <VoiceAssistantPanel userId={session.user.id} printers={printers} clients={clients.current} canOperate={canOperate} open={voiceAssistantOpen} onClose={()=>setVoiceAssistantOpen(false)} onOpenCamera={id=>{if(!printersRef.current.some(p=>p.id===id))return false;setCamera(id);return true}} onNavigate={openVoiceTarget}/>
    <NotificationToastHost/>
    {canOperate&&printerConfigReady&&<CameraGuardHost printers={printers} clients={clients.current} controller={cameraGuardController}/>}
    {selectedPrinter&&<ControlPanel
      printer={selectedPrinter}
      client={clients.current.get(selectedPrinter.id)}
      onClose={()=>setSelected(undefined)}
      onNavigate={destination=>navigate(destination)}
      onSettings={isAdmin?()=>{
        setSelected(undefined);
        setSettings(selectedPrinter.id);
      }:undefined}
    />}
    {cameraPrinter&&<CameraModal printer={cameraPrinter} aboveAssistant={voiceAssistantOpen} onClose={()=>setCamera(undefined)}/>}
    {filesPrinter&&<PrinterFilesPanel printer={filesPrinter} printers={printers} client={clients.current.get(filesPrinter.id)} canOperate={canOperate} onClose={()=>setFilesPrinterId(undefined)} onSettings={isAdmin?()=>{setFilesPrinterId(undefined);setSettings(filesPrinter.id)}:undefined}/>}
    {queue&&<QueuePanel printers={printers} clients={clients.current} canOperate={canOperate} onClose={()=>navigate('dashboard')}/>}
    {settingsPrinter&&isAdmin&&<PrinterSettings printer={settingsPrinter} onSave={updateConfig} onDelete={()=>remove(settingsPrinter.id)} onClose={()=>setSettings(undefined)}/>}
    {analytics&&<AnalyticsPanel printers={printers} clients={clients.current} onClose={()=>navigate('dashboard')}/>}
    {dispatch&&<AutoDispatchPanel printers={printers} clients={clients.current} onClose={()=>setDispatch(false)}/>}
    {maintenance&&<MaintenancePanel printers={printers} controller={maintenanceController} onClose={()=>setMaintenance(false)}/>}
    {health&&<FleetHealthPanel printers={printers} clients={clients.current} onClose={()=>setHealth(false)}/>}
    {tv&&<TvDashboard printers={printers} maintenance={maintenanceController.state} cameraWatch={cameraGuardController.statuses} onOpenCameraWatch={canOperate?()=>{setTv(false);setCameraGuardOpen(true)}:undefined} onClose={()=>setTv(false)}/>}
    {cameraGuardOpen&&<CameraGuardPanel printers={printers} controller={cameraGuardController} canOperate={canOperate} onClose={()=>setCameraGuardOpen(false)}/>}
    {system&&isAdmin&&<SystemPanel currentUserId={session.user.id} onClose={()=>navigate('dashboard')} onLogout={onLogout} printing={printers.some(p=>printerBlocksUpdate(p.status))}/>}
    {isAdmin&&<DiscoveryPanel open={showDiscovery} printers={printers} onClose={()=>setShowDiscovery(false)} onAdd={addDiscovered} onAddAll={addAllDiscovered}/>}
  </div>
}

export default function App(){
 useEffect(()=>installNotificationSound(),[]);
 const [session,setSession]=useState<AuthSession>(),[needsSetup,setNeedsSetup]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{getAuthStatus().then(status=>setNeedsSetup(status.needsSetup)).catch(value=>setError(String(value))).finally(()=>setLoading(false))},[]);
 useEffect(()=>{const expired=()=>{setAuthSession();setSession(undefined)};window.addEventListener('klipper-auth-required',expired);return()=>window.removeEventListener('klipper-auth-required',expired)},[]);
 const authenticated=(value:AuthSession)=>{setAuthSession(value);setSession(value)};
 const signOut=()=>{logout().finally(()=>setSession(undefined))};
 if(loading)return <main className="authScreen"><section className="authCard"><h1>Klipper Farm</h1><p>Проверка защищённого профиля…</p></section></main>;
 if(error)return <main className="authScreen"><section className="authCard"><h1>Ошибка запуска</h1><div className="authError">{error}</div></section></main>;
 if(!session)return <LoginPanel needsSetup={needsSetup} onAuthenticated={authenticated}/>;
 return <FarmApp session={session} onLogout={signOut}/>;
}
