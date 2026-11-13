import { printerFaultReason } from './printerFault';

export type VoiceEventSpeechPreferences={complete:boolean;error:boolean;runout:boolean};
export const VOICE_EVENT_SPEECH_DEFAULTS:VoiceEventSpeechPreferences={complete:true,error:true,runout:true};
export const VOICE_EVENT_SPEECH_KEY='klipper-voice-event-speech-v1';
export const VOICE_EVENT_SPEECH_CHANGED='klipper-voice-event-speech-changed';

export function normalizeVoiceEventSpeechPreferences(value:unknown):VoiceEventSpeechPreferences{
  const row=value&&typeof value==='object'?value as Partial<VoiceEventSpeechPreferences>:{} as Partial<VoiceEventSpeechPreferences>;
  return{
    complete:typeof row.complete==='boolean'?row.complete:VOICE_EVENT_SPEECH_DEFAULTS.complete,
    error:typeof row.error==='boolean'?row.error:VOICE_EVENT_SPEECH_DEFAULTS.error,
    runout:typeof row.runout==='boolean'?row.runout:VOICE_EVENT_SPEECH_DEFAULTS.runout,
  };
}

export function voiceEventSpeechPreferences():VoiceEventSpeechPreferences{
  try{return normalizeVoiceEventSpeechPreferences(JSON.parse(localStorage.getItem(VOICE_EVENT_SPEECH_KEY)||'null'))}
  catch{return normalizeVoiceEventSpeechPreferences(null)}
}

export function saveVoiceEventSpeechPreferences(value:VoiceEventSpeechPreferences):VoiceEventSpeechPreferences{
  const normalized=normalizeVoiceEventSpeechPreferences(value);
  localStorage.setItem(VOICE_EVENT_SPEECH_KEY,JSON.stringify(normalized));
  window.dispatchEvent(new Event(VOICE_EVENT_SPEECH_CHANGED));
  return normalized;
}

/** Kseniya voices real print outcomes: actual completion, faults and filament runout. */
export function voiceEventSpeechText(kind:'complete'|'error'|'runout',printerName:string,detail?:string):string{
  const name=printerName.slice(0,120);
  if(kind==='complete')return `Печать на принтере ${name} завершена.`;
  // Причина приходит от Klipper по-английски. Синтез вырезает латиницу, поэтому
  // сырой текст превращался в обрывки — «ошибка.: эм си ю». Озвучиваем
  // распознанную причину по-русски; полный текст остаётся в журнале.
  if(kind==='error')return `Внимание: на принтере ${name} ошибка: ${printerFaultReason(detail)}.`;
  return `На принтере ${name} закончился пластик. Печать на паузе, проверь катушку.`;
}
