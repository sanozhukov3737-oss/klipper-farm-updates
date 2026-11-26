import {secureInvoke} from './auth';
import type {VoiceSemanticInput} from './voiceSemantic';

let serial=0;
/** Model output is data, subsequently validated by voiceSemantic before dispatch. */
export async function interpretVoiceSemantic(input:VoiceSemanticInput,signal:AbortSignal):Promise<unknown>{
  if(signal.aborted)throw new DOMException('Действие отменено','AbortError');
  const requestId=`voice-${Date.now()}-${++serial}-${crypto.randomUUID()}`;
  const cancel=()=>{void secureInvoke('voice_semantic_cancel',{requestId}).catch(()=>{})};
  signal.addEventListener('abort',cancel,{once:true});
  try{
    if(signal.aborted){cancel();throw new DOMException('Действие отменено','AbortError')}
    const result=await secureInvoke<unknown>('voice_semantic_interpret',{requestId,request:input});
    if(signal.aborted)throw new DOMException('Действие отменено','AbortError');
    return result;
  }finally{signal.removeEventListener('abort',cancel)}
}

export function voiceUnderstandingStatus(){
  // runtime names the build the launcher picked (llama-server-avx2.exe or llama-server.exe), so a
  // hardware-specific failure can be told apart from a missing file without reading the install.
  return secureInvoke<{available:boolean;runtime:string;modelPresent:boolean}>('voice_semantic_status');
}

export function prepareVoiceUnderstanding(){
  return secureInvoke<void>('voice_semantic_prepare');
}
