import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.platform,'win32');
const [clientArg,audioArg,proofArg]=process.argv.slice(2),client=path.resolve(clientArg),audio=path.resolve(audioArg),proof=path.resolve(proofArg);
fs.mkdirSync(proof,{recursive:true});
const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
const child=spawn(client,[],{cwd:path.dirname(client),stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(proof,'webview-profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture="${audio}" --autoplay-policy=no-user-gesture-required`}});
let exited,spawnError,cdp;const exceptions=[],externalRequests=[];
child.once('exit',(code,signal)=>{exited={code,signal}});child.once('error',error=>{spawnError=error});
const waitFor=async(read,predicate,label,timeout=45000)=>{let last;const deadline=Date.now()+timeout;while(Date.now()<deadline){if(spawnError)throw spawnError;if(exited)throw new Error('Installed app exited: '+JSON.stringify(exited));try{last=await read();if(predicate(last))return last}catch(error){last=String(error)}await delay(250)}throw new Error('Timed out: '+label+'; '+JSON.stringify(last))};
class Cdp{
 constructor(socket){this.socket=socket;this.next=0;this.pending=new Map();socket.addEventListener('message',event=>{
  const message=JSON.parse(String(event.data));
  if(message.id){const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error(JSON.stringify(message.error))):request.resolve(message.result)}
  else if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails?.exception?.description??message.params.exceptionDetails?.text);
  else if(message.method==='Network.requestWillBeSent'){const url=message.params.request?.url??'';if(/^https?:/.test(url)&&!['tauri.localhost','ipc.localhost','localhost','127.0.0.1'].includes(new URL(url).hostname))externalRequests.push(url)}
 });socket.addEventListener('close',()=>{for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('WebView closed'))}this.pending.clear()})}
 static async open(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CDP open timeout')),15000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'))},{once:true})});return new Cdp(socket)}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout: '+method))},120000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}))})}
 async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result?.value}
 close(){this.socket.close()}
}
try{
 const target=await waitFor(async()=>{const r=await fetch(`http://127.0.0.1:${port}/json/list`);return(await r.json()).find(item=>item.type==='page'&&/^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(item.url))},Boolean,'installed WebView2',90000);
 cdp=await Cdp.open(target.webSocketDebuggerUrl);await cdp.send('Runtime.enable');await cdp.send('Network.enable');
 // The loading screen also has .authCard; wait for the actual setup form.
 await waitFor(()=>cdp.evaluate('({heading:document.querySelector(".authCard h1")?.textContent,fields:document.querySelectorAll(".authCard input[type=password]").length})'),state=>state?.heading==='Настройте вход'&&state.fields===2,'clean install setup form');
 assert.match(await cdp.evaluate('document.querySelector(".authCard h1").textContent'),/Настройте вход/);
 await cdp.evaluate(`(()=>{
  window.__speechSmoke={samples:[],transcripts:[],playback:0,errors:[],energy:0,frames:0,nativeTimings:[]};
  const originalFetch=window.fetch;
  window.fetch=async function(input,options){
   const started=performance.now(),response=await originalFetch.call(window,input,options),url=new URL(typeof input==='string'?input:input.url??String(input),location.href);
   const command=url.hostname==='ipc.localhost'?decodeURIComponent(url.pathname.slice(1)):'';
   if(['auth_bootstrap','voice_synthesize','voice_transcribe'].includes(command)){
    const value=(response.headers.get('content-type')??'').startsWith('application/json')?await response.clone().json():await response.clone().text();
    const args=typeof options?.body==='string'?JSON.parse(options.body):{};
    if(command.startsWith('voice_'))window.__speechSmoke.nativeTimings.push({command,milliseconds:Math.round(performance.now()-started),modelId:args.modelId});
    if(response.headers.get('Tauri-Response')!=='ok'){if(command.startsWith('voice_'))window.__speechSmoke.errors.push(String(value));return response}
    if(command==='auth_bootstrap')window.__speechSmokeSession=value.token;
    if(command==='voice_synthesize'){let sum=0;for(let i=0;i<value.pcm.length;i+=2){let sample=value.pcm[i]|(value.pcm[i+1]<<8);if(sample>=32768)sample-=65536;sum+=(sample/32768)**2}window.__speechSmoke.samples.push({voiceId:args.voiceId,bytes:value.pcm.length,sampleRate:value.sampleRate,rms:Math.sqrt(sum/(value.pcm.length/2))})}
    if(command==='voice_transcribe')window.__speechSmoke.transcripts.push(value);
   }
   return response;
  };
  const play=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...args){const pending=play.apply(this,args);pending.then(()=>window.__speechSmoke.playback++,()=>{});return pending};
  const Worklet=window.AudioWorkletNode;window.AudioWorkletNode=class extends Worklet{constructor(...args){super(...args);this.port.addEventListener('message',event=>{if(event.data instanceof Float32Array){window.__speechSmoke.frames+=event.data.length;for(const value of event.data)window.__speechSmoke.energy=Math.max(window.__speechSmoke.energy,Math.abs(value))}});this.port.start()}};
 })()`);
 const password='Voice2!Aa'+randomBytes(20).toString('hex');
 for(const index of [0,1]){await cdp.evaluate(`document.querySelectorAll('.authCard input[type="password"]')[${index}].focus()`);await cdp.send('Input.insertText',{text:password})}
 await waitFor(()=>cdp.evaluate('!document.querySelector(".authCard button.primary").disabled'),Boolean,'setup form enabled');
 await cdp.evaluate('document.querySelector(".authCard button.primary").click()');
 await waitFor(()=>cdp.evaluate('!!document.querySelector(".wizard .wizardNext")'),Boolean,'fresh-install setup wizard',60000);
 await cdp.evaluate('document.querySelector(".wizard .wizardNext").click()');
 await waitFor(()=>cdp.evaluate('!!document.querySelector(".wizardActions > button")'),Boolean,'optional printer setup');
 await cdp.evaluate('document.querySelector(".wizardActions > button").click()');
 await waitFor(()=>cdp.evaluate('!!document.querySelector(".wizard .wizardNext")'),Boolean,'setup completion');
 await cdp.evaluate('document.querySelector(".wizard .wizardNext").click()');
 await waitFor(()=>cdp.evaluate('!!document.querySelector(\'button[aria-label="Голосовой помощник"]\')'),Boolean,'actual authenticated application',60000);
 const identity=await cdp.evaluate(`(async()=>await(await fetch(new URL('/BUILD-PROVENANCE.json',location.href))).json())()`);
 assert.equal(identity.buildId,process.env.KF_EXPECTED_BUILD_ID||'V20.6-R14.5-OFFLINE-VOICE-PREVIEW9-2026-10-30');
 const status=await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('voice_tools_status',{sessionToken:window.__speechSmokeSession})`);
 assert.equal(status.recognition,true);assert.equal(status.synthesis,true);
 await cdp.evaluate('document.querySelector(\'button[aria-label="Голосовой помощник"]\').click()');
 await waitFor(()=>cdp.evaluate('!!document.querySelector(".kfVoicePanel")'),Boolean,'assistant panel');
 assert.equal(await cdp.evaluate('document.querySelector(\'select[aria-label="Режим распознавания"]\').value'),'base');
 await cdp.evaluate(`Promise.all(['recognition','synthesis'].map(engine=>window.__TAURI_INTERNALS__.invoke('voice_prepare',{sessionToken:window.__speechSmokeSession,engine})))`);
 assert.equal(await cdp.evaluate('document.querySelector(\'select[aria-label="Голос помощника"]\').value'),'kseniya');
 for(const [index,voice] of ['kseniya'].entries()){
  await cdp.evaluate(`(()=>{const select=document.querySelector('select[aria-label="Голос помощника"]');select.value=${JSON.stringify(voice)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('.kfVoicePanel button')).find(button=>button.textContent.trim()==='Послушать').click()`);
  await waitFor(()=>cdp.evaluate(`window.__speechSmoke.samples.find(sample=>sample.voiceId===${JSON.stringify(voice)})`),Boolean,'packaged neural voice '+voice,60000);
  await waitFor(()=>cdp.evaluate('window.__speechSmoke.playback'),count=>count>=index+1,'audible playback '+voice,15000);
 }
 await cdp.evaluate('document.querySelector(\'button[aria-label="Включить микрофон"]\').click()');
 const recognized=await waitFor(()=>cdp.evaluate('window.__speechSmoke.transcripts[0]'),Boolean,'actual microphone to native Whisper transcription',45000);
 assert.match(recognized.toLowerCase(),/(?:сколько|остат|остал|запас).*пластик/);
 await waitFor(()=>cdp.evaluate(`Array.from(document.querySelectorAll('.kfVoiceMessage.assistant')).some(item=>item.textContent.includes('Общий запас пластика'))`),Boolean,'recognized question answered through real inventory');
 await waitFor(()=>cdp.evaluate('window.__speechSmoke.playback'),count=>count>=2,'recognized answer is spoken on the first attempt',30000);
 const repeatedReplies=[];
 for(let index=0;index<5;index++){
  const before=await cdp.evaluate('window.__speechSmoke.playback'),started=Date.now();
  await cdp.evaluate(`Array.from(document.querySelectorAll('.kfVoiceSuggestions button')).find(button=>button.textContent==='Сколько осталось пластика?').click()`);
  await waitFor(()=>cdp.evaluate('window.__speechSmoke.playback'),count=>count===before+1,'consecutive spoken reply '+(index+1),15000);
  repeatedReplies.push(Date.now()-started);
 }
 const result=await cdp.evaluate('window.__speechSmoke');
 assert(result.energy>0.001&&result.frames>4800);assert.equal(result.transcripts.length,1);assert.deepEqual(result.errors,[]);
 for(const voice of ['kseniya']){const sample=result.samples.find(item=>item.voiceId===voice);assert(sample.bytes>48000);assert.equal(sample.sampleRate,48000);assert(sample.rms>0.001)}
 assert.deepEqual(exceptions,[]);assert.deepEqual(externalRequests,[]);
 const report={passed:true,buildId:identity.buildId,actualInstalledWebView:true,packagedWhisper:true,recognitionModel:'base',packagedSileroVoices:['kseniya'],packagedPython:true,actualWorklet:true,syntheticMicrophone:true,physicalPrintersTested:false,hardwareMicrophoneTested:false,recognized,consecutiveSpokenReplies:repeatedReplies.length,replyPlaybackMilliseconds:repeatedReplies,nativeTimings:result.nativeTimings,voiceSamples:result.samples,microphoneEnergy:result.energy,microphoneFrames:result.frames,frontendExternalRequests:externalRequests};
 await cdp.evaluate('document.querySelector(\'button[aria-label="Выключить голосовые ответы"]\').click()');
 const submitText=async text=>{
  await cdp.evaluate('document.querySelector(\'input[aria-label="Команда помощнику"]\').focus()');
  await cdp.send('Input.insertText',{text});
  await waitFor(()=>cdp.evaluate('!document.querySelector(\'button[aria-label="Отправить команду"]\').disabled'),Boolean,'conversation text input enabled');
  await cdp.evaluate('document.querySelector(\'button[aria-label="Отправить команду"]\').click()');
 };
 await submitText('K1 Max, поставь на печать');
 await waitFor(()=>cdp.evaluate('Array.from(document.querySelectorAll(".kfVoiceMessage.assistant")).at(-1)?.textContent'),text=>text?.includes('Какой файл'),'installed missing-filename clarification');
 await submitText('Отмена');
 await waitFor(()=>cdp.evaluate('Array.from(document.querySelectorAll(".kfVoiceMessage.assistant")).at(-1)?.textContent'),text=>text?.includes('Действие отменено'),'installed conversation cancellation');
 await submitText('этот файл');
 await waitFor(()=>cdp.evaluate('Array.from(document.querySelectorAll(".kfVoiceMessage.assistant")).at(-1)?.textContent'),text=>text?.includes('Какой файл'),'installed missing-reference clarification');
 assert.match(await cdp.evaluate('document.querySelector(".kfVoiceLearning summary")?.textContent'),/Запомненные названия: 0/);
 assert.equal(await cdp.evaluate('!!document.querySelector(\'button[aria-label="Включить микрофон"]\')'),true);
 report.conversationUI={passed:true,missingFileClarification:true,cancelClearsReference:true,profileLearningControls:true,generalMicrophoneAvailable:true,physicalPrintersTested:false};
 const dialogueScreenshot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(proof,'installed-conversation.png'),Buffer.from(dialogueScreenshot.data,'base64'));
 const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(proof,'installed-neural-speech.png'),Buffer.from(screenshot.data,'base64'));
 await cdp.evaluate('document.querySelector(\'button[aria-label="Закрыть помощника"]\').click()');
 await cdp.evaluate(`Array.from(document.querySelectorAll('.kfSidebar nav button')).find(button=>button.textContent.trim()==='Настройки').click()`);
 await waitFor(()=>cdp.evaluate('!!document.querySelector(".systemPanel .prodTabs")'),Boolean,'installed settings panel');
 await cdp.evaluate(`Array.from(document.querySelectorAll('.systemPanel .prodTabs button')).find(button=>button.textContent.trim()==='Приложение').click()`);
 const nearEndSelector='[aria-label="Предупреждение перед окончанием печати"]';
 const settings=await waitFor(()=>cdp.evaluate(`(()=>{const card=document.querySelector(${JSON.stringify(nearEndSelector)});return card?{enabled:card.querySelector('input').checked,lead:card.querySelector('select').value,choices:Array.from(card.querySelectorAll('option')).map(option=>Number(option.value))}:null})()`),Boolean,'installed near-end voice settings');
 assert.equal(settings.enabled,true);assert.equal(settings.lead,'10');assert.deepEqual(settings.choices,[5,10,15,30]);
 await cdp.evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(nearEndSelector)}).querySelector('select');select.value='5';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await waitFor(()=>cdp.evaluate(`JSON.parse(localStorage.getItem('klipper-print-near-end-v1')||'null')?.leadMinutes`),value=>value===5,'persisted near-end lead time');
 await cdp.evaluate(`document.querySelector(${JSON.stringify(nearEndSelector)}).querySelector('input').click()`);
 await waitFor(()=>cdp.evaluate(`({enabled:JSON.parse(localStorage.getItem('klipper-print-near-end-v1')||'null')?.enabled,disabled:document.querySelector(${JSON.stringify(nearEndSelector)}).querySelector('select').disabled})`),value=>value?.enabled===false&&value.disabled,'disabled near-end voice preference');
 await cdp.evaluate(`document.querySelector(${JSON.stringify(nearEndSelector)}).querySelector('input').click()`);
 await waitFor(()=>cdp.evaluate(`document.querySelector(${JSON.stringify(nearEndSelector)}).querySelector('select').disabled`),value=>value===false,'re-enabled near-end preference');
 await cdp.evaluate(`(()=>{const select=document.querySelector(${JSON.stringify(nearEndSelector)}).querySelector('select');select.value='10';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await waitFor(()=>cdp.evaluate(`JSON.parse(localStorage.getItem('klipper-print-near-end-v1')||'null')`),value=>value?.enabled===true&&value.leadMinutes===10,'restored near-end defaults');
 await cdp.evaluate(`document.querySelector(${JSON.stringify(nearEndSelector)}).scrollIntoView({block:'center'})`);
 report.nearEndSettings={passed:true,defaultLeadMinutes:10,choicesMinutes:settings.choices,persistenceVerified:true,disabledStateVerified:true,physicalPrintForecastTested:false};
 const settingsScreenshot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(proof,'installed-near-end-settings.png'),Buffer.from(settingsScreenshot.data,'base64'));
 const backgroundSelector='[aria-label="Фоновый режим"]';
 const backgroundStatus=()=>cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('background_mode_get',{sessionToken:window.__speechSmokeSession})`);
 const backgroundPreference=()=>cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('db_get_json',{sessionToken:window.__speechSmokeSession,key:'desktop.background'}).then(value=>value?JSON.parse(value):null)`);
 const initialBackground=await backgroundStatus();assert.equal(initialBackground.enabled,false);assert.equal(initialBackground.available,true);
 await waitFor(()=>cdp.evaluate(`(()=>{const card=document.querySelector(${JSON.stringify(backgroundSelector)});return card&&!card.querySelector('input').disabled})()`),Boolean,'installed background settings ready');
 assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(backgroundSelector)}).querySelector('input').checked`),false);
 await cdp.evaluate(`document.querySelector(${JSON.stringify(backgroundSelector)}).querySelector('input').click()`);
 await waitFor(backgroundStatus,value=>value?.enabled===true&&value.available,'native opt-in close-to-tray mode');
 assert.equal((await backgroundPreference()).enabled,true);
 const documentMarker=randomBytes(12).toString('hex');
 await cdp.evaluate(`(()=>{const state=window.__backgroundSmoke={marker:${JSON.stringify(documentMarker)},ticks:0,last:performance.now(),maxGap:0};state.timer=setInterval(()=>{const now=performance.now();state.maxGap=Math.max(state.maxGap,now-state.last);state.last=now;state.ticks++},500)})()`);
 await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`);
 await waitFor(()=>cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'})`),value=>value===false,'main close hides instead of destroys');
 const hiddenStarted=Date.now(),hiddenDuration=315000;
 // Keep the renderer untouched for more than five minutes. Progress and the
 // process liveness check run in Node, not through CDP/page timers.
 let nextProgress=hiddenStarted;
 while(Date.now()-hiddenStarted<hiddenDuration){
  if(spawnError)throw spawnError;if(exited)throw new Error('Background app exited: '+JSON.stringify(exited));
  if(Date.now()>=nextProgress){console.log('Installed hidden monitoring check: '+Math.floor((Date.now()-hiddenStarted)/1000)+' / 315 seconds');nextProgress=Date.now()+30000}
  await delay(Math.min(10000,hiddenDuration-(Date.now()-hiddenStarted)));
 }
 const hiddenElapsed=Date.now()-hiddenStarted;
 const hiddenTimers=await cdp.evaluate(`(()=>{const state=window.__backgroundSmoke;return{marker:state?.marker,ticks:state?.ticks,maxGap:state?.maxGap,lastTickAge:performance.now()-state?.last,visibility:document.visibilityState}})()`);
 assert.equal(hiddenTimers.marker,documentMarker);
 // WebView2 page visibility is independent of its native parent window.
 // Verify the actual host remains hidden after the complete untouched interval.
 assert.equal(await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'})`),false,'native window became visible during background monitoring');
 assert(hiddenTimers.ticks>=125,'hidden WebView timers stopped or were heavily throttled');
 assert(hiddenTimers.maxGap<15000,'hidden WebView timer gap exceeded 15 seconds');assert(hiddenTimers.lastTickAge<5000,'hidden WebView timer is stale');
 await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('native_notify',{sessionToken:window.__speechSmokeSession,title:'Проверка фонового режима',body:'Приложение продолжает работать в трее.'})`);
 const hiddenPlaybackBefore=await cdp.evaluate('window.__speechSmoke.playback');
 await cdp.evaluate(`(async()=>{
  const value=await window.__TAURI_INTERNALS__.invoke('voice_synthesize',{sessionToken:window.__speechSmokeSession,text:'Фоновый режим работает.',voiceId:'kseniya'});
  const wave=new Uint8Array(44+value.pcm.length),view=new DataView(wave.buffer),word=(offset,text)=>{for(let i=0;i<text.length;i++)wave[offset+i]=text.charCodeAt(i)};
  word(0,'RIFF');view.setUint32(4,36+value.pcm.length,true);word(8,'WAVE');word(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,value.sampleRate,true);view.setUint32(28,value.sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);word(36,'data');view.setUint32(40,value.pcm.length,true);wave.set(value.pcm,44);
  const url=URL.createObjectURL(new Blob([wave],{type:'audio/wav'})),audio=new Audio(url);window.__backgroundSmoke.audio=audio;audio.addEventListener('ended',()=>URL.revokeObjectURL(url),{once:true});await audio.play();
 })()`);
 await waitFor(()=>cdp.evaluate('window.__speechSmoke.playback'),count=>count===hiddenPlaybackBefore+1,'packaged neural voice plays while hidden',15000);
 const trayAction=action=>{
  const helper=path.join(import.meta.dirname,'r146-voice-quality','check-installed-background-tray.ps1');
  if(!fs.existsSync(helper))throw new Error('Installed tray test helper is missing');
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Action',action],{encoding:'utf8',timeout:15000,windowsHide:true});
  const value=JSON.parse(output.trim());assert.equal(typeof value.available,'boolean');assert.equal(typeof value.performed,'boolean');
  if(value.available&&!value.performed)throw new Error('Tray '+action+' failed: '+value.reason);
  return value;
 };
 const trayOpen=trayAction('open');
 if(!trayOpen.performed){
  // A CI session may have no Explorer notification area. Test the existing
  // native second-instance restoration, and report tray UI as untested.
  const secondary=spawn(client,[],{cwd:path.dirname(client),stdio:'ignore',env:process.env});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{secondary.kill();reject(new Error('Secondary-instance restore timed out'))},15000);secondary.once('error',error=>{clearTimeout(timeout);reject(error)});secondary.once('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error('Secondary-instance restore failed: '+code))})});
 }
 await waitFor(()=>cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'})`),Boolean,'native restore shows the same main window');
 assert.equal(await cdp.evaluate('window.__backgroundSmoke.marker'),documentMarker);assert.equal((await backgroundStatus()).enabled,true);
 await cdp.evaluate('clearInterval(window.__backgroundSmoke.timer)');
 await cdp.evaluate(`document.querySelector(${JSON.stringify(backgroundSelector)}).querySelector('input').click()`);
 await waitFor(backgroundStatus,value=>value?.enabled===false,'disabled close-to-tray preference restored');assert.equal((await backgroundPreference()).enabled,false);
 const ownedDaemonIds=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name='klipper-farmd.exe'" | Where-Object { $_.ParentProcessId -eq ${child.pid} } | ForEach-Object { [int]$_.ProcessId })`],{encoding:'utf8',timeout:10000,windowsHide:true}));
 const trayQuit=trayAction('quit');
 if(trayQuit.performed){
  const quitDeadline=Date.now()+20000;while(!exited&&Date.now()<quitDeadline)await delay(100);
  assert(exited,'explicit tray Quit did not terminate the desktop');assert.equal(exited.code,0);
  if(ownedDaemonIds.length){
   const surviving=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`ConvertTo-Json -Compress -InputObject @(Get-Process -Id ${ownedDaemonIds.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })`],{encoding:'utf8',timeout:10000,windowsHide:true}));
   assert.deepEqual(surviving,[],'desktop-owned daemon survived explicit tray Quit');
  }
 }
 report.backgroundMode={passed:true,optInDefaultOff:true,nativePreferencesPersisted:true,closeRetainsWebView:true,hiddenMilliseconds:hiddenElapsed,nativeWindowHidden:true,rendererVisibility:hiddenTimers.visibility,timerTicks:hiddenTimers.ticks,maxTimerGapMilliseconds:Math.round(hiddenTimers.maxGap),nativeNotificationAcceptedWhileHidden:true,packagedVoicePlaybackWhileHidden:true,restoredSameDocument:true,trayOpen,trayQuit,ownedDaemonsObserved:ownedDaemonIds.length,explicitQuitCleanupTested:trayQuit.performed,physicalPrintEventsTested:false,physicalToastDisplayTested:false,interactiveDebuggerAttached:true};
 assert.deepEqual(exceptions,[]);assert.deepEqual(externalRequests,[]);
 fs.writeFileSync(path.join(proof,'installed-neural-speech.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}catch(error){if(cdp)try{const detail=await cdp.evaluate('({assistant:document.querySelector(".kfVoicePanel")?.innerText,authError:document.querySelector(".authError")?.innerText,speech:window.__speechSmoke,background:window.__backgroundSmoke&&{ticks:window.__backgroundSmoke.ticks,maxGap:window.__backgroundSmoke.maxGap,lastTickAge:performance.now()-window.__backgroundSmoke.last,visibility:document.visibilityState}})');fs.writeFileSync(path.join(proof,'installed-neural-speech-failure.json'),JSON.stringify({error:String(error),detail,exceptions,externalRequests},null,2))}catch{}throw error}
finally{
 if(cdp){try{if(!exited){await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('background_mode_set',{sessionToken:window.__speechSmokeSession,enabled:false})`).catch(()=>{});await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`)}}catch{}cdp.close()}
 await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);
 if(!exited)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:10000})}catch{}
}
