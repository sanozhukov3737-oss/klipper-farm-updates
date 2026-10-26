#!/usr/bin/env node
// Installed Windows application only. No React fixture, native-window mock,
// injected product API, browser download, or printer command is used here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const [clientArg,proofArg,databaseArg]=process.argv.slice(2);
assert.equal(process.platform,'win32','Actual installed fullscreen validation requires the Windows window manager');
assert.ok(clientArg&&proofArg,'usage: check-r141-installed-fullscreen.mjs CLIENT_EXE PROOF_DIRECTORY [DATABASE]');
const client=path.resolve(clientArg),proof=path.resolve(proofArg);
const database=path.resolve(databaseArg??path.join(process.env.APPDATA??'','app.klipper.farm','farm.sqlite3'));
const helper=path.join(import.meta.dirname,'check-r141-installed-fullscreen-window.ps1');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const file of [client,database,helper]){
  const stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink(),`Unsafe or missing installed-test input: ${file}`);
}
assert.equal(path.basename(client).toLowerCase(),'klipper-farm-client.exe');
fs.mkdirSync(proof,{recursive:true});
const executableSha256=sha(client),helperSha256=sha(helper);
// Fail before opening the authenticated farm if anything except our seven
// synthetic loopback fixtures has been seeded into this Windows runner.
const fixture=JSON.parse(execFileSync('python',['-c',String.raw`
import json,sqlite3,sys,pathlib
p=pathlib.Path(sys.argv[1]).resolve()
with sqlite3.connect(p.as_uri()+'?mode=ro',uri=True) as db:
 rows={key:json.loads(value) for key,value in db.execute("SELECT key,value FROM kv WHERE key IN ('printers.config','production.spools','production.filamentInventory')")}
print(json.dumps({'printers':rows['printers.config'],'spoolCount':len(rows['production.spools']),'inventorySpoolCount':len(rows['production.filamentInventory']['spools'])}))
`,database],{encoding:'utf8',timeout:15_000}));
assert.equal(fixture.printers.length,7,'Seven preserved upgrade printers are required');
assert.equal(fixture.spoolCount,2);assert.equal(fixture.inventorySpoolCount,2);
for(const [index,printer]of fixture.printers.entries()){
  assert.equal(printer.id,`r141-upgrade-printer-${index+1}`);
  assert.equal(printer.host,`127.0.0.1:${19001+index}`,'Installed UI test must not contact LAN printers');
}
const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve)});
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const profile=path.join(proof,`webview-profile-${process.pid}`);
const child=spawn(client,[],{cwd:path.dirname(client),stdio:'ignore',windowsHide:false,env:{...process.env,
  WEBVIEW2_USER_DATA_FOLDER:profile,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
}});
let childExit,childError,cdp,currentCase='startup';
child.once('exit',(code,signal)=>{childExit={code,signal}});child.once('error',error=>{childError=error});
const cases=[],runtimeErrors=[],screenshots=[],observations=[];
const waitFor=async(read,predicate,label,timeout=20_000)=>{
  const deadline=Date.now()+timeout;let latest,lastError;
  while(Date.now()<deadline){
    if(childError)throw childError;
    if(childExit)throw new Error(`Installed client exited during ${label}: ${JSON.stringify(childExit)}`);
    try{latest=await read();if(predicate(latest))return latest;lastError=undefined}catch(error){lastError=error}
    await delay(160);
  }
  throw new Error(`Timed out: ${label}; latest=${JSON.stringify(latest)}; error=${String(lastError??'none')}`);
};
class CdpConnection{
  constructor(socket){
    this.socket=socket;this.next=0;this.pending=new Map();
    socket.addEventListener('message',event=>{
      const message=JSON.parse(String(event.data));
      if(message.id){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error(JSON.stringify(message.error))):pending.resolve(message.result)}
      else if(message.method==='Runtime.exceptionThrown')runtimeErrors.push(message.params.exceptionDetails?.exception?.description??message.params.exceptionDetails?.text??'WebView exception');
    });
    socket.addEventListener('close',()=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Installed WebView CDP disconnected'))}this.pending.clear()});
  }
  static async open(url){
    const socket=new WebSocket(url);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP WebSocket open timeout')),15_000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP WebSocket failed'))},{once:true})});
    return new CdpConnection(socket);
  }
  send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP command timed out: ${method}`))},20_000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}))})}
  async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result?.value}
  close(){this.socket.close()}
}
const invoke=(command,args={})=>cdp.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const windowCommand=(name,args={})=>invoke('plugin:window|'+name,{label:'main',...args});
const win32=(mode='state',bounds)=>{
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Mode',mode,'-ProcessId',String(child.pid)];
  if(bounds)for(const [key,value]of Object.entries(bounds))args.push('-'+key,String(value));
  return JSON.parse(execFileSync('pwsh',args,{encoding:'utf8',timeout:20_000,windowsHide:true}).replace(/^\uFEFF/,''));
};
const nativeState=()=>cdp.evaluate(`(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;const [fullscreen,maximized,position,size]=await Promise.all(['is_fullscreen','is_maximized','outer_position','outer_size'].map(name=>invoke('plugin:window|'+name,{label:'main'})));return{fullscreen,maximized,position,size,domFullscreen:document.fullscreenElement!==null,tvMounted:!!document.querySelector('.tvDashboard'),bodyOverflow:document.body.style.overflow,focusedTag:document.activeElement?.tagName,observedAt:Date.now()}})()`);
const capture=async(label)=>{const state={label,native:await nativeState(),win32:win32()};assert.equal(state.native.domFullscreen,false,'TV must use the native host window, never DOM fullscreen');observations.push(state);return state};
const sameBounds=(actual,expected)=>{for(const key of ['left','top','right','bottom'])assert.ok(Math.abs(actual[key]-expected[key])<=2,`Restored ${key} differs: ${actual[key]} versus ${expected[key]}`)};
const waitRestoredBounds=expected=>waitFor(()=>win32(),state=>['left','top','right','bottom'].every(key=>Math.abs(state.bounds[key]-expected[key])<=2),'Windows finished restoring exact pre-TV bounds');
const fullscreenBounds=state=>{assert.equal(state.native.fullscreen,true);for(const key of ['left','top','right','bottom'])assert.ok(Math.abs(state.win32.bounds[key]-state.win32.monitor[key])<=3,`Native fullscreen does not cover monitor: ${key}`)};
const screenshot=async(name)=>{const result=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const filename=name+'.png';fs.writeFileSync(path.join(proof,filename),Buffer.from(result.data,'base64'));screenshots.push(filename)};
const click=async(selector,text)=>{
  const expression=`(()=>{const elements=[...document.querySelectorAll(${JSON.stringify(selector)})];const target=elements.find(element=>${text===undefined?'true':`element.textContent.trim()===${JSON.stringify(text)}`});if(!target||target.disabled)return false;target.click();return true})()`;
  await waitFor(()=>cdp.evaluate(expression),Boolean,`UI click ${text??selector}`);
};
const tvOpen=async()=>{await click('.kfSidebar nav button','Инструменты');await click('.kfToolsPage button b','TV-панель');await waitFor(()=>nativeState(),state=>state.tvMounted,'Actual installed TV mounted');await waitFor(()=>cdp.evaluate(`document.querySelector('.tvDashboardBrand span')?.textContent??''`),text=>/^7 принтеров/.test(text),'All seven saved printers in actual TV')};
const tvClose=async()=>{await click('button[aria-label="Закрыть TV-панель"]');await waitFor(()=>nativeState(),state=>!state.tvMounted&&state.bodyOverflow!=='hidden','TV closed and body scroll restored')};
const enterTvFullscreen=async()=>{await click('button[aria-label="На весь экран"]');await waitFor(()=>nativeState(),state=>state.fullscreen,'TV native fullscreen entered');await waitFor(()=>cdp.evaluate(`!!document.querySelector('button[aria-label="Выйти из полного экрана"]')`),Boolean,'TV fullscreen action changed')};
const restoreNormal=async()=>{
  await windowCommand('set_fullscreen',{value:false});
  await waitFor(()=>nativeState(),state=>!state.fullscreen,'Leave host fullscreen before normal setup');
  const state=win32(),work=state.workArea;
  win32('normal',{Left:work.left+24,Top:work.top+24,Width:Math.max(900,Math.min(1100,work.width-48)),Height:Math.max(650,Math.min(740,work.height-48))});
  await waitFor(()=>nativeState(),state=>!state.fullscreen&&!state.maximized,'Real normal window state');
  return capture('normal-window-before-TV');
};
const escape=async()=>{await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await waitFor(()=>nativeState(),state=>!state.tvMounted&&state.bodyOverflow!=='hidden','Escape closes actual TV')};
const passed=(id,before,expanded,after)=>{cases.push({id,passed:true,before,expanded,after});console.log('PASS installed TV '+id)};

try{
  const target=await waitFor(async()=>{const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)});assert.ok(response.ok);return(await response.json()).find(value=>value.type==='page'&&/^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)(?:\/|$)/.test(value.url))},Boolean,'Installed WebView2 loopback debugger',90_000);
  const debuggerUrl=new URL(target.webSocketDebuggerUrl);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(debuggerUrl.hostname));assert.equal(Number(debuggerUrl.port),port);
  cdp=await CdpConnection.open(debuggerUrl.href);await cdp.send('Runtime.enable');await cdp.send('Page.enable');
  await waitFor(()=>cdp.evaluate(`({tauri:typeof window.__TAURI_INTERNALS__?.invoke==='function',ready:!!document.querySelector('.authCard,.kfShell')})`),value=>value?.tauri&&value.ready,'Actual installed Tauri UI ready');
  const auth=await cdp.evaluate(`!!document.querySelector('.authCard')`);
  if(auth){
    await waitFor(()=>cdp.evaluate(`!!document.querySelector('.authCard select')`),Boolean,'Real login form');
    await cdp.evaluate(`(()=>{const select=document.querySelector('.authCard select');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,'password');select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    const password='R141-Test-Only-73#Native';
    const setup=await cdp.evaluate(`document.querySelector('.authCard h1')?.textContent==='Настройте вход'`);
    if(!setup){await cdp.evaluate(`document.querySelector('.authCard input[autocomplete="username"]').focus()`);await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await cdp.send('Input.insertText',{text:'admin'})}
    const count=setup?2:1;
    for(let index=0;index<count;index++){await cdp.evaluate(`document.querySelectorAll('.authCard input[type="password"]')[${index}].focus()`);await cdp.send('Input.insertText',{text:password})}
    await click('.authCard button.primary');
    await waitFor(()=>cdp.evaluate(`({ready:!!document.querySelector('.kfShell'),error:document.querySelector('.authError')?.textContent})`),value=>value.ready,'Authenticated real farm UI',45_000);
  }
  await waitFor(()=>cdp.evaluate(`document.querySelectorAll('.infoPrinterGrid [data-testid^="live-printer-"]').length`),count=>count===7,'Seven preserved printer cards',45_000);
  await screenshot('installed-main-before-TV');

  currentCase='borrowed-native-fullscreen-arrows-X-preserves-host';
  await windowCommand('set_fullscreen',{value:true});await waitFor(()=>nativeState(),state=>state.fullscreen,'Host native fullscreen setup');
  const borrowedBefore=await capture('borrowed-host-before-TV');fullscreenBounds(borrowedBefore);
  await tvOpen();await enterTvFullscreen();
  await click('button[aria-label="Выйти из полного экрана"]');await waitFor(()=>cdp.evaluate(`!!document.querySelector('button[aria-label="На весь экран"]')`),Boolean,'Borrowed TV arrow collapsed');
  assert.equal((await nativeState()).fullscreen,true,'TV arrow must not leave pre-existing host fullscreen');
  await enterTvFullscreen();const borrowedExpanded=await capture('borrowed-TV-expanded');fullscreenBounds(borrowedExpanded);await screenshot('installed-borrowed-native-fullscreen');
  await tvClose();const borrowedAfter=await capture('borrowed-host-after-X');fullscreenBounds(borrowedAfter);passed(currentCase,borrowedBefore,borrowedExpanded,borrowedAfter);

  currentCase='maximized-owned-fullscreen-X-restores-maximized';
  await restoreNormal();await windowCommand('maximize');await waitFor(()=>nativeState(),state=>state.maximized&&!state.fullscreen,'Native maximized setup');
  const maxBefore=await capture('maximized-before-TV');assert.equal(maxBefore.win32.isZoomed,true);
  await tvOpen();await enterTvFullscreen();const maxExpanded=await capture('maximized-TV-fullscreen');fullscreenBounds(maxExpanded);await screenshot('installed-maximized-owned-fullscreen');
  await tvClose();await waitFor(()=>nativeState(),state=>state.maximized&&!state.fullscreen,'X restores maximized window');
  await waitRestoredBounds(maxBefore.win32.bounds);
  const maxAfter=await capture('maximized-after-X');assert.equal(maxAfter.win32.isZoomed,true);sameBounds(maxAfter.win32.bounds,maxBefore.win32.bounds);passed(currentCase,maxBefore,maxExpanded,maxAfter);

  currentCase='normal-owned-fullscreen-X-restores-bounds';
  const normalBefore=await restoreNormal();assert.equal(normalBefore.win32.isZoomed,false);
  await tvOpen();await enterTvFullscreen();const normalExpanded=await capture('normal-TV-fullscreen');fullscreenBounds(normalExpanded);await screenshot('installed-normal-owned-fullscreen');
  await tvClose();await waitFor(()=>nativeState(),state=>!state.fullscreen&&!state.maximized,'X restores normal window');
  await waitRestoredBounds(normalBefore.win32.bounds);
  const normalAfter=await capture('normal-after-X');assert.equal(normalAfter.win32.isZoomed,false);sameBounds(normalAfter.win32.bounds,normalBefore.win32.bounds);passed(currentCase,normalBefore,normalExpanded,normalAfter);

  currentCase='normal-owned-fullscreen-Escape-restores-bounds';
  const escBefore=await capture('normal-before-Escape-case');await tvOpen();await enterTvFullscreen();const escExpanded=await capture('normal-before-Escape');fullscreenBounds(escExpanded);
  await escape();await waitFor(()=>nativeState(),state=>!state.fullscreen&&!state.maximized,'Escape restores normal window');
  await waitRestoredBounds(escBefore.win32.bounds);
  const escAfter=await capture('normal-after-Escape');sameBounds(escAfter.win32.bounds,escBefore.win32.bounds);passed(currentCase,escBefore,escExpanded,escAfter);

  currentCase='reopen-after-Escape-X-restores-bounds';
  const reopenBefore=await capture('normal-before-reopen');await tvOpen();await enterTvFullscreen();const reopenExpanded=await capture('reopened-TV-fullscreen');fullscreenBounds(reopenExpanded);
  await tvClose();await waitFor(()=>nativeState(),state=>!state.fullscreen&&!state.maximized,'Reopened TV X restores normal window');
  await waitRestoredBounds(reopenBefore.win32.bounds);
  const reopenAfter=await capture('normal-after-reopen-X');sameBounds(reopenAfter.win32.bounds,reopenBefore.win32.bounds);await screenshot('installed-normal-after-reopen-X');passed(currentCase,reopenBefore,reopenExpanded,reopenAfter);

  assert.deepEqual(runtimeErrors,[],'Unhandled errors in the installed WebView');assert.equal(sha(client),executableSha256);assert.equal(sha(helper),helperSha256);assert.equal(cases.length,5);
  const report={schemaVersion:1,release:'R141',passed:true,passedCases:cases.length,cases,actualInstalledWebView:true,actualWindowsWindowManager:true,actualFullscreenStateVerified:cases.every(value=>value.expanded.native.fullscreen===true),nativeWindowCallsReal:true,domFullscreenNeverUsed:observations.every(value=>!value.native.domFullscreen),configuredPrinters:fixture.printers.length,legacySpools:fixture.spoolCount,inventorySpools:fixture.inventorySpoolCount,physicalPrintersTested:false,printerTargets:'Seven synthetic 127.0.0.1 endpoints only; no discovery or printer commands.',client:{path:client,pid:child.pid,sha256:executableSha256},windowHelperSha256:helperSha256,webViewTarget:{type:target.type,url:target.url},nativeStateSource:'Real Tauri plugin:window IPC in the installed WebView2',windowManagerStateSource:'Win32 EnumWindows/GetWindowRect/GetWindowPlacement/IsZoomed/GetMonitorInfo scoped to the launched client PID',runtimeErrors,screenshots,observations,scope:'Actual installed R141 application and Windows host window. Authentication uses the real login UI against synthetic runner data. No product debug API or native-window mock.'};
  fs.writeFileSync(path.join(proof,'installed-fullscreen-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,passedCases:cases.length,report:path.join(proof,'installed-fullscreen-report.json')}));
}catch(error){
  let state;if(cdp){await screenshot('installed-fullscreen-failure').catch(()=>{});try{state=await capture('failure')}catch{}}
  fs.writeFileSync(path.join(proof,'installed-fullscreen-failure.json'),JSON.stringify({currentCase,error:String(error.stack??error),state,cases,observations,runtimeErrors,childExit,childError:childError?String(childError):undefined},null,2)+'\n');
  throw error;
}finally{
  if(cdp){await windowCommand('close').catch(()=>{});cdp.close()}
  if(!childExit&&!childError)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(10_000)]);
  if(!childExit&&!childError){execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:10_000,windowsHide:true})}
  for(let attempt=0;attempt<8;attempt++){try{fs.rmSync(profile,{recursive:true,force:true});break}catch{await delay(250)}}
}
