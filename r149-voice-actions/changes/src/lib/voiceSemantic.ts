import type { PrinterModel } from '../types';
import { normalizeVoice,parseVoiceCommand,voicePrinterMatches,voiceControlActions,voiceForecastMinutes,type VoiceIntent,type VoiceControlAction,type VoiceForecastMode,type VoiceNavigateTarget,VOICE_NAVIGATE_TARGETS } from './voiceCommands';

export type VoiceSemanticPrinter={id:string;name:string;preset?:string};
export type VoiceSemanticContext={
  topic?:'file'|'stock'|'printers';awaiting?:'file'|'printer'|'choice';
  request?:{query:string;action:'find'|'print'|'plan'};
  selectedFile?:{name:string};selectedPrinterId?:string;
  printers:VoiceSemanticPrinter[];
  fileChoices:Array<{number:number;name:string;printerId:string}>;
  printerChoices:Array<VoiceSemanticPrinter&{number:number}>;
};
export type VoiceSemanticInput={text:string;context:VoiceSemanticContext};
type References={usePreviousFile?:boolean;usePreviousPrinter?:boolean;otherPrinter?:boolean};
export type VoiceSemanticIntent=
  |{kind:'printers';filter:'free'|'printing'|'all';countOnly?:boolean;printerId?:string}
  |{kind:'stock';query?:string;afterPrint?:boolean;usePreviousPrinter?:boolean;printerId?:string}
  |{kind:'control';action:VoiceControlAction;printerId?:string;usePreviousPrinter?:boolean}
  |{kind:'navigate';target:VoiceNavigateTarget;printerId?:string;usePreviousPrinter?:boolean}
  |{kind:'forecast';mode:VoiceForecastMode;minutes?:number;printerId?:string;usePreviousPrinter?:boolean}
  |({kind:'find'|'print';query:string;printerId?:string}&References)
  |({kind:'plan';query:string;quantity:number;printerId?:string;freeOnly?:boolean}&References)
  |({kind:'followup';query?:string;printerId?:string;correctPreviousQuery?:boolean}&References)
  |{kind:'choose';choice:number}
  |{kind:'tasks'}|{kind:'check'};
export type VoiceSemanticResult=VoiceSemanticIntent|{kind:'clarify';reason:'unknown'|'ambiguous'|'unsupported'};
export type ResolvedVoiceIntent=VoiceIntent&{printerId?:string};

const fields:Record<VoiceSemanticResult['kind'],readonly string[]>={
  printers:['kind','filter','countOnly','printerId'],
  stock:['kind','query','afterPrint','usePreviousPrinter','printerId'],
  control:['kind','action','printerId','usePreviousPrinter'],
  navigate:['kind','target','printerId','usePreviousPrinter'],
  forecast:['kind','mode','minutes','printerId','usePreviousPrinter'],
  find:['kind','query','printerId','usePreviousFile','usePreviousPrinter','otherPrinter'],
  print:['kind','query','printerId','usePreviousFile','usePreviousPrinter','otherPrinter'],
  plan:['kind','query','quantity','printerId','freeOnly','usePreviousFile','usePreviousPrinter','otherPrinter'],
  followup:['kind','query','printerId','correctPreviousQuery','usePreviousFile','usePreviousPrinter','otherPrinter'],
  choose:['kind','choice'],tasks:['kind'],check:['kind'],clarify:['kind','reason'],
};
const flags=['countOnly','afterPrint','usePreviousPrinter','usePreviousFile','otherPrinter','freeOnly','correctPreviousQuery'] as const;
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const cleanText=(value:unknown,max:number,empty=true):value is string=>typeof value==='string'&&value.length<=max&&(empty||!!value.trim())&&!/[\p{Cc}\p{Cf}]/u.test(value);
const invalid=()=>new Error('Некорректный ответ локального модуля понимания');
const ambiguous=():VoiceSemanticResult=>({kind:'clarify',reason:'ambiguous'});

