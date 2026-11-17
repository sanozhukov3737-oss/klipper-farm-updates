import {useEffect,useRef,useState} from 'react';
import type {PrinterModel} from '../types';
import type {MoonrakerClient} from '../lib/moonraker';
import type {CameraGuardController} from '../lib/cameraGuardRuntime';
import {cameraGuardSource,prepareCameraFrame,type CameraGuardSource} from '../lib/cameraFrames';
import {secureInvoke} from '../lib/auth';
import {isK1Max} from './PrinterCamera';
import {sampleCameraVideo} from '../lib/cameraVideoFrames';

const FRAME_INTERVAL=8_000;
const reasonText=(reason:unknown)=>String(reason instanceof Error?reason.message:reason).slice(0,200);
const encodeOffer=(offer:unknown)=>btoa(JSON.stringify(offer));
const decodeAnswer=(value:string)=>JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.trim()),c=>c.charCodeAt(0)))) as RTCSessionDescriptionInit;

/** Lives with FarmApp, independently of the TV view and camera dialogs. */
export function CameraGuardHost({printers,clients,controller}:{printers:PrinterModel[];clients:Map<string,MoonrakerClient>;controller:CameraGuardController}){
  const active=new Set(controller.activePrinterIds);
  return <div className="cameraGuardSources" aria-hidden="true" style={{position:'fixed',left:-2_000,top:0,width:2,height:2,overflow:'hidden',pointerEvents:'none'}}>
    {printers.filter(printer=>active.has(printer.id)).map(printer=>{
      const source=cameraGuardSource(printer);
      return <CameraFrameSource key={JSON.stringify([printer.id,printer.host,printer.profile?.preset,printer.name,source])} printer={printer} client={clients.get(printer.id)} source={source} controller={controller}/>;
    })}
  </div>;
}

