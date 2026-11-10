import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {mockIPC} from '@tauri-apps/api/mocks';
import {setAuthSession} from '../src/lib/auth';
import {VoiceAssistantPanel} from '../src/components/VoiceAssistantPanel';
import {PrintNearEndSettings} from '../src/components/PrintNearEndSettings';
import {trySpeakNeuralAnnouncement} from '../src/lib/neuralSpeech';
import {profileForPreset} from '../src/lib/printerProfile';
import {emptyFilamentInventory} from '../src/lib/filamentInventory';
import type {PrinterModel} from '../src/types';
import type {MoonrakerClient} from '../src/lib/moonraker';
import '../src/styles.css';

const calls:string[]=[],voices:string[]=[],inventory=emptyFilamentInventory();inventory.materials.PLA.looseGrams=1500;
const data=new TextEncoder().encode('; printer_model = Creality K1 Max\n; filament_type = PLA\nG28\nG90\nM104 S200\nM140 S60\nG1 X10 Y10 Z0.2 F1200\nG1 X20 Y20 E1\n');
let started=0,uploaded=0,holdInventory=false,holdSynthesis=false,activeUserId='test',neuralTranscript='Сколько осталось пластика?',releaseInventory:(()=>void)|undefined,releaseSynthesis:(()=>void)|undefined;
const transcriptions:{bytes:number;modelId:string;authenticated:boolean}[]=[];
const syntheses:{text:string;voiceId:string;userId:string;authenticated:boolean}[]=[];
const semanticRequests:{requestId:string;text:string;userId:string;context:unknown;authenticated:boolean}[]=[],semanticCancellations:string[]=[];
let holdSemantic=false;const semanticReleases:(()=>void)[]=[];
mockIPC((command,args:any)=>{
 calls.push(command);
 if(command==='voice_tools_status')return {recognition:true,synthesis:true};
 if(command==='voice_semantic_status')return{available:true};
 if(command==='voice_semantic_cancel'){semanticCancellations.push(args.requestId);return null;}
 if(command==='voice_semantic_interpret'){
  const text=args.request.text;
  semanticRequests.push({requestId:args.requestId,text,userId:activeUserId,context:structuredClone(args.request.context),authenticated:!!args.sessionToken});
  const result=text==='Ксения, покажи, кому сейчас можно дать работу'?{kind:'printers',filter:'free'}
   :text==='корпус на K1 Max'?{kind:'followup',query:'корпус',printerId:'max'}
   :text==='Собери мне корпус на большом принтере'?{kind:'print',query:'корпус',printerId:'max'}
   :{kind:'clarify',reason:'unknown'};
  return holdSemantic?new Promise(resolve=>{semanticReleases.push(()=>resolve(result))}):result;
 }
 if(command==='voice_prepare')return null;
 if(command==='voice_transcribe'){transcriptions.push({bytes:args.wave.length,modelId:args.modelId,authenticated:!!args.sessionToken});return{text:neuralTranscript,confidence:0.95};}
 if(command==='voice_synthesize'){voices.push(args.voiceId);syntheses.push({text:args.text,voiceId:args.voiceId,userId:activeUserId,authenticated:!!args.sessionToken});const value={pcm:Array.from(new Uint8Array(4800*2)),sampleRate:48000};return holdSynthesis?new Promise(resolve=>{releaseSynthesis=()=>resolve(value)}):value;}
 if(command==='db_get_json')return args.key==='production.filamentInventory'?(holdInventory?new Promise<string>(resolve=>{releaseInventory=()=>resolve(JSON.stringify(inventory))}):JSON.stringify(inventory)):null;
 if(command==='local_library_list')return{files:[{path:'детали/корпус.gcode',size:data.length,modified:10}],legacyFiles:0,legacySize:0};
 if(command==='local_library_read_preview_text')return new TextDecoder().decode(data);
 if(command==='local_library_read_begin')return{readId:'fixture-read',size:data.length,chunkSize:524288};
 if(command==='local_library_read_chunk')return{data:Array.from(data),nextOffset:data.length,done:true,sha256:'a'.repeat(64)};
 if(command==='audit_add')return null;
 throw new Error('Unexpected native command '+command);
});
const authenticate=(id:string)=>{activeUserId=id;setAuthSession({token:'synthetic-offline-voice-'+id,user:{id,name:id,role:'operator',enabled:true,createdAt:1}})};
authenticate('test');
const printer:PrinterModel={id:'max',name:'K1 Max',host:'192.168.1.10',profile:profileForPreset('creality-k1-max'),status:{state:'ready',connectionState:'online',progress:0,printDuration:0,nozzle:25,nozzleTarget:0,bed:25,bedTarget:0},webcams:[]};
const printingPrinter:PrinterModel={...printer,id:'busy-printer',name:'K1C',profile:profileForPreset('creality-k1c-2025'),status:{...printer.status,state:'printing'}};
const backupPrinter:PrinterModel={...printer,id:'backup-max',name:'Второй Max'};
const client={checkIdleReady:async()=>true,uploadLocalLibrary:async()=>{uploaded++;return 'детали/корпус.gcode'},start:async()=>{started++},checkPrintStart:async()=>({confirmed:true})} as unknown as MoonrakerClient;
type ControlFixtureOptions={duplicateMax?:boolean;allowed?:boolean;maxState?:PrinterModel['status']['state'];stale?:boolean;unknownLight?:boolean};
let controlMode=false,controlAllowed=true,unknownControlLight=false,controlRows:PrinterModel[]=[],fixtureCamera:string|undefined,renderControls:(()=>void)|undefined;
const controlCalls:{printerId:string;action:string;filename?:string}[]=[],cameraOpens:string[]=[];
const controlRow=(id:string)=>{const row=controlRows.find(p=>p.id===id);if(!row)throw new Error('Unknown control fixture printer');return row};
const configureControls=(options:ControlFixtureOptions={})=>{
 const now=Date.now(),sample=options.stale?now-180_000:now;
 controlMode=true;controlAllowed=options.allowed!==false;unknownControlLight=!!options.unknownLight;fixtureCamera=undefined;
 controlRows=[
  {...printer,status:{...printer.status,state:options.maxState??'printing',filename:'детали/корпус.gcode',printStatsState:options.maxState??'printing',progress:.5,printDuration:1800,jobUpdatedAt:sample,telemetryUpdatedAt:sample}},
  {...printingPrinter,status:{...printingPrinter.status,state:'printing',filename:'детали/крышка.gcode',printStatsState:'printing',progress:.25,printDuration:3600,jobUpdatedAt:sample,telemetryUpdatedAt:sample}},
  ...(options.duplicateMax?[{...backupPrinter,status:{...printer.status,state:'printing' as const,filename:'детали/корпус.gcode',printStatsState:'printing',progress:.5,printDuration:1800,jobUpdatedAt:sample,telemetryUpdatedAt:sample}}]:[]),
 ];renderControls?.();
};
const controlClients=new Map(['max','busy-printer','backup-max'].map(id=>[id,{
 checkIdleReady:async()=>controlRow(id).status.state==='ready',
 uploadLocalLibrary:async()=>{uploaded++;return 'детали/корпус.gcode';},start:async()=>{started++;},
 light:async(on:boolean,guard?:()=>void)=>{guard?.();controlCalls.push({printerId:id,action:on?'light-on':'light-off'});return unknownControlLight?{supported:true,detail:'Fixture output has no readback'}:{supported:true,on};},
 pause:async(guard?:()=>void)=>{guard?.();controlCalls.push({printerId:id,action:'pause'});const p=controlRow(id);p.status={...p.status,state:'paused',printStatsState:'paused',jobUpdatedAt:Date.now(),telemetryUpdatedAt:Date.now()};renderControls?.();},
 resume:async(guard?:()=>void)=>{guard?.();controlCalls.push({printerId:id,action:'resume'});const p=controlRow(id);p.status={...p.status,state:'printing',printStatsState:'printing',jobUpdatedAt:Date.now(),telemetryUpdatedAt:Date.now()};renderControls?.();},
 checkPrintJob:async(filename:string)=>{const p=controlRow(id);controlCalls.push({printerId:id,action:'check',filename});return{confirmed:p.status.filename===filename&&['printing','paused'].includes(p.status.state),state:p.status.state,filename:p.status.filename};},
 } as unknown as MoonrakerClient]));
