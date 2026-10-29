import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {mockIPC} from '@tauri-apps/api/mocks';
import {setAuthSession} from '../src/lib/auth';
import {VoiceAssistantPanel} from '../src/components/VoiceAssistantPanel';
import {profileForPreset} from '../src/lib/printerProfile';
import {emptyFilamentInventory} from '../src/lib/filamentInventory';
import type {PrinterModel} from '../src/types';
import type {MoonrakerClient} from '../src/lib/moonraker';
import '../src/styles.css';

const calls:string[]=[],voices:string[]=[],inventory=emptyFilamentInventory();inventory.materials.PLA.looseGrams=1500;
const data=new TextEncoder().encode('; printer_model = Creality K1 Max\n; filament_type = PLA\nG28\nG90\nM104 S200\nM140 S60\nG1 X10 Y10 Z0.2 F1200\nG1 X20 Y20 E1\n');
let started=0,uploaded=0;
mockIPC((command,args:any)=>{
 calls.push(command);
 if(command==='voice_tools_status')return {recognition:true,synthesis:true};
 if(command==='voice_synthesize'){voices.push(args.voiceId);return {pcm:Array.from(new Uint8Array(4800*2)),sampleRate:48000};}
 if(command==='db_get_json')return args.key==='production.filamentInventory'?JSON.stringify(inventory):null;
 if(command==='local_library_list')return{files:[{path:'детали/корпус.gcode',size:data.length}],legacyFiles:0,legacySize:0};
 if(command==='local_library_read_begin')return{readId:'fixture-read',size:data.length,chunkSize:524288};
 if(command==='local_library_read_chunk')return{data:Array.from(data),nextOffset:data.length,done:true,sha256:'a'.repeat(64)};
 if(command==='audit_add')return null;
 throw new Error('Unexpected native command '+command);
});
setAuthSession({token:'synthetic-offline-voice',user:{id:'test',name:'Test',role:'operator',enabled:true,createdAt:1}});
const printer:PrinterModel={id:'max',name:'K1 Max',host:'192.168.1.10',profile:profileForPreset('creality-k1-max'),status:{state:'ready',connectionState:'online',progress:0,printDuration:0,nozzle:25,nozzleTarget:0,bed:25,bedTarget:0},webcams:[]};
const client={checkIdleReady:async()=>true,uploadLocalLibrary:async()=>{uploaded++;return 'детали/корпус.gcode'},start:async()=>{started++},checkPrintStart:async()=>({confirmed:true})} as unknown as MoonrakerClient;
(window as any).voiceFixture={state:()=>({calls:[...calls],voices:[...voices],started,uploaded})};
function App(){const [open,setOpen]=useState(true);return <><button onClick={()=>setOpen(true)}>Открыть помощника</button><VoiceAssistantPanel printers={[printer]} clients={new Map([['max',client]])} canOperate={true} open={open} onClose={()=>setOpen(false)}/></>}
createRoot(document.getElementById('root')!).render(<App/>);
