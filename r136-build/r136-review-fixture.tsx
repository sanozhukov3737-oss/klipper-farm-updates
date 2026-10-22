// Actual FarmApp and MoonrakerClient. Only authenticated native IPC is emulated.
import {createRoot} from 'react-dom/client';
import {FarmApp} from '../src/App';
import {setAuthSession} from '../src/lib/auth';
import {I18nProvider} from '../src/i18n';
import {AppDialogHost} from '../src/lib/appDialogs';
import {profileForPreset,iconForPreset} from '../src/lib/printerProfile';
import {validateGCodeContent} from '../src/lib/gcodeValidation';
import {createR126FilesNative} from './r126-files-native';
import type {PrinterConfig} from '../src/types';

const fixture=window as any;
const params=new URLSearchParams(location.search),mode=params.get('mode')??'normal',r126=params.get('r126');
const fileFixture=params.has('files')?createR126FilesNative(params.get('files')!):undefined;
const dbKey='r125-fixture-native-database'+(r126?'-r126-'+r126:'');
const presets=['ender3-v3-ke','ender3-v3-ke','ender3-v3-ke','ender3-v3-ke','creality-k1c-2025','creality-k1-max','ender3-v3-ke'] as const;
const names=['Ender-3 V3 KE 01','Ender-3 V3 KE 02','Ender-3 V3 KE 03','Ender-3 V3 KE 04','Creality K1C','Creality K1 Max','Ender-3 V3 KE 07'];
const seed:PrinterConfig[]=presets.map((preset,index)=>({id:`printer-${index+1}`,name:names[index],host:`192.168.77.${101+index}:7125`,icon:'ender',nameSource:'automatic',catalogModelId:index===6?'flashforge-adventurer-5m':undefined,profile:{preset,bedX:220,bedY:220,maxZ:250,nozzle:.4,materials:['PLA']},modelSelection:{mode:'manual',selectedPreset:preset,source:'manual'}}));
if(r126){
 for(const printer of seed){
  printer.profile=profileForPreset(printer.profile!.preset);printer.icon=iconForPreset(printer.profile.preset);
  printer.apiKeyStored=true;printer.tags=['Участок '+printer.id];printer.accent='#7654ab';
  printer.deviceIdentity={version:1,stableId:'hardware:'+printer.id,strength:'hardware',dedupeSafe:true,observedAt:123,signals:{machineId:'board:'+printer.id}};
  printer.configSnapshot={version:2,capturedAt:123,fingerprint:'original:'+printer.id,facts:{identity:{machineId:'board:'+printer.id}}};
 }
 const target=seed[6];target.name='У окна — PETG';target.nameSource='custom';
 target.profile={...target.profile!,nozzle:.6,priority:7,materials:['PETG','PLA']};
 if(r126.startsWith('select'))target.catalogModelId=undefined;
 if(r126==='select-automatic'){target.name='Creality Ender-3 V3 KE 07';target.nameSource='automatic'}
 if(r126==='select-custom-alias')target.name='AD5M';
 if(r126==='geometry'||r126==='driver'){
  target.profile={...profileForPreset('flashforge-ad5m'),nozzle:.6,priority:7,materials:['PETG','PLA']};
  if(r126==='geometry')target.profile={...target.profile,xMin:0,xMax:220,yMin:0,yMax:220,maxZ:240};
  target.modelSelection={mode:'manual',selectedPreset:r126==='driver'?'ender3-v3-ke':'flashforge-ad5m',source:'legacy'};
 }
}
if(r126==='wizard')seed.length=0;
if(fileFixture){seed[6].profile=profileForPreset('flashforge-ad5m');seed[6].icon=iconForPreset('flashforge-ad5m');seed[6].modelSelection={mode:'manual',selectedPreset:'flashforge-ad5m',source:'manual'}}
if(mode==='automatic-refresh'){
 seed[1]={...seed[1],profile:{...seed[1].profile!,preset:'custom'},modelSelection:{mode:'automatic',selectedPreset:'custom',source:'automatic',updatedAt:0}};
}
// Seed only once: a reload must use the database/cache left by the actual app.
if(localStorage.getItem(dbKey)===null){
 localStorage.setItem(dbKey,JSON.stringify({'printers.config':seed,...(fileFixture?{[fileFixture.cacheKey]:fileFixture.originalCache}:{})}));
 // Deliberately include old telemetry in the legacy cache. FarmApp must rebuild
 // runtime state rather than displaying a remembered 399°C as live telemetry.
 localStorage.setItem('printers',JSON.stringify(seed.map(printer=>({...printer,status:{state:'printing',connectionState:'online',nozzle:399,bed:99,telemetryUpdatedAt:Date.now(),jobUpdatedAt:Date.now(),filename:'cache-is-not-live.gcode'},webcams:[]}))));
}
if(r126==='wizard')localStorage.removeItem('klipper-setup-v07');else localStorage.setItem('klipper-setup-v07','done');
localStorage.setItem('klipper-productivity-theme-v2','dark');
let database=JSON.parse(localStorage.getItem(dbKey)!);