(window as any).voiceFixture={state:()=>({calls:[...calls],voices:[...voices],syntheses:[...syntheses],transcriptions:[...transcriptions],semanticRequests:[...semanticRequests],semanticCancellations:[...semanticCancellations],controlCalls:[...controlCalls],cameraOpens:[...cameraOpens],controlPrinters:controlRows.map(p=>({id:p.id,state:p.status.state})),controlAllowed,started,uploaded,userId:activeUserId}),configureControls,holdSemantic:()=>{holdSemantic=true},releaseSemantic:()=>{holdSemantic=false;for(const release of semanticReleases.splice(0))release()},holdInventory:()=>{holdInventory=true},releaseInventory:()=>{holdInventory=false;releaseInventory?.()},holdVoice:()=>{holdSynthesis=true},releaseVoice:()=>{holdSynthesis=false;releaseSynthesis?.();releaseSynthesis=undefined},setNeuralTranscript:(value:string)=>{neuralTranscript=value},tryNotice:()=>trySpeakNeuralAnnouncement('Печать скоро завершится')};
function App(){
 const [open,setOpen]=useState(true),[userId,setUserId]=useState('test'),[twoReady,setTwoReady]=useState(false),[swappedReady,setSwappedReady]=useState(false),[noneReady,setNoneReady]=useState(false),[panelKey,setPanelKey]=useState(0),[,setControlRevision]=useState(0);
 renderControls=()=>setControlRevision(value=>value+1);
 const switchProfile=(id:string)=>{authenticate(id);setUserId(id)};
 const primary=swappedReady||noneReady?{...printer,status:{...printer.status,state:'printing' as const}}:printer;
 const secondary=swappedReady&&!noneReady?{...printingPrinter,status:{...printingPrinter.status,state:'ready' as const}}:printingPrinter;
 return <><div aria-label="Управление тестовой фермой"><button onClick={()=>setOpen(true)}>Открыть помощника</button><button onClick={()=>setPanelKey(value=>value+1)}>Пересоздать помощника</button><button aria-pressed={swappedReady} onClick={()=>setSwappedReady(!swappedReady)}>Сменить свободный принтер</button><button aria-pressed={noneReady} onClick={()=>setNoneReady(!noneReady)}>Нет свободных принтеров</button><button aria-pressed={twoReady} onClick={()=>setTwoReady(!twoReady)}>Два свободных Max</button><button disabled={userId==='test'} onClick={()=>switchProfile('test')}>Профиль test</button><button disabled={userId==='other'} onClick={()=>switchProfile('other')}>Профиль other</button><span>Тестовый профиль: {userId}</span></div><PrintNearEndSettings/><VoiceAssistantPanel key={panelKey} userId={userId} printers={controlMode?controlRows:twoReady?[primary,backupPrinter,secondary]:[primary,secondary]} clients={controlMode?controlClients:new Map([['max',client],['backup-max',client]])} canOperate={controlMode?controlAllowed:true} open={open} onClose={()=>setOpen(false)} onOpenCamera={id=>{fixtureCamera=id;cameraOpens.push(id);renderControls?.();return true;}}/>{fixtureCamera&&<section role="dialog" aria-label={'Камера '+controlRow(fixtureCamera).name} style={{position:'fixed',inset:50,zIndex:2000,background:'#202226',padding:24}}><h2>{controlRow(fixtureCamera).name}</h2><button onClick={()=>{fixtureCamera=undefined;renderControls?.()}}>Закрыть камеру</button></section>}</>;
}
createRoot(document.getElementById('root')!).render(<App/>);
