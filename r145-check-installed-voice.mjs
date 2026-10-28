import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
assert.equal(process.platform,'win32');
const [clientArg,audioArg,proofArg]=process.argv.slice(2),client=path.resolve(clientArg),audio=path.resolve(audioArg),proof=path.resolve(proofArg);fs.mkdirSync(proof,{recursive:true});
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const child=spawn(client,[],{cwd:path.dirname(client),stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(proof,'webview-profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture="${audio}" --autoplay-policy=no-user-gesture-required`}});
let childExit,childError,cdp;const runtimeErrors=[];child.once('exit',(code,signal)=>{childExit={code,signal}});child.once('error',error=>{childError=error});
const waitFor=async(read,predicate,label,timeout=45000)=>{let last;const deadline=Date.now()+timeout;while(Date.now()<deadline){if(childError)throw childError;if(childExit)throw new Error('Installed application exited: '+JSON.stringify(childExit));try{last=await read();if(predicate(last))return last}catch(error){last=String(error)}await delay(200)}throw new Error('Timed out: '+label+'; '+JSON.stringify(last))};
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
  send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP command timed out: ${method}`))},90_000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}))})}
  async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result?.value}
  close(){this.socket.close()}
}

try{
 const target=await waitFor(async()=>{const response=await fetch(`http://127.0.0.1:${port}/json/list`);return(await response.json()).find(x=>x.type==='page'&&/^(?:https?:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(x.url))},Boolean,'real installed WebView2',90000);
 assert.ok(['127.0.0.1','localhost'].includes(new URL(target.webSocketDebuggerUrl).hostname));
 cdp=await CdpConnection.open(target.webSocketDebuggerUrl);await cdp.send('Runtime.enable');
 await waitFor(()=>cdp.evaluate('!!document.querySelector(".authCard,.kfShell")'),Boolean,'actual installed UI');
 const audioBase64=fs.readFileSync(audio).toString('base64');
 const expression=`(async()=>{
  const provenance=await(await fetch(new URL('/BUILD-PROVENANCE.json',location.href))).json();
  if(provenance.buildId!=='V20.6-R14.5-OFFLINE-VOICE-PREVIEW-2026-10-28')throw new Error('Installed frontend identity differs');
  if(!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode)throw new Error('Installed WebView microphone APIs unavailable');
  await import(new URL('/voice/vosk-csp.js',location.href).href);
  const model=new Vosk.Model(new URL('/voice/ru-small.tar.gz',location.href).href,-1);
  let stream,context,capture,source;
  try{
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Packaged model load timeout')),45000);model.on('load',m=>{clearTimeout(timer);m.result?resolve():reject(new Error('Packaged model failed'))});model.on('error',m=>{clearTimeout(timer);reject(new Error(m.error))})});
   context=new AudioContext();await context.resume();stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
   await context.audioWorklet.addModule(new URL('/voice/capture.js',location.href).href);
   source=context.createMediaStreamSource(stream);capture=new AudioWorkletNode(context,'farm-voice-capture');source.connect(capture);capture.connect(context.destination);
   const energy=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No audio in installed WebView worklet')),12000);capture.port.onmessage=event=>{const max=Math.max(...event.data.map(Math.abs));if(max>0.001){clearTimeout(timer);resolve(max)}}});
   capture.disconnect();source.disconnect();stream.getTracks().forEach(t=>t.stop());
   const bytes=Uint8Array.from(atob(${JSON.stringify(audioBase64)}),c=>c.charCodeAt(0));const buffer=await context.decodeAudioData(bytes.buffer);
   const recognizer=new model.KaldiRecognizer(buffer.sampleRate);
   const recognized=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No speech result')),12000);recognizer.on('result',message=>{const text=message.result?.text?.trim();if(text){clearTimeout(timer);resolve(text)}});recognizer.on('error',message=>{clearTimeout(timer);reject(new Error(message.error))});recognizer.acceptWaveform(buffer);recognizer.retrieveFinalResult()});
   recognizer.remove();return{buildId:provenance.buildId,recognized,realInstalledWebView:true,packagedOfflineModel:true,actualAudioWorklet:true,fakeMicrophone:true,energy};
  }finally{capture?.disconnect();source?.disconnect();stream?.getTracks().forEach(t=>t.stop());if(context)await context.close();model.terminate()}
 })()`;
 const result=await cdp.evaluate(expression);assert.match(result.recognized,/сколько.*(?:остал|остат).*пластик/);assert.deepEqual(runtimeErrors,[]);
 const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(proof,'installed-voice.png'),Buffer.from(shot.data,'base64'));
 const report={passed:true,physicalPrintersTested:false,hardwareMicrophoneTested:false,...result};fs.writeFileSync(path.join(proof,'installed-voice-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
 if(cdp){try{await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`)}catch{}cdp.close()}
 await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);
 if(!childExit)try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:10000})}catch{}
}
