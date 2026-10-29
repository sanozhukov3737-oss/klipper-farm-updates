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
 await waitFor(()=>cdp.evaluate('!!document.querySelector(".authCard")'),Boolean,'clean install authentication');
 assert.match(await cdp.evaluate('document.querySelector(".authCard h1").textContent'),/Настройте вход/);
 await cdp.evaluate(`(()=>{
  window.__speechSmoke={samples:[],transcripts:[],playback:0,errors:[],energy:0,frames:0};
  const originalFetch=window.fetch;
  window.fetch=async function(input,options){
   const response=await originalFetch.call(window,input,options),url=new URL(typeof input==='string'?input:input.url??String(input),location.href);
   const command=url.hostname==='ipc.localhost'?decodeURIComponent(url.pathname.slice(1)):'';
   if(['auth_bootstrap','voice_synthesize','voice_transcribe'].includes(command)){
    const value=(response.headers.get('content-type')??'').startsWith('application/json')?await response.clone().json():await response.clone().text();
    const args=typeof options?.body==='string'?JSON.parse(options.body):{};
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
 assert.equal(identity.buildId,'V20.6-R14.5-OFFLINE-VOICE-PREVIEW4-2026-10-29');
 const status=await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('voice_tools_status',{sessionToken:window.__speechSmokeSession})`);
 assert.equal(status.recognition,true);assert.equal(status.synthesis,true);
 await cdp.evaluate('document.querySelector(\'button[aria-label="Голосовой помощник"]\').click()');
 await waitFor(()=>cdp.evaluate('!!document.querySelector(".kfVoicePanel")'),Boolean,'assistant panel');
 assert.equal(await cdp.evaluate('document.querySelector(\'select[aria-label="Голос помощника"]\').value'),'kseniya');
 for(const [index,voice] of ['kseniya'].entries()){
  await cdp.evaluate(`(()=>{const select=document.querySelector('select[aria-label="Голос помощника"]');select.value=${JSON.stringify(voice)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('.kfVoicePanel button')).find(button=>button.textContent.trim()==='Послушать').click()`);
  await waitFor(()=>cdp.evaluate(`window.__speechSmoke.samples.find(sample=>sample.voiceId===${JSON.stringify(voice)})`),Boolean,'packaged neural voice '+voice,60000);
  await waitFor(()=>cdp.evaluate('window.__speechSmoke.playback'),count=>count>=index+1,'audible playback '+voice,15000);
 }
 await cdp.evaluate('document.querySelector(\'button[aria-label="Включить микрофон"]\').click()');
 const recognized=await waitFor(()=>cdp.evaluate('window.__speechSmoke.transcripts[0]'),Boolean,'actual microphone to native Whisper transcription',120000);
 assert.match(recognized.toLowerCase(),/(?:сколько|остат|остал|запас).*пластик/);
 await waitFor(()=>cdp.evaluate(`Array.from(document.querySelectorAll('.kfVoiceMessage.assistant')).some(item=>item.textContent.includes('Общий запас пластика'))`),Boolean,'recognized question answered through real inventory');
 const result=await cdp.evaluate('window.__speechSmoke');
 assert(result.energy>0.001&&result.frames>4800);assert.equal(result.transcripts.length,1);assert.deepEqual(result.errors,[]);
 for(const voice of ['kseniya']){const sample=result.samples.find(item=>item.voiceId===voice);assert(sample.bytes>48000);assert.equal(sample.sampleRate,48000);assert(sample.rms>0.001)}
 assert.deepEqual(exceptions,[]);assert.deepEqual(externalRequests,[]);
 const report={passed:true,buildId:identity.buildId,actualInstalledWebView:true,packagedWhisper:true,packagedSileroVoices:['kseniya'],packagedPython:true,actualWorklet:true,syntheticMicrophone:true,physicalPrintersTested:false,hardwareMicrophoneTested:false,recognized,voiceSamples:result.samples,microphoneEnergy:result.energy,microphoneFrames:result.frames,frontendExternalRequests:externalRequests};
 fs.writeFileSync(path.join(proof,'installed-neural-speech.json'),JSON.stringify(report,null,2)+'\n');
 const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(proof,'installed-neural-speech.png'),Buffer.from(screenshot.data,'base64'));
 console.log(JSON.stringify(report));
}catch(error){if(cdp)try{const detail=await cdp.evaluate('({assistant:document.querySelector(".kfVoicePanel")?.innerText,authError:document.querySelector(".authError")?.innerText,speech:window.__speechSmoke})');fs.writeFileSync(path.join(proof,'installed-neural-speech-failure.json'),JSON.stringify({error:String(error),detail,exceptions,externalRequests},null,2))}catch{}throw error}
finally{
 if(cdp){try{await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`)}catch{}cdp.close()}
 await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);
 if(!exited)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:10000})}catch{}
}
