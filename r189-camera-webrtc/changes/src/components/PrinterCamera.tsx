import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, RefreshCw } from 'lucide-react';
import type { PrinterModel } from '../types';
import { secureInvoke } from '../lib/auth';
import { releaseCameraImage, releaseCameraPeer } from '../lib/cameraStreamLifecycle';

export const isK1C2025=(printer:PrinterModel)=>{
  const identity=`${printer.profile?.preset||''} ${printer.name||''}`.toLowerCase();
  return printer.profile?.preset==='creality-k1c-2025'||identity.includes('k1c');
};
export const isK1Max=(printer:PrinterModel)=>{const identity=`${printer.profile?.preset||''} ${printer.name||''}`.toLowerCase();return printer.profile?.preset==='creality-k1-max'||identity.includes('k1 max')||identity.includes('k1max')};
export const isCrealityCamera=(printer:PrinterModel)=>isK1C2025(printer)||isK1Max(printer);

export function safeCameraUrl(printer:PrinterModel,value?:string,port?:number){
  if(!value)return undefined;
  try{
    const host=printer.host.trim().replace(/^http:\/\//i,'').replace(/\/$/,'');
    const configured=new URL(`http://${host}`);
    const base=port?`http://${configured.hostname}:${port}/`:`${configured.origin}/`;
    const url=new URL(value,base);
    if(url.protocol!=='http:'||url.hostname!==configured.hostname||url.username||url.password)return undefined;
    return url.toString();
  }catch{return undefined}
}

function toBase64(value:string){
  const bytes=new TextEncoder().encode(value);
  let binary='';
  bytes.forEach(byte=>binary+=String.fromCharCode(byte));
  return btoa(binary);
}

function fromBase64(value:string){
  const binary=atob(value.trim());
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function configuredPrinterCamera(printer:PrinterModel){
  return printer.webcams.find(camera=>camera.enabled&&!!safeCameraUrl(printer,camera.stream_url));
}

export function hasPrinterCamera(printer:PrinterModel){
  return !!configuredPrinterCamera(printer)||isCrealityCamera(printer);
}

type CameraProps={printer:PrinterModel;className?:string;active?:boolean;onAvailability?:(available:boolean)=>void};
export function PrinterCamera(props:CameraProps){
  const cam=configuredPrinterCamera(props.printer);
  const source=JSON.stringify([props.printer.id,props.printer.host,isK1C2025(props.printer),isK1Max(props.printer),cam?.stream_url]);
  return <PrinterCameraStream key={source} {...props}/>;
}

function PrinterCameraStream({printer,className,active=true,onAvailability}:CameraProps){
  const cam=configuredPrinterCamera(printer);
  const stream=safeCameraUrl(printer,cam?.stream_url);
  const builtin=!stream&&isCrealityCamera(printer);
  const availabilityCallback=useRef(onAvailability);
  availabilityCallback.current=onAvailability;
  const video=useRef<HTMLVideoElement>(null);
  const image=useRef<HTMLImageElement|null>(null);
  const imageRef=useCallback((element:HTMLImageElement|null)=>{
    if(image.current!==element)releaseCameraImage(image.current);
    image.current=element;
  },[]);
  const peer=useRef<RTCPeerConnection>();
  const retryTimer=useRef<number>();
  const frameTimer=useRef<number>();
  const generation=useRef(0);
  // Основной путь — WebRTC: его отдаёт служба принтера на 8000. MJPEG остаётся
  // запасным, потому что на проверенных принтерах порта 8080 нет вовсе.
  const [mode,setMode]=useState<'mjpeg'|'webrtc'>('webrtc');
  const [status,setStatus]=useState<'connecting'|'playing'|'error'>('connecting');
  const [message,setMessage]=useState('Подключение камеры K1C 2025…');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{if(status==='playing')availabilityCallback.current?.(true);else if(status==='error')availabilityCallback.current?.(false)},[status]);

  const close=useCallback(()=>{
    generation.current++;
    if(retryTimer.current)window.clearTimeout(retryTimer.current);
    if(frameTimer.current)window.clearTimeout(frameTimer.current);
    retryTimer.current=undefined;
    frameTimer.current=undefined;
    releaseCameraPeer(peer.current,video.current);
    peer.current=undefined;
  },[]);

  // Порт и путь потока зависят от прошивки: на одной камера на 8080/stream,
  // на другой на 8081 или на 80 с action=stream. Молчание одного адреса не
  // означает отсутствие камеры, поэтому адреса перебираются по очереди.
  const mjpegCandidates=useMemo(()=>{
    const urls:string[]=[];
    for(const port of [8080,8081,80,4408]){
      for(const path of ['/stream','/?action=stream','/webcam/?action=stream']){
        const url=safeCameraUrl(printer,path,port);
        if(url&&!urls.includes(url))urls.push(url);
      }
    }
    return urls;
  },[printer.host]);
  const [mjpegIndex,setMjpegIndex]=useState(0);
  const mjpegUrl=mjpegCandidates[mjpegIndex];
  const mjpegFallback=useRef(false);
  // Следующий адрес; когда список исчерпан, пробуем WebRTC.
  const nextMjpeg=useCallback(()=>{
    if(mjpegIndex+1<mjpegCandidates.length){setMjpegIndex(mjpegIndex+1);return true}
    return false;
  },[mjpegIndex,mjpegCandidates.length]);
  // WebRTC не пошёл: у части прошивок служба на 8000 закрыта, а поток отдаётся
  // обычным MJPEG. Пробуем найденные адреса, прежде чем показывать ошибку.
  const mjpegFallbackAfterWebrtc=useCallback((message:string)=>{
    if(!mjpegFallback.current&&mjpegCandidates.length){
      mjpegFallback.current=true;
      setMjpegIndex(0);
      setMode('mjpeg');
      setStatus('connecting');
      setMessage('Пробую поток камеры по адресам принтера…');
      return true;
    }
    setStatus('error');
    setMessage(message);
    return false;
  },[mjpegCandidates.length]);

  useEffect(()=>{
    setStatus('connecting');
    if(!active)return;
    if(stream){
      frameTimer.current=window.setTimeout(()=>setStatus('error'),8000);
      return()=>{if(frameTimer.current)window.clearTimeout(frameTimer.current);frameTimer.current=undefined};
    }
  },[active,stream]);

  useEffect(()=>{
    if(!active||!builtin||mode!=='mjpeg')return;
    setStatus('connecting');
    setMessage('Подключение к камере K1C 2025…');
    // 4 секунды на адрес: рабочий поток отдаёт первый кадр быстрее.
    frameTimer.current=window.setTimeout(()=>{if(!nextMjpeg())setMode('webrtc')},3000);
    return()=>{if(frameTimer.current)window.clearTimeout(frameTimer.current);frameTimer.current=undefined};
  },[active,builtin,printer.host,retry,mode,mjpegUrl,nextMjpeg]);

  useEffect(()=>{
    if(!active||!builtin||mode!=='webrtc')return close;
    let disposed=false;
    const current=++generation.current;
    setStatus('connecting');
    setMessage(`Подключение камеры ${isK1Max(printer)?'K1 Max':'K1C 2025'}…`);
    // Состав соединения повторяет тестовую страницу самой камеры (http://<ip>:8000/):
    // она использует STUN и двусторонний трансивер и работает. Отличие в кодеках
    // и одностороннем recvonly оказалось лишним и мешало согласованию.
    const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
    peer.current=pc;
    pc.addTransceiver('video',{direction:'sendrecv'});
    pc.ontrack=event=>{
      if(disposed||current!==generation.current)return;
      const stream=event.streams[0]||new MediaStream([event.track]);
      if(video.current){video.current.srcObject=stream;const playing=()=>{if(disposed||current!==generation.current)return;if(frameTimer.current)window.clearTimeout(frameTimer.current);setStatus('playing');setMessage('')};video.current.onloadeddata=playing;video.current.onplaying=playing;void video.current.play().catch(()=>{});}
    };
    pc.onconnectionstatechange=()=>{
      if(disposed||current!==generation.current)return;
      if(pc.connectionState==='failed'||pc.connectionState==='disconnected'){
        if(!mjpegFallbackAfterWebrtc('Поток камеры прерван')){
          retryTimer.current=window.setTimeout(()=>setRetry(x=>x+1),3000);
        }
      }
    };
    (async()=>{
      try{
        const offer=await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Ждём окончания сбора кандидатов. Признак конца — нулевой кандидат,
        // как в эталонной странице: оффер без кандидатов приводит к ответу без медиа.
        await new Promise<void>(resolve=>{
          let settled=false;
          const finish=()=>{if(settled)return;settled=true;pc.removeEventListener('icecandidate',onCandidate);pc.removeEventListener('icegatheringstatechange',onState);resolve();};
          const onCandidate=(event:RTCPeerConnectionIceEvent)=>{if(!event.candidate)finish();};
          const onState=()=>{if(pc.iceGatheringState==='complete')finish();};
          if(pc.iceGatheringState==='complete')return finish();
          pc.addEventListener('icecandidate',onCandidate);
          pc.addEventListener('icegatheringstatechange',onState);
          // 12 секунд: сбор на медленной сети дольше, но не бесконечно.
          window.setTimeout(finish,12000);
        });
        if(disposed||current!==generation.current)return;
        const payload=toBase64(JSON.stringify({type:'offer',sdp:pc.localDescription?.sdp||offer.sdp}));
        const raw=await secureInvoke<string>('creality_webrtc_offer',{printerId:printer.id,host:printer.host,offer:payload});
        if(disposed||current!==generation.current)return;
        const answer=JSON.parse(fromBase64(raw));
        if(answer.type!=='answer'||!answer.sdp)throw new Error('Принтер не вернул SDP answer');
        await pc.setRemoteDescription(answer);
        if(disposed||current!==generation.current)return;
        frameTimer.current=window.setTimeout(()=>{
          if(!disposed&&current===generation.current&&(video.current?.readyState??0)<2){
            mjpegFallbackAfterWebrtc('Камера не передаёт видеокадры');
          }
        },10000);
      }catch(error){
        if(disposed||current!==generation.current)return;
        mjpegFallbackAfterWebrtc(String((error as Error)?.message||error));
      }
    })();
    return()=>{disposed=true;close();};
  },[active,builtin,printer.host,retry,mode,close]);

  if(!active)return <div className="cameraEmpty"><Camera/>Камера приостановлена</div>;
  if(!builtin){
    return stream?<img ref={imageRef} className={className} src={stream} alt={cam?.name||'Камера'} onLoad={()=>{if(frameTimer.current)window.clearTimeout(frameTimer.current);setStatus('playing')}} onError={()=>setStatus('error')}/>:<div className="cameraEmpty"><Camera/>Камера недоступна</div>;
  }

  return <div className={`k1cWebRtc ${className||''}`}>
    {mode==='mjpeg'&&mjpegUrl?<img key={mjpegUrl} ref={imageRef} src={mjpegUrl} alt="Камера K1C 2025" onLoad={()=>{if(frameTimer.current)window.clearTimeout(frameTimer.current);setStatus('playing');setMessage('')}} onError={()=>{if(!nextMjpeg())setMode('webrtc')}}/>:<video ref={video} autoPlay muted playsInline/>}
    {status!=='playing'&&<div className={`k1cCameraState ${status}`}><Camera/><span>{message}</span>{status==='error'&&<button onClick={()=>{setMjpegIndex(0);setMode(isK1C2025(printer)?'mjpeg':'webrtc');setRetry(x=>x+1)}}><RefreshCw/>Повторить</button>}</div>}
  </div>;
}