/** Only explicit, configured names/aliases are evidence; a descriptive nickname may still need the model. */
function spokenPrinters(input:VoiceSemanticInput):string[]{
  const words=normalizeVoice(input.text).split(' ').filter(Boolean);
  const printers=input.context.printers.map(p=>({id:p.id,name:p.name,...(p.preset?{profile:{preset:p.preset}}:{})})) as PrinterModel[];
  const spanLimit=Math.min(16,Math.max(5,...input.context.printers.map(p=>normalizeVoice(p.name).split(' ').length)));
  const found=new Set<string>();
  for(let start=0;start<words.length;start++){
    // An unrecognised numeric model such as K2 Max must not be reduced to the suffix «Max».
    if(start&&/\d/u.test(words[start-1]))continue;
    for(let size=Math.min(spanLimit,words.length-start);size>0;size--){
      const matches=voicePrinterMatches(printers,words.slice(start,start+size).join(' '));
      if(!matches.length)continue;
      for(const p of matches)found.add(p.id);
      start+=size-1;break;
    }
  }
  return [...found];
}

/** A model proposes one typed intent. It never provides executable code, paths to open, or confirmation. */
export function validateVoiceSemanticResult(output:unknown,input:VoiceSemanticInput):VoiceSemanticResult{
  let value=output;
  if(typeof value==='string'){
    if(new TextEncoder().encode(value).length>8192)throw invalid();
    try{value=JSON.parse(value)}catch{throw invalid()}
  }
  if(!plain(value)||typeof value.kind!=='string'||!Object.hasOwn(fields,value.kind))throw invalid();
  const kind=value.kind as VoiceSemanticResult['kind'];
  if(Object.keys(value).some(key=>!fields[kind].includes(key)))throw invalid();
  for(const key of flags)if(Object.hasOwn(value,key)&&typeof value[key]!=='boolean')throw invalid();
  if(Object.hasOwn(value,'query')&&!cleanText(value.query,300))throw invalid();
  if(Object.hasOwn(value,'printerId')&&(!cleanText(value.printerId,128,false)||!input.context.printers.some(p=>p.id===value.printerId)))throw invalid();
  if(value.printerId&&(value.usePreviousPrinter||value.otherPrinter)||value.usePreviousPrinter&&value.otherPrinter)throw invalid();
  if(value.usePreviousFile&&value.query)throw invalid();
  if(kind==='printers'&&!['free','printing','all'].includes(String(value.filter)))throw invalid();
  if(['find','print','plan'].includes(kind)&&!Object.hasOwn(value,'query'))throw invalid();
  if(kind==='plan'&&(!Number.isInteger(value.quantity)||(value.quantity as number)<1||(value.quantity as number)>20))throw invalid();
  if(kind==='control'&&!['light-on','light-off','pause','resume','camera'].includes(String(value.action)))throw invalid();
  if(kind==='navigate'){
    if(!VOICE_NAVIGATE_TARGETS.includes(value.target as VoiceNavigateTarget))throw invalid();
    if(value.target!=='flash'&&(Object.hasOwn(value,'printerId')||value.usePreviousPrinter===true))throw invalid();
  }
  if(kind==='forecast'){
    if(!['finish','first','after'].includes(String(value.mode)))throw invalid();
    if(value.mode==='after'){
      if(!Number.isInteger(value.minutes)||(value.minutes as number)<1||(value.minutes as number)>10_080)throw invalid();
    }else if(Object.hasOwn(value,'minutes'))throw invalid();
    if(value.mode==='first'&&(Object.hasOwn(value,'printerId')||Object.hasOwn(value,'usePreviousPrinter')))throw invalid();
  }
  if(kind==='choose'){
    const choices=input.context.awaiting==='printer'?input.context.printerChoices:input.context.awaiting==='choice'?input.context.fileChoices:[];
    if(!Number.isInteger(value.choice)||(value.choice as number)<1||!choices.some(c=>c.number===value.choice))throw invalid();
  }
  if(kind==='followup'&&value.correctPreviousQuery&&(!value.query||!['file','choice'].includes(input.context.awaiting??'')))throw invalid();
  if(kind==='followup'&&!value.query&&!value.printerId&&!value.usePreviousFile&&!value.usePreviousPrinter&&!value.otherPrinter)throw invalid();
  if(kind==='clarify'&&!['unknown','ambiguous','unsupported'].includes(String(value.reason)))throw invalid();
  const context=input.context;
  const previousFile=!!context.selectedFile?.name.trim()||!!context.request?.query.trim();
  const previousPrinter=!!context.selectedPrinterId&&context.printers.some(p=>p.id===context.selectedPrinterId);
  if(value.usePreviousFile&&!previousFile)return ambiguous();
  if((value.usePreviousPrinter||value.otherPrinter)&&!previousPrinter)return ambiguous();
  if(kind==='followup'){
    const fileConversation=previousFile||!!context.request||!!context.awaiting;
    if(!fileConversation&&context.topic!=='stock'&&context.topic!=='printers')return ambiguous();
    // A new literal query is a follow-up only to a real file/request/choice, never an invented root conversation.
    if(value.query&&!fileConversation)return ambiguous();
  }
  const namedPrinters=spokenPrinters(input),namedPrinter=namedPrinters.length===1?namedPrinters[0]:undefined;
  if(value.printerId&&namedPrinter&&value.printerId!==namedPrinter)return ambiguous();
  if(value.usePreviousPrinter&&namedPrinter&&context.selectedPrinterId!==namedPrinter)return ambiguous();
  const resolved={...value};
  if(kind==='control'){
    const requested=voiceControlActions(input.text,input.context.printers.map(p=>({id:p.id,name:p.name,...(p.preset?{profile:{preset:p.preset}}:{})})) as PrinterModel[]);
    const previousMention=/(?:(?:на|у)\s+(?:этом|том же|прежнем)\s+принтер(?:е|а)|на нем|у него)/u.test(normalizeVoice(input.text));
    // A typed output cannot create a physical action that was not positively
    // requested, or choose one printer out of a multi-target/ambiguous name.
    if(requested.length!==1||requested[0]!==value.action||namedPrinters.length>1)return ambiguous();
    if(previousMention){
      if(!previousPrinter||namedPrinters.length)return ambiguous();
      delete resolved.printerId;resolved.usePreviousPrinter=true;
    }else{
      if(value.usePreviousPrinter||value.printerId&&!namedPrinter)return ambiguous();
      if(!value.printerId&&namedPrinter)resolved.printerId=namedPrinter;
    }
  }
  if(kind==='navigate'){
    const raw=normalizeVoice(input.text);
    // Opening a section is a positive screen action; questions and negations never navigate.
    if(!/(?:^|\s)(?:открой|открыть|покажи|показать|перейди|перейти|зайди|зайти|включи|включить)(?:\s|$)/u.test(raw)||/(?:^|\s)(?:не|нет)(?:\s|$)/u.test(raw))return ambiguous();
    if(value.target==='flash'){
      const previousMention=/(?:(?:на|у)\s+(?:этом|том же|прежнем)\s+принтер(?:е|а)|на нем|у него)/u.test(raw);
      if(previousMention){
        if(!previousPrinter||namedPrinters.length)return ambiguous();
        delete resolved.printerId;resolved.usePreviousPrinter=true;
      }else{
        if(value.usePreviousPrinter||value.printerId&&!namedPrinter)return ambiguous();
        if(!value.printerId&&namedPrinter)resolved.printerId=namedPrinter;
      }
    }
  }
  if(kind==='forecast'){
    const raw=normalizeVoice(input.text),printers=input.context.printers.map(p=>({id:p.id,name:p.name,...(p.preset?{profile:{preset:p.preset}}:{})})) as PrinterModel[];
    const understood=parseVoiceCommand(input.text,printers);
    if(understood.kind==='forecast'){
      // A stated duration or a finish question comes from the request, never
      // from a model-invented horizon such as an unspoken "60 minutes".
      resolved.mode=understood.mode;
      if(understood.mode==='after')resolved.minutes=understood.minutes;else delete resolved.minutes;
      if(understood.mode==='first'){delete resolved.printerId;delete resolved.usePreviousPrinter;}
      else if(understood.usePreviousPrinter){if(!previousPrinter)return ambiguous();delete resolved.printerId;resolved.usePreviousPrinter=true;}
      else if(namedPrinter){delete resolved.usePreviousPrinter;resolved.printerId=namedPrinter;}
      else{if(understood.printerHint)return ambiguous();delete resolved.printerId;delete resolved.usePreviousPrinter;}
    }else{
      if(value.mode==='after'){
        const minutes=voiceForecastMinutes(input.text);if(minutes===undefined)return ambiguous();resolved.minutes=minutes;
      }
      if(!/(?:^|\s)(?:законч\S*|заверш\S*|освобод\S*|занят\S*|печат\S*|принтер\S*|аппарат\S*)(?:\s|$)/u.test(raw)&&!(namedPrinter&&/(?:^|\s)(?:когда|сколько|долго|время)(?:\s|$)/u.test(raw)))return ambiguous();
      if(value.printerId&&!namedPrinter)return ambiguous();
      if(value.mode!=='first'&&!value.printerId&&!value.usePreviousPrinter&&namedPrinter)resolved.printerId=namedPrinter;
    }
  }
  if(kind==='stock'){
    // A previously selected file cannot turn an explicit current balance question
    // into a forecast. Preserve the user's material/colour words, not generated text.
    const raw=normalizeVoice(input.text);
    const future=/(?:^|\s)(?:после|останется|останутся|будет|будут|хватит|хватать|достаточно|если|когда|законч\S*|заверш\S*|вычесть|потрат\S*|уйдет|уйдут|израсход\S*)(?:\s|$)/u.test(raw);
    const current=/(?:^|\s)(?:осталось|остается|остаток|остатки|наличии|сейчас|сегодня|запас)(?:\s|$)/u.test(raw);
    if(current&&!future)resolved.afterPrint=false;
    resolved.query=raw;
  }
  // Copy only validated, own fields; JSON prototypes and model-provided extra capabilities never cross the boundary.
  return Object.fromEntries(Object.entries(resolved)) as VoiceSemanticResult;
}

