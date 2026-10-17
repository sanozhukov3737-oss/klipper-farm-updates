import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import ts from './typescript-runtime.mjs';

// Physical browser acceptance for the production decoder sampler. This covers
// an occluded/hidden document; the installed Windows minimize probe separately
// covers the native desktop and headless printer actors.
const root=path.resolve(import.meta.dirname,'..');
const mode=process.env.KF_CAMERA_BROWSER_MODE||'headless';
assert(['headless','headed'].includes(mode),'KF_CAMERA_BROWSER_MODE must be headless or headed');
const diagnosticsDirectory=path.resolve(process.env.KF_UI_SCREENSHOTS||path.join(os.tmpdir(),'kf-r118-camera-browser',mode));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH?pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href:'playwright');
const modules=Object.fromEntries(['cameraVideoFrames','backgroundActivity'].map(name=>[name,ts.transpileModule(fs.readFileSync(path.join(root,`src/lib/${name}.ts`),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText]));
const server=http.createServer((req,res)=>{
  const name=req.url?.slice(1).replace(/\.js$/,'');
  res.setHeader('Content-Type',name&&modules[name]?'text/javascript':'text/html');
  res.end(name&&modules[name]?modules[name]:'<!doctype html><title>R118 camera background acceptance</title><body></body>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,receiver,sender,browserCdp;
const nativeWindows={};
const browserEvents=[];
const watchPage=(page,label)=>{
  page.on('console',message=>{if(browserEvents.length<80)browserEvents.push({page:label,type:message.type(),text:message.text().slice(0,1000)})});
  page.on('pageerror',error=>{if(browserEvents.length<80)browserEvents.push({page:label,type:'pageerror',text:String(error).slice(0,1000)})});
};
const snapshot=async(page,label)=>{
  if(!page)return{page:label,missing:true};
  try{return await page.evaluate(async label=>{
    const pc=window.pc,video=window.video;
    const fields=['id','type','kind','mediaType','timestamp','ssrc','framesDecoded','framesReceived','framesDropped','framesPerSecond','keyFramesDecoded','framesEncoded','packetsReceived','packetsSent','packetsLost','bytesReceived','bytesSent','lastPacketReceivedTimestamp','state','nominated','selectedCandidatePairId','localCandidateId','remoteCandidateId','requestsSent','responsesReceived','mimeType','decoderImplementation','powerEfficientDecoder'];
    const stats=[];
    if(pc)try{(await pc.getStats()).forEach(row=>{if(['inbound-rtp','outbound-rtp','candidate-pair','transport','codec'].includes(row.type))stats.push(Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]])))})}catch(error){stats.push({error:String(error)})}
    return {page:label,hidden:document.hidden,visibilityState:document.visibilityState,hasFocus:document.hasFocus(),userAgent:navigator.userAgent,secureContext:isSecureContext,lockApi:!!navigator.locks,paintCount:window.paintCount,
      video:video?{readyState:video.readyState,width:video.videoWidth,height:video.videoHeight,paused:video.paused,currentTime:video.currentTime,error:video.error?{code:video.error.code,message:video.error.message}:null,playError:window.playError,playback:video.getVideoPlaybackQuality?.(),tracks:video.srcObject instanceof MediaStream?video.srcObject.getTracks().map(track=>({kind:track.kind,readyState:track.readyState,muted:track.muted,enabled:track.enabled})):[]}:null,
      peer:pc?{connectionState:pc.connectionState,iceConnectionState:pc.iceConnectionState,iceGatheringState:pc.iceGatheringState,signalingState:pc.signalingState}:null,
      capturedCount:window.captured?.length,captured:window.captured?.slice(-8),unavailable:window.unavailable?.slice(-8),stats};
  },label)}catch(error){return{page:label,error:String(error)}}
};
const diagnose=async(stage,saveImages=false)=>{
  const windows={};
  if(browserCdp)for(const [label,window] of Object.entries(nativeWindows))try{windows[label]={...window,...await browserCdp.send('Browser.getWindowBounds',{windowId:window.windowId})}}catch(error){windows[label]={...window,error:String(error)}}
  const state={mode,stage,at:new Date().toISOString(),windows,pages:await Promise.all([snapshot(receiver,'receiver'),snapshot(sender,'sender')]),browserEvents:[...browserEvents]};
  fs.mkdirSync(diagnosticsDirectory,{recursive:true});
  const filename=stage.replace(/[^a-z0-9_-]/gi,'-');
  fs.writeFileSync(path.join(diagnosticsDirectory,`${filename}.json`),JSON.stringify(state,null,2));
  console.log(`R118 WebRTC browser diagnostics ${JSON.stringify(state)}`);
  if(saveImages)for(const [label,page] of [['receiver',receiver],['sender',sender]])if(page)try{await page.screenshot({path:path.join(diagnosticsDirectory,`${filename}-${label}.png`),timeout:3000})}catch(error){console.log(`R118 diagnostic screenshot ${label}: ${String(error).slice(0,400)}`)}
  return state;
};
try{
  browser=await chromium.launch({headless:mode!=='headed',...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox'],ignoreDefaultArgs:['--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling']});
  // Separate incognito contexts force distinct native browser windows: the
  // receiver can be physically minimized while the sender keeps painting.
  const receiverContext=await browser.newContext(),senderContext=await browser.newContext();
  receiver=await receiverContext.newPage();sender=await senderContext.newPage();watchPage(receiver,'receiver');watchPage(sender,'sender');
  const url=`http://127.0.0.1:${server.address().port}/`;
  await Promise.all([receiver.goto(url),sender.goto(url)]);
  browserCdp=await browser.newBrowserCDPSession();
  for(const [label,context,page] of [['receiver',receiverContext,receiver],['sender',senderContext,sender]]){
    const cdp=await context.newCDPSession(page);
    // Playwright enables focus emulation for every page by default. Turn that
    // instrumentation off so document.hidden reflects the real native window.
    await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
    const {targetInfo}=await cdp.send('Target.getTargetInfo');
    nativeWindows[label]={targetId:targetInfo.targetId,...await browserCdp.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId})};
  }
  assert.notEqual(nativeWindows.receiver.windowId,nativeWindows.sender.windowId,'receiver and sender require distinct native windows');
  const offer=await receiver.evaluate(async()=>{
    const {sampleCameraVideo}=await import('/cameraVideoFrames.js');
    const {holdMonitoringActivity}=await import('/backgroundActivity.js');
    window.releaseMonitoring=holdMonitoringActivity();
    window.video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;video.style.position='fixed';video.style.left='-2000px';document.body.append(video);
    video.requestVideoFrameCallback=()=>{throw new Error('Rendering callbacks are forbidden in this fixture')};
    window.pc=new RTCPeerConnection({iceServers:[]});pc.addTransceiver('video',{direction:'recvonly'});
    pc.ontrack=event=>{video.srcObject=event.streams[0]||new MediaStream([event.track]);void video.play().catch(error=>{window.playError=String(error)})};
    window.captured=[];window.unavailable=[];
    window.beginSampling=()=>{window.stopSampling=sampleCameraVideo({peer:pc,video,intervalMs:500,getJobToken:()=>`test-job`,capture:async(token,at,job)=>{
      const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,32,32);
      const bytes=ctx.getImageData(0,0,32,32).data;let hash=2166136261;for(const value of bytes)hash=Math.imul(hash^value,16777619);
      captured.push({token,at,job,hash,hidden:document.hidden});
    },unavailable:reason=>unavailable.push(reason),progressed:()=>{}})};
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve=>{if(pc.iceGatheringState==='complete')resolve();else pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete')resolve()})});
    return pc.localDescription.toJSON();
  });
  const answer=await sender.evaluate(async offer=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;document.body.append(canvas);const ctx=canvas.getContext('2d');let phase=0;
    const paint=()=>{phase++;window.paintCount=phase;ctx.fillStyle=`hsl(${phase*17%360},70%,45%)`;ctx.fillRect(0,0,320,240);ctx.fillStyle='white';ctx.fillRect(phase*13%280,phase*7%200,40,40)};
    paint();window.paintTimer=setInterval(paint,60);window.stream=canvas.captureStream(15);
    window.pc=new RTCPeerConnection({iceServers:[]});for(const track of stream.getTracks())pc.addTrack(track,stream);
    await pc.setRemoteDescription(offer);await pc.setLocalDescription(await pc.createAnswer());
    await new Promise(resolve=>{if(pc.iceGatheringState==='complete')resolve();else pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete')resolve()})});
    return pc.localDescription.toJSON();
  },offer);
  await receiver.evaluate(async answer=>{await pc.setRemoteDescription(answer);beginSampling()},answer);
  await sender.bringToFront();
  await diagnose('negotiated');
  await receiver.waitForFunction(()=>video.readyState>=2,undefined,{timeout:15000,polling:250});
  await receiver.evaluate(()=>{captured.length=0});
  await browserCdp.send('Browser.setWindowBounds',{windowId:nativeWindows.receiver.windowId,bounds:{windowState:'normal'}});
  await browserCdp.send('Browser.setWindowBounds',{windowId:nativeWindows.receiver.windowId,bounds:{windowState:'minimized'}});
  await sender.bringToFront();
  await diagnose('minimized');
  // RAF polling would itself stop on the deliberately hidden document, leaving
  // the acceptance waiter stuck even when decoder frames arrive correctly.
  await receiver.waitForFunction(()=>document.hidden&&video.readyState>=2,undefined,{timeout:15000,polling:250});
  await receiver.evaluate(()=>{captured.length=0});
  await receiver.waitForFunction(()=>captured.filter(frame=>frame.hidden).length>=5,undefined,{timeout:20000,polling:250});
  const observations=await receiver.evaluate(()=>({hidden:document.hidden,captured:captured.filter(frame=>frame.hidden),unavailable:[...unavailable]}));
  assert(observations.hidden,'receiver must actually be a hidden browser document');
  const {bounds:receiverBounds}=await browserCdp.send('Browser.getWindowBounds',{windowId:nativeWindows.receiver.windowId});
  assert.equal(receiverBounds.windowState,'minimized','native receiver browser window must remain minimized while frames are captured');
  assert(new Set(observations.captured.map(frame=>frame.token)).size>=5,'decoded frame identities must advance');
  assert(new Set(observations.captured.map(frame=>frame.hash)).size>=3,'actual hidden video pixels must change');
  assert(observations.captured.every(frame=>frame.job==='test-job'));
  await sender.evaluate(()=>{clearInterval(paintTimer);for(const track of stream.getTracks())track.stop()});
  // Drain buffered decoder frames before checking that a stalled stream is not
  // repeatedly analyzed. This delay is intentionally shorter than the job gate.
  await new Promise(resolve=>setTimeout(resolve,1800));
  const before=await receiver.evaluate(()=>captured.length);
  await new Promise(resolve=>setTimeout(resolve,1800));
  const after=await receiver.evaluate(()=>captured.length);
  assert.equal(after,before,'a frozen stream must not generate synthetic fresh-frame evidence');
  await diagnose('passed',true);
  await receiver.evaluate(()=>{stopSampling();releaseMonitoring();pc.close()});
  await sender.evaluate(()=>pc.close());
  console.log(`R118 browser camera PASS (${mode}): physically minimized hidden WebRTC receiver captured ${observations.captured.length} unique decoded frames with changing pixels; frozen stream produced no new evidence`);
}catch(error){
  await diagnose('failed',true);
  throw error;
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
