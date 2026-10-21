// The actual production React UI, reducer and persistence store run unchanged.
// Only the authenticated native SQLite/desktop boundary is deterministic here.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FilamentInventoryPanel} from '../src/components/FilamentInventoryPanel';
import {ProductionPanel} from '../src/components/ProductionPanel';
import {NotificationCenter} from '../src/components/NotificationCenter';
import {NotificationToastHost} from '../src/components/NotificationToastHost';
import {AppDialogHost} from '../src/lib/appDialogs';
import {setAuthSession} from '../src/lib/auth';
import {I18nProvider} from '../src/i18n';
import type {PrinterModel,Spool} from '../src/types';
import {emptyFilamentInventory,reduceFilamentInventory,type FilamentCommand} from '../src/lib/filamentInventory';
import {updateFilamentInventory} from '../src/lib/filamentInventoryStore';
import {spoolThumbnailStats} from '../src/lib/filamentThumbnails';
import '../src/styles.css';

const w=window as any,params=new URLSearchParams(location.search);
const fixtureKey='r123-filament-native-db',noticesKey='r123-filament-native-notices';
const role=params.get('role')==='viewer'?'viewer':'admin',canOperate=role!=='viewer';
document.documentElement.dataset.theme=params.get('theme')==='dark'?'dark':'light';
const legacy:Spool={id:'legacy-exact-id',name:'Старая PETG',material:'PETG',color:'#2450aa',initialWeight:1000,remainingWeight:625,price:1475,currency:'₽',printerId:'printer-two',createdAt:1700000000000};
if(!localStorage.getItem(fixtureKey)){
 const initial:Record<string,string>={};
 if(params.get('seed')==='legacy')initial['production.spools']=JSON.stringify([legacy]);
 if(params.get('seed')==='malformed')initial['production.filamentInventory']='{broken JSON';
 if(params.get('seed')==='handoff'){
  const now=Date.now();let state=emptyFilamentInventory(now-10000);
  const apply=(command:FilamentCommand)=>{state=reduceFilamentInventory(state,command,now).state};
  apply({type:'add-stock',material:'PLA',grams:4500});
  for(const [material,color,finish,capacity,remaining,name] of [
   ['PLA','#f47b24','silk',1000,680,'Контрольная PLA'],['PETG','#2799ef','normal',2000,1500,'Синяя PETG'],
   ['ABS','#eee8d8','matte',1000,1000,'Полная ABS'],['PLA','#33363b','normal',500,0,'Пустая PLA']
  ] as const){
   apply({type:'add-spools',material,color,finish,weightGrams:capacity,count:1,source:'purchase',name});
   apply({type:'edit-spool',spoolId:state.spools.at(-1)!.id,remainingGrams:remaining});
  }
  apply({type:'bind-printer',printerId:'printer-one',material:'PLA',spoolId:state.spools[0].id});
  initial['production.filamentInventory']=JSON.stringify(state);
 }
 if(params.get('seed')==='warehouse'){
  const now=Date.now(),at=(offset:number)=>{const date=new Date(now);date.setDate(date.getDate()+offset);date.setHours(12,0,0,0);return Math.min(now,date.getTime())};
  let state=emptyFilamentInventory(at(-40));
  const apply=(command:FilamentCommand,time=at(-35))=>{state=reduceFilamentInventory(state,command,time).state};
  for(const [material,grams,reserveGrams] of [['PLA',15000,5000],['PETG',12000,3000],['ABS',2500,1500]] as const)apply({type:'add-stock',material,grams,reserveGrams});
  for(const [material,count,color] of [['PLA',6,'#ed9e28'],['PETG',4,'#438eaf'],['ABS',2,'#424858']] as const)apply({type:'add-spools',material,count,weightGrams:1000,color,source:'existing-stock'});
  const spoolColors=['#ef9e32','#60b5a7','#e56c86','#eee8d8','#628ed1','#424858','#439ab8','#9b79cf','#e6c756','#eee8d8','#586574','#df7d4f'];
  const spoolWeights=[360,780,540,1000,230,870,650,1000,180,910,420,900];
  state.spools.forEach((spool,index)=>apply({type:'edit-spool',spoolId:spool.id,remainingGrams:spoolWeights[index],color:spoolColors[index]},now));
  for(let index=0;index<30;index++){
   const offset=index-29;
   apply({type:'manual-writeoff',material:'PLA',printerId:'printer-one',grams:70+(index*53)%240},at(offset));
   if(index%3===0)apply({type:'manual-writeoff',material:'PETG',printerId:'printer-two',grams:100+(index*37)%210},at(offset));
  }
  apply({type:'bind-printer',printerId:'printer-one',material:'PLA',spoolId:state.spools[0].id},now);
  apply({type:'bind-printer',printerId:'printer-two',material:'PETG',spoolId:state.spools[6].id},now);
  initial['production.filamentInventory']=JSON.stringify(state);
 }
 localStorage.setItem(fixtureKey,JSON.stringify(initial));localStorage.setItem(noticesKey,'[]');
}
w.__legacy=legacy;w.__calls=[];w.__toasts=[];
w.__fault={read:params.get('fault')==='read',commit:false};
w.__database=()=>JSON.parse(localStorage.getItem(fixtureKey)||'{}');
w.__notices=()=>JSON.parse(localStorage.getItem(noticesKey)||'[]');
w.__inventory=()=>{const raw=w.__database()['production.filamentInventory'];return raw?JSON.parse(raw):null};
w.__dispatch=updateFilamentInventory;w.__thumbnailStats=spoolThumbnailStats;
w.__TAURI_INTERNALS__={invoke:async(command:string,args:Record<string,any>={})=>{
 w.__calls.push({command,args});
 if(args.sessionToken!=='r123-fixture-only')throw new Error('AUTH_REQUIRED: fixture session');
 if(command==='db_get_json'){
  if(w.__fault.read&&['production.filamentInventory','production.spools'].includes(args.key))throw new Error('Проверочный сбой чтения SQLite');
  return w.__database()[args.key]??null;
 }
 if(command==='filament_inventory_commit'){
  if(!canOperate)throw new Error('FORBIDDEN: operator required');
  if(w.__fault.commit)throw new Error('Проверочный сбой сохранения SQLite');
  // A single synchronous boundary atomically persists the state and its notices.
  // Native transaction/rollback/role enforcement is covered by the Rust suite.
  const database=w.__database(),notices=w.__notices();
  JSON.parse(args.value);
  for(const item of args.notices??[])if(!['filament.milestone','filament.reserve'].includes(item.action))throw new Error('Unexpected audit action');
  database['production.filamentInventory']=args.value;
  localStorage.setItem(fixtureKey,JSON.stringify(database));
  localStorage.setItem(noticesKey,JSON.stringify([...notices,...(args.notices??[])]));
  return null;
 }
 if(command==='db_set_json'){
  if(['production.filamentInventory','production.spools'].includes(args.key))throw new Error('Inventory bypassed the atomic native command');
  const database=w.__database();database[args.key]=args.value;localStorage.setItem(fixtureKey,JSON.stringify(database));return null;
 }
 if(command==='native_notify'){w.__toasts.push({title:args.title,body:args.body});return null}
 if(command==='notification_list')return w.__notices().map((entry:any,index:number)=>({...entry,id:index+1,ts:1700000000000+index,user:'Проверка'})).reverse();
 if(command==='audit_add')return null;
 throw new Error('Unexpected native command in filament fixture: '+command);
}};
setAuthSession({token:'r123-fixture-only',user:{id:'fixture-user',name:'Проверка',role,enabled:true,createdAt:1}});
const printers:PrinterModel[]=[
 {id:'printer-one',name:'K1 Max',host:'192.0.2.10:7125',status:{state:'offline',connectionState:'offline',progress:0,printDuration:0,nozzle:0,nozzleTarget:0,bed:0,bedTarget:0},webcams:[]},
 {id:'printer-two',name:'Flashforge 5M',host:'192.0.2.11:7125',status:{state:'offline',connectionState:'offline',progress:0,printDuration:0,nozzle:0,nozzleTarget:0,bed:0,bedTarget:0},webcams:[]},
];
function Fixture(){
 const [open,setOpen]=useState(true);
 if(params.get('view')==='production')return open?<ProductionPanel printers={printers} clients={new Map()} canOperate={canOperate} onClose={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>Открыть производство</button>;
 return <main style={{maxWidth:1320,margin:'auto',padding:16}}><div style={{display:'flex',justifyContent:'flex-end',marginBottom:8}}><NotificationCenter printers={printers} userId="fixture-user" onOpenPrinter={id=>{w.__notificationPrinter=id}}/></div><FilamentInventoryPanel printers={printers} canOperate={canOperate}/></main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><AppDialogHost/><NotificationToastHost/><Fixture/></I18nProvider>);