function CameraFrameSource({printer,client,source,controller}:{printer:PrinterModel;client?:MoonrakerClient;source?:CameraGuardSource;controller:CameraGuardController}){
  const latest=useRef({printer,client,controller});latest.current={printer,client,controller};
  const video=useRef<HTMLVideoElement>(null);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let stopped=false,busy=false,lastHash='',lastFrameToken='',lastProgress=Date.now();
    let finishIce:(()=>void)|undefined;
    let timer:number|undefined,retryTimer:number|undefined,stopVideoSampling:(()=>void)|undefined;
    let peer:RTCPeerConnection|undefined;
    const epoch=crypto.randomUUID(),element=video.current;
    const unavailable=(reason:string)=>{if(!stopped)latest.current.controller.unavailable(printer.id,reason)};
    // Invalidate inference from the previous camera immediately, before a new
    // snapshot or WebRTC handshake can finish and provide its first frame.
    unavailable('Камера подключается — ждём свежий кадр');
    const reconnect=()=>{if(!stopped&&retryTimer===undefined)retryTimer=window.setTimeout(()=>{if(!stopped)setRetry(value=>value+1)},15_000)};
    const capture=async(image:CanvasImageSource,width:number,height:number,token:string,capturedAt:number,jobToken:string)=>{
      const frame=await prepareCameraFrame(image,width,height);
      if(stopped||latest.current.controller.getJobToken(printer.id)!==jobToken){frame.bitmap.close();return;}
      if(frame.hash===lastHash||token===lastFrameToken){frame.bitmap.close();unavailable('Кадр не изменился — ждём новое изображение');return;}
      lastHash=frame.hash;lastFrameToken=token;
      latest.current.controller.submitFrame(printer.id,frame.bitmap,{capturedAt,frameToken:token+':'+frame.hash,sourceEpoch:epoch,jobToken});
    };
    const snapshot=async()=>{
      if(stopped||!source||source.kind!=='snapshot')return;
      const context=latest.current,jobToken=context.controller.getJobToken(printer.id);
      if(jobToken&&context.client&&!busy){
        busy=true;const started=Date.now();
        try{
          const response=await context.client.snapshot(source.url);
          if(stopped)return;
          if(Date.now()-started>FRAME_INTERVAL)throw new Error('Камера ответила слишком поздно — кадр пропущен');
          if(response.status<200||response.status>=300||!response.contentType?.toLowerCase().startsWith('image/')||!response.body.length)throw new Error('Камера не передала изображение');
          const bitmap=await createImageBitmap(new Blob([new Uint8Array(response.body)],{type:response.contentType}));
          try{await capture(bitmap,bitmap.width,bitmap.height,crypto.randomUUID(),Date.now(),jobToken)}finally{bitmap.close()}
        }catch(reason){unavailable(reasonText(reason))}finally{busy=false}
      }
      if(!stopped)timer=window.setTimeout(()=>void snapshot(),FRAME_INTERVAL);
    };
    const startVideo=async()=>{
      if(!element)return;
      peer=new RTCPeerConnection({iceServers:[]});
      const transceiver=peer.addTransceiver('video',{direction:isK1Max(printer)?'sendrecv':'recvonly'});
      const codecs=RTCRtpReceiver.getCapabilities?.('video')?.codecs;
      if(codecs?.length&&transceiver.setCodecPreferences){const h264=codecs.filter(c=>c.mimeType.toLowerCase()==='video/h264');transceiver.setCodecPreferences([...h264,...codecs.filter(c=>c.mimeType.toLowerCase()!=='video/h264')]);}
      peer.ontrack=event=>{
        if(stopped||!element)return;
        element.srcObject=event.streams[0]||new MediaStream([event.track]);
        void element.play().catch(()=>unavailable('Не удалось начать чтение видеокадров'));
      };
      peer.onconnectionstatechange=()=>{if(peer&&(peer.connectionState==='failed'||peer.connectionState==='disconnected')){unavailable('Поток камеры прерван — анализ не выполняется');reconnect()}};
      const offer=await peer.createOffer();await peer.setLocalDescription(offer);
      await new Promise<void>(resolve=>{
        if(!peer||peer.iceGatheringState==='complete')return resolve();
        const pc=peer,finish=()=>{pc.removeEventListener('icegatheringstatechange',done);finishIce=undefined;resolve()},done=()=>{if(pc.iceGatheringState==='complete')finish()};
        finishIce=finish;
        pc.addEventListener('icegatheringstatechange',done);
        timer=window.setTimeout(finish,2_500);
      });
      if(stopped||!peer)return;
      const raw=await secureInvoke<string>('creality_webrtc_offer',{printerId:printer.id,host:printer.host,offer:encodeOffer({type:'offer',sdp:peer.localDescription?.sdp||offer.sdp})});
      if(stopped||!peer)return;
      const answer=decodeAnswer(raw);if(answer.type!=='answer'||!answer.sdp)throw new Error('Камера не вернула видеопоток');
      await peer.setRemoteDescription(answer);
      if(stopped)return;
      stopVideoSampling=sampleCameraVideo({peer,video:element,intervalMs:FRAME_INTERVAL,
        getJobToken:()=>latest.current.controller.getJobToken(printer.id),unavailable,
        capture:(token,at,jobToken)=>capture(element,element.videoWidth,element.videoHeight,token,at,jobToken),
        progressed:()=>{lastProgress=Date.now();if(retryTimer!==undefined){window.clearTimeout(retryTimer);retryTimer=undefined}},
      });
    };
    if(!source)unavailable('У камеры нет адреса снимков для анализа');
    else if(source.kind==='snapshot')void snapshot();
    else void startVideo().catch(reason=>{unavailable(reasonText(reason));reconnect()});
    const watchdog=window.setInterval(()=>{if(source?.kind==='webrtc'&&Date.now()-lastProgress>25_000){unavailable('Нет свежих видеокадров — анализ не выполняется');reconnect()}},10_000);
    return()=>{
      stopped=true;if(timer!==undefined)window.clearTimeout(timer);finishIce?.();if(watchdog!==undefined)window.clearInterval(watchdog);if(retryTimer!==undefined)window.clearTimeout(retryTimer);
      stopVideoSampling?.();
      if(element){element.pause();element.srcObject=null;}
      if(peer){peer.ontrack=null;peer.onconnectionstatechange=null;peer.close();}
    };
  },[printer.id,printer.host,JSON.stringify(source),retry]);
  return source?.kind==='webrtc'?<video ref={video} autoPlay muted playsInline/>:null;
}
