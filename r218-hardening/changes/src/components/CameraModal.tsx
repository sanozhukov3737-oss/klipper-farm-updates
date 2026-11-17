import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { PrinterModel } from '../types';
import { configuredPrinterCamera, isCrealityCamera, isK1Max, PrinterCamera } from './PrinterCamera';
import { useModalAccessibility } from '../lib/modalAccessibility';
export function CameraModal({printer,onClose,aboveAssistant=false}:{printer:PrinterModel;onClose:()=>void;aboveAssistant?:boolean}){
 useModalAccessibility(onClose,'.cameraModal',`Камера ${printer.name}`);
 const cams=useMemo(()=>printer.webcams.filter(c=>c.enabled),[printer.webcams]); const [idx,setIdx]=useState(0); const cam=cams[idx];
 const k1c=isCrealityCamera(printer)&&!configuredPrinterCamera(printer);
 const prev=()=>setIdx(i=>(i-1+cams.length)%cams.length),next=()=>setIdx(i=>(i+1)%cams.length);
 return <div className="modalBackdrop cameraBackdrop" style={aboveAssistant?{zIndex:2000}:undefined} onMouseDown={e=>e.target===e.currentTarget&&onClose()}><div className="cameraModal"><div className="cameraModalHead"><div><strong>{printer.name}</strong><span>{k1c?`Штатная камера ${isK1Max(printer)?'K1 Max':'K1C 2025'}`:cam?.name??'Камера'} {cams.length>1?`· ${idx+1}/${cams.length}`:''}</span></div><div className="cameraNav">{!k1c&&cams.length>1&&<><button className="round" onClick={prev}><ChevronLeft/></button><button className="round" onClick={next}><ChevronRight/></button></>}<button className="round" onClick={onClose}><X/></button></div></div><PrinterCamera printer={k1c?printer:{...printer,webcams:cam?[cam]:[]}}/></div></div>
}