/** IDs stay exact. An ambiguous spoken card name must still be chosen deliberately. */
export function semanticDuplicatePrinters(intent:VoiceSemanticIntent,input:VoiceSemanticInput):VoiceSemanticPrinter[]{
  if(!('printerId'in intent)||!intent.printerId)return[];
  const selected=input.context.printers.find(p=>p.id===intent.printerId);
  if(!selected)return[];
  const key=(name:string)=>name.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/\s+/gu,' ').trim();
  const matches=input.context.printers.filter(p=>key(p.name)===key(selected.name));
  return matches.length>1?matches:[];
}

export function semanticVoiceIntent(intent:VoiceSemanticIntent,text:string):ResolvedVoiceIntent{
  const printerId='printerId'in intent&&intent.printerId?{printerId:intent.printerId}:{};
  if(intent.kind==='printers')return{kind:'printers',filter:intent.filter,...(intent.countOnly?{countOnly:true}:{}),...printerId};
  if(intent.kind==='stock')return{kind:'stock',query:intent.query??text,...(intent.afterPrint?{afterPrint:true}:{}),...(intent.usePreviousPrinter?{usePreviousPrinter:true}:{}),...printerId};
  if(intent.kind==='control')return{kind:'control',action:intent.action,printerHint:'',...(intent.usePreviousPrinter?{usePreviousPrinter:true}:{}),...printerId};
  if(intent.kind==='navigate')return{kind:'navigate',target:intent.target,printerHint:'',...(intent.usePreviousPrinter?{usePreviousPrinter:true}:{}),...printerId};
  if(intent.kind==='forecast')return{kind:'forecast',mode:intent.mode,printerHint:'',...(intent.minutes!==undefined?{minutes:intent.minutes}:{}),...(intent.usePreviousPrinter?{usePreviousPrinter:true}:{}),...printerId};
  if(intent.kind==='choose')return{kind:'choose',index:intent.choice-1};
  if(intent.kind==='tasks'||intent.kind==='check')return{kind:intent.kind};
  const references={...(intent.usePreviousFile?{usePreviousFile:true as const}:{}),...(intent.usePreviousPrinter?{usePreviousPrinter:true as const}:{}),...(intent.otherPrinter?{otherPrinter:true as const}:{})};
  if(intent.kind==='followup')return{kind:'followup',...(intent.query!==undefined?{query:intent.query}:{}),...(intent.correctPreviousQuery?{correctPreviousQuery:true}:{}),...references,...printerId};
  return{kind:intent.kind,query:intent.query,printerHint:'',...(intent.kind==='plan'?{quantity:intent.quantity,...(intent.freeOnly?{freeOnly:true as const}:{})}:{}),...references,...printerId} as ResolvedVoiceIntent;
}

export function semanticClarification(text:string,reason:'unknown'|'ambiguous'|'unsupported'|'unavailable'|'invalid'){
  const heard=text.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,300);
  const detail=reason==='unavailable'?'Локальный модуль понимания сейчас недоступен.':reason==='invalid'?'Не удалось надёжно разобрать ответ локального модуля.':reason==='unsupported'?'Такое действие пока недоступно в помощнице.':reason==='ambiguous'?'В запросе осталось несколько возможных вариантов.':'Не смогла однозначно определить задачу.';
  return `Я услышала: «${heard}». ${detail} ${reason==='unavailable'?'Можно выбрать действие на экране или повторить запрос после подготовки модуля.':'Уточни, что нужно узнать или какой файл и принтер ты имеешь в виду.'}`;
}