// Preview data only; this file is not part of the application patch.
if(params.has('r136')&&!database['production.cost']){
 database['production.cost']={electricityPerKwh:6.5,printerWatts:250,laborPerHour:0,currency:'рубли'};
 database['production.spools']=[{id:'preview-priced-spool',name:'PETG',material:'PETG',color:'#438eaf',initialWeight:1000,remainingWeight:625,price:1475,currency:'рубли',createdAt:1700000000000}];
 const files=Array.from({length:8},(_,i)=>({printerId:'printer-6',printerName:'Creality K1 Max',path:`preview/Деталь-${i+1}.gcode`,metadata:{estimated_time:43200,filament_weight_total:460,filament_type:'PETG'}}));
 database['production.libraryCache']={version:1,printers:{'printer-6':{updatedAt:Date.now(),files}}};
 localStorage.setItem(dbKey,JSON.stringify(database));
}

let configReadFails=mode==='read-failure';
let stage:'stale'|'fresh'=r126==='wizard'||r126==='discovery'||fileFixture?'fresh':'stale',nativeEpoch=49,temperature=220;
let regressionSnapshot=false,regressionPolls=0;
let automaticWriteGateUsed=false,heldConfigWrite:{configs:PrinterConfig[];at:number}|undefined,releaseConfigWrite:(()=>void)|undefined;
let holdNextConfigWrite=false,failNextConfigWrite=false;
const credentialKey=dbKey+'-credentials';
if(r126&&localStorage.getItem(credentialKey)===null)localStorage.setItem(credentialKey,JSON.stringify(Object.fromEntries(seed.map(printer=>[printer.id,'fixture-only-key-'+printer.id]))));
const credentials=JSON.parse(localStorage.getItem(credentialKey)??'{}');
let nextCallback=0,nextListener=0;
const callbacks=new Map<number,(event:any)=>void>(),listeners=new Map<number,{event:string;handler:number}>();
const heldRpc:Array<()=>void>=[];
const calls:Array<{command:string;args:any;at:number}>=[];
const productionKeys=new Set(['production.schedule','production.cost','dispatch.smartJobs']);
const productionHeld:Array<{key:string;at:number}>=[];
const unexpected:string[]=[];
const config=()=>database['printers.config'] as PrinterConfig[];
const stable=(id:string)=>`fixture-stable-${id}`;
const rawStatus=(value:number,filename='')=>({webhooks:{state:'ready'},extruder:{temperature:value,target:0},heater_bed:{temperature:60,target:0},print_stats:{state:'standby',filename,print_duration:0},virtual_sdcard:{progress:0,is_active:false}});
const snapshot=(printer:PrinterConfig,regression=false)=>{
 const offline=printer.id==='printer-1',fresh=stage==='fresh'&&!offline;
 const epoch=regression?49:nativeEpoch,at=fresh?Date.now():Date.now()-120_000;
 return {stableId:stable(printer.id),printerId:printer.id,modelId:printer.profile?.preset,host:printer.host,activePort:7125,activeProtocol:'websocket',sessionEpoch:epoch,phase:fresh?'ready':'recovering',connected:fresh,lastSeenAt:at,telemetryUpdatedAt:at,jobUpdatedAt:at,cachedStatus:rawStatus(regression?400:fresh?temperature:398,regression?'poison-snapshot.gcode':'old-cache.gcode'),capabilities:{},presentation:{generation:epoch,connectionState:fresh?'online':offline?'offline':'connecting',reason:fresh?'websocket':offline?'unreachable':'connecting',message:fresh?'WebSocket подключён':offline?'Принтер выключен':'Восстанавливаем подключение',channel:'websocket',port:7125,dataAgeMs:fresh?0:120_000}};
};
const poison=(printer:PrinterConfig,epoch=48,eventId=48)=>({eventId,stableId:stable(printer.id),printerId:printer.id,sessionEpoch:epoch,kind:'websocket',phase:'printing',eventtime:Date.now()/1000,status:rawStatus(400,'poison-outbox.gcode')});
const envelope=(value:unknown)=>({status:200,body:Array.from(new TextEncoder().encode(JSON.stringify(value)))});
const record=(command:string,args:any)=>calls.push({command,args:structuredClone(args),at:performance.now()});
const fail=(message:string):never=>{unexpected.push(message);throw new Error(message)};
const state=()=>({mode,stage,nativeEpoch,temperature,mountAt:fixture.__farmMountAt,calls,productionHeld,regressionPolls,unexpected,heldConfigWrite:heldConfigWrite?structuredClone(heldConfigWrite):undefined,database:structuredClone(database),cache:JSON.parse(localStorage.getItem('printers')??'null'),pending:localStorage.getItem('klipper-printers-pending-v1'),credentials:structuredClone(credentials)});
fixture.__farmStartup={
 state,
 releaseFresh(){stage='fresh';for(const resolve of heldRpc.splice(0))resolve()},
 advanceEpoch(){nativeEpoch=50;temperature=235},
 emitOldEvent(){const printer=config().find(value=>value.id==='printer-7')!;for(const [id,listener] of listeners)if(listener.event==='printer-actor-event')callbacks.get(listener.handler)?.({event:listener.event,id,payload:poison(printer,49,900)})},
 regressOneSnapshotPoll(){regressionSnapshot=true},
 recoverDatabase(){configReadFails=false},
 releaseAutomaticWrite(){if(!releaseConfigWrite)return fail('No automatic write is held');const release=releaseConfigWrite;releaseConfigWrite=undefined;release()},
 holdNextConfigWrite(){holdNextConfigWrite=true},
 failNextConfigWrite(){failNextConfigWrite=true},
 validate(text:string){const printer=config().find(value=>value.id==='printer-7')!;return validateGCodeContent({...printer,status:{state:'ready',progress:0,printDuration:0,nozzle:25,nozzleTarget:0,bed:25,bedTarget:0},webcams:[]},'r126-fixture.gcode',text)},
};
if(fileFixture)fixture.__filesFixture={state:fileFixture.state,setMode:fileFixture.setMode};
fixture.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event:string,id:number)=>listeners.delete(id)};
fixture.__TAURI_INTERNALS__={
 metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
 transformCallback(callback:(event:any)=>void){const id=++nextCallback;callbacks.set(id,callback);return id},
 unregisterCallback(id:number){callbacks.delete(id)},
 invoke:async(command:string,args:any={})=>{
  record(command,args);
  if(command==='plugin:event|listen'){const id=++nextListener;listeners.set(id,{event:args.event,handler:args.handler});return id}
  if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return}
  if(args.sessionToken!=='r125-startup-fixture')return fail(`Missing authenticated native context: ${command}`);
  if(command==='headless_engine_status')return {status:'running',error:null};
  if(command==='network_environment_snapshot')return {fingerprint:'fixture-network-unchanged',adapters:[]};
  if(command==='discover_moonraker')return {operation_id:args.operationId,printers:r126==='discovery'?[{host:'192.168.77.108:7125',ip:'192.168.77.108',port:7125,moonraker_confirmed:true,working_protocol:'rest',working_port:7125,source:'subnet_scan'}]:[],duration_ms:0,scanned_subnets:[],diagnostics:{counts:{},adapters:[],entries:[]}};
  if(command==='cancel_moonraker_discovery')return true;
  if(command==='db_get_json'){
   if(fileFixture&&args.key===fileFixture.cacheKey&&fileFixture.dbReadFails())throw new Error('SQLITE_BUSY: file cache read failed');
   if(args.key==='printers.config'&&configReadFails)throw new Error('SQLITE_BUSY: forced startup configuration read failure');
   if(productionKeys.has(args.key)&&!params.has('r136')){productionHeld.push({key:args.key,at:performance.now()});return new Promise(()=>{})}
   return Object.hasOwn(database,args.key)?JSON.stringify(database[args.key]):null;
  }
  if(command==='db_set_json'){
   if(fileFixture&&args.key===fileFixture.cacheKey&&fileFixture.dbWriteFails())throw new Error('SQLITE_BUSY: file cache write failed');
   const value=JSON.parse(args.value);
   if(r126&&args.key==='printers.config'){
    if(failNextConfigWrite){failNextConfigWrite=false;throw new Error('SQLITE_BUSY: forced R126 save failure')}
    if(holdNextConfigWrite){holdNextConfigWrite=false;heldConfigWrite={configs:structuredClone(value),at:performance.now()};await new Promise<void>(resolve=>{releaseConfigWrite=resolve});heldConfigWrite=undefined}
   }
   if(mode==='automatic-refresh'&&args.key==='printers.config'&&!automaticWriteGateUsed&&value[1]?.profile?.preset==='ender3-v3-se'&&value[1]?.modelSelection?.lastDetection?.decision==='confirmed'){
    automaticWriteGateUsed=true;heldConfigWrite={configs:structuredClone(value),at:performance.now()};
    await new Promise<void>(resolve=>{releaseConfigWrite=resolve});
    heldConfigWrite=undefined;
   }
   database[args.key]=value;localStorage.setItem(dbKey,JSON.stringify(database));return;
  }
  if(command==='notification_list'||command==='audit_list')return [];
  if(command==='audit_add'||command==='native_notify')return;
  if(r126&&(command==='secret_set'||command==='secret_delete')){
   if(command==='secret_delete')delete credentials[args.printerId];else credentials[args.printerId]=args.value;
   localStorage.setItem(credentialKey,JSON.stringify(credentials));return;
  }
  if(command==='printer_actor_upsert'){
   const printer=config().find(value=>value.id===args.config.printerId);
   if(!printer||printer.host!==args.config.host)return fail('Unregistered printer actor');
   return snapshot(printer);
  }
  if(command==='printer_actor_events_pending'){const printer=config().find(value=>value.id===args.printerId)!;return [poison(printer)]}
  if(command==='printer_actor_events_ack')return args.throughEventId;
  if(command==='printer_actor_snapshots'){
   const rows=args.targets.map((target:any)=>config().find(value=>value.id===target.printerId&&value.host===target.host)).filter(Boolean);
   const regression=regressionSnapshot;
   if(regression){regressionSnapshot=false;regressionPolls++}
   return {snapshots:rows.map((printer:PrinterConfig)=>snapshot(printer,regression)),events:[]};
  }
  if(r126&&command==='moonraker_rpc'){
   // Real detector input deliberately identifies a KE. Explicitly selecting
   // Flashforge must still win when the wizard/discovery commits its record.
   if(args.method==='server.info')return {klippy_state:'ready'};
   if(args.method==='printer.info')return {state:'ready',manufacturer:'Creality',model:'Ender-3 V3 KE'};
   if(args.method==='machine.system_info')return {system_info:{manufacturer:'Creality',model:'Ender-3 V3 KE',machine_id:'new-board-108',distribution:{name:'Creality OS'}}};
   if(args.method==='printer.objects.list')return {objects:['print_stats','virtual_sdcard','extruder','heater_bed','webhooks','prtouch_v2','bl24c16f']};
   if(args.method==='printer.objects.query'&&args.params?.objects?.configfile)return {status:{configfile:{settings:{printer:{kinematics:'cartesian'},stepper_x:{position_max:220},stepper_y:{position_max:220},stepper_z:{position_max:240},prtouch_v2:{},z_compensate:{},bl24c16f:{},'gcode_macro QMODE':{}}}}};
   if(args.method==='printer.objects.query'&&args.params?.objects?.toolhead)return {status:{toolhead:{axis_minimum:[0,0,0],axis_maximum:[220,220,240]}}};
   return fail('Unexpected R126 detector method '+args.method);
  }
  if(command==='printer_actor_rpc'){
   if(args.printerId==='printer-1')return new Promise(()=>{});
   if(stage==='stale')await new Promise<void>(resolve=>heldRpc.push(resolve));
   let result;
   if(fileFixture&&['server.files.list','printer.print.start'].includes(args.method))return {operationId:`fixture-${calls.length}`,sessionEpoch:nativeEpoch,state:'confirmed',recovered:false,result:fileFixture.rpc(args.method,args.params)};
   // Supply the actual detector's six read-only Moonraker responses. The real
   // fact parser and classifier decide whether this is a confirmed SE; the
   // fixture does not substitute detect(), classification or App scheduling.
   const automaticTarget=mode==='automatic-refresh'&&args.printerId==='printer-2';
   if(automaticTarget&&args.method==='printer.info')result={state:'ready',manufacturer:'Creality',model:'Ender-3 V3 SE'};
   else if(automaticTarget&&args.method==='machine.system_info')result={system_info:{manufacturer:'Creality',model:'Ender-3 V3 SE'}};
   else if(automaticTarget&&args.method==='printer.objects.list')result={objects:['print_stats','virtual_sdcard','extruder','heater_bed','webhooks','bltouch']};
   else if(automaticTarget&&args.method==='printer.objects.query'&&Object.keys(args.params?.objects??{}).length===1&&args.params.objects.configfile)result={status:{configfile:{settings:{printer:{kinematics:'cartesian'},stepper_x:{position_max:220},stepper_y:{position_max:220},stepper_z:{position_max:250},cr_touch:{}}}}};
   else if(automaticTarget&&args.method==='printer.objects.query'&&Object.keys(args.params?.objects??{}).length===1&&args.params.objects.toolhead?.includes('axis_maximum'))result={status:{toolhead:{axis_minimum:[0,0,0],axis_maximum:[220,220,250]}}};
   else if(args.method==='server.info')result={klippy_state:'ready'};
   else if(args.method==='printer.info')result={state:'ready'};
   else if(args.method==='printer.objects.query')result={status:rawStatus(temperature)};
   else if(args.method==='printer.objects.list')result={objects:['print_stats','virtual_sdcard','extruder','heater_bed','webhooks']};
   else return fail(`Unexpected actor method ${args.method}`);
   return {operationId:`fixture-${calls.length}`,sessionEpoch:nativeEpoch,state:'confirmed',recovered:false,result};
  }
  if(command==='moonraker_http'){
   const fileResponse=fileFixture?.http(args.path);if(fileResponse)return fileResponse;
   if(args.path==='/server/webcams/list')return envelope({result:{webcams:[]}});
   if(args.path.startsWith('/server/history/list?'))return envelope({result:{jobs:[]}});
   return fail(`Unexpected native HTTP ${args.path}`);
  }
  return fail(`Unexpected native command ${command}`);
 },
};
const session={token:'r125-startup-fixture',user:{id:'admin',name:'Администратор',role:'admin' as const,enabled:true,createdAt:0}};
setAuthSession(session);
fixture.__farmMountAt=performance.now();
createRoot(document.getElementById('root')!).render(<I18nProvider><AppDialogHost><FarmApp session={session} onLogout={()=>fail('Unexpected logout')}/></AppDialogHost></I18nProvider>);
