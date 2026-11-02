import type { PrinterModel } from '../types';

export const normalizeVoice=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/ё/g,'е')
  .replace(/(?<![\p{L}\p{N}])(?:creality|креалити|креалите|криалити|криэлити)(?![\p{L}\p{N}])/gu,'креалити')
  .replace(/(?:кей|кэй|ка|к)\s*(?:один|1)\s*(?:си|с|c)/gu,'k1c')
  .replace(/(?:кей|кэй|ка|к)\s*(?:один|1)/gu,'k1')
  .replace(/(?:k|к)1\s*(?:max|макс|мах)(?![\p{L}\p{N}])/gu,'k1 max')
  .replace(/(?:пять|5)\s*(?:эм|м|m)/gu,'5m')
  .replace(/(?<![\p{L}\p{N}])(?:макс(?:имум)?|мах)(?![\p{L}\p{N}])/gu,'max').replace(/к1с|к1c|k1с/gu,'k1c').replace(/к1/gu,'k1')
  .replace(/\.gcode$/u,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
export type PrinterStatusFilter='free'|'printing'|'all';
export type VoiceParseContext={awaiting?:'file'|'printer'|'choice'};
export type VoiceReferences={usePreviousFile?:true;usePreviousPrinter?:true;otherPrinter?:true};
export type VoiceControlAction='light-on'|'light-off'|'pause'|'resume'|'camera';
export type VoiceForecastMode='finish'|'first'|'after';
/** Application sections the assistant can open by voice. */
export type VoiceNavigateTarget='dashboard'|'printers'|'tools'|'queue'|'files'|'history'|'settings'|'spools'|'tv'|'assistant'|'camera-guard'|'flash';
export const VOICE_NAVIGATE_TARGETS:readonly VoiceNavigateTarget[]=['dashboard','printers','tools','queue','files','history','settings','spools','tv','assistant','camera-guard','flash'];
export type VoiceIntent={kind:'confirm'|'cancel'|'help'|'check'|'tasks'}|{kind:'printers';filter:PrinterStatusFilter;countOnly?:boolean}|{kind:'choose';index:number}|{kind:'stock';query:string;afterPrint?:true;usePreviousPrinter?:true}|({kind:'control';action:VoiceControlAction;printerHint:string}&Pick<VoiceReferences,'usePreviousPrinter'>)|({kind:'forecast';mode:VoiceForecastMode;printerHint:string;minutes?:number}&Pick<VoiceReferences,'usePreviousPrinter'>)|({kind:'repeat';printerHint:string;fromHistory?:true}&Pick<VoiceReferences,'usePreviousPrinter'|'otherPrinter'>)|({kind:'navigate';target:VoiceNavigateTarget;printerHint:string}&Pick<VoiceReferences,'usePreviousPrinter'>)|({kind:'find'|'print';query:string;printerHint:string}&VoiceReferences)|({kind:'plan';query:string;printerHint:string;quantity:number;freeOnly?:true}&VoiceReferences)|({kind:'followup';query?:string;printerHint?:string;correctPreviousQuery?:true}&VoiceReferences);
const freeStatusWord=/^(?:свободен|свободна|свободно|свободны|свободный|свободная|свободное|свободные|свободных|готов|готова|готово|готовы|готовый|готовая|готовое|готовые|готовых)$/u;
const printingStatusWord=/^(?:печатает|печатают|печатающий|печатающая|печатающее|печатающие|печатающих)$/u;
const printerStatusNoun=/^принтер(?:ы|ов|а|е|ах)?$/u;
const statusInventoryWords=new Set('какие кто покажи есть ли сколько список состояние состояния статус статусы все всех всего мне меня мои моих мой наши наших у нас из сейчас теперь которые к для печати в на ферме пожалуйста'.split(' '));
const spokenStatusWords=new Set([...statusInventoryWords,'какой','который','то','же','3д','работы','работе','ничем','не','занят','занята','занято','заняты']);
function printerStatusQuery(text:string,printers?:PrinterModel[]):PrinterStatusFilter|undefined{
  const query=text.replace(/^(?:(?:ксения|ксюша|помощница|помощник|ну|так|а|и|слушай)\s+)+/u,'')
    .replace(/^(?:(?:можешь|можете)(?:\s+ли)?(?:\s+ты|\s+вы)?\s+)?(?:скажи|сказать|подскажи|подсказать|расскажи|рассказать|назови|назвать)(?:\s+мне)?(?:\s+пожалуйста)?\s+/u,'');
  if(!/^(?:какие|какой|который|кто|покажи|есть|сколько|список|состояние|статус|все|мой|мои|наши|принтер)(?:\s|$)/u.test(query)&&!/^принтеры(?:\s|$)/u.test(query))return;
  // Fast read-only route only for an unambiguous printer question. Other
  // phrasing goes to the language interpreter, including named-printer questions.
  if(/(?:^|\s)(?:файл\S*|модел\S*|детал\S*|найди|найти|поищи|напечат\S*|распечат\S*|печатай|поставь|отправь|запусти|подбери|подтвер\S*)(?:\s|$)/u.test(query))return;
  if(/(?:^|\s)не\s+(?:свобод\S*|готов\S*|печата\S*)(?:\s|$)/u.test(query))return;
  if(Object.values(aliases).some(names=>names.some(name=>` ${query} `.includes(` ${normalizeVoice(name)} `))))return;
  const words=query.split(' ');
  if(printers?.some(p=>{
    const nameWords=normalizeVoice(p.name).split(' ');
    if(nameWords.every(word=>spokenStatusWords.has(word)||printerStatusNoun.test(word)||freeStatusWord.test(word)||printingStatusWord.test(word)))return false;
    const count=nameWords.length;
    return count<=8&&words.some((_,index)=>printerNameMatches(p.name,words.slice(index,index+count).join(' ')));
  }))return;
  if(!words.every(word=>spokenStatusWords.has(word)||printerStatusNoun.test(word)||freeStatusWord.test(word)||printingStatusWord.test(word)||/^простаива\S*$/u.test(word)))return;
  const free=words.some(word=>freeStatusWord.test(word)||/^простаива\S*$/u.test(word))||/(?:^|\s)(?:ничем\s+)?не\s+занят\S*(?:\s|$)/u.test(query);
  const printing=words.some(word=>printingStatusWord.test(word));
  if(free&&printing)return;
  if(free)return'free';
  if(printing)return'printing';
  if(words.some(word=>printerStatusNoun.test(word))&&words.every(word=>statusInventoryWords.has(word)||printerStatusNoun.test(word)))return'all';
}
const previousFile=/^(?:этот(?: же)? файл|тот же файл|тот же|предыдущий файл|последний файл|этот|это|его)$/u;
const repeatFile=/^(?:то\s*же\s+самое|ту\s+же\s+(?:деталь|модель))$/u;
const negativeWords=/(?:^|\s)(?:не|нет|отмена|отмени|отменить)(?:\s|$)/u;
function printerWordForms(word:string){
  const forms=new Set([word]);
  if(!/^[а-я]+$/u.test(word)||word.length<3)return forms;
  const adjective=word.match(/^(.*)(?:ый|ий|ой|ая)$/u);
  if(adjective&&adjective[1].length>=3)for(const ending of ['ого','ому','ом','ем','ым','им','ой','ую','ая','ое','ые','ых','ими','ыми'])forms.add(adjective[1]+ending);
  else if(/[бвгджзклмнпрстфхцчшщ]$/u.test(word))for(const ending of ['а','у','е','ом'])forms.add(word+ending);
  else if(/[аяь]$/u.test(word))for(const ending of ['ы','и','е','у','я','ю','ой','ей','ем'])forms.add(word.slice(0,-1)+ending);
  return forms;
}
const printerKey=(value:string)=>normalizeVoice(value).replace(/(?<![\p{L}\p{N}])макс(?:а|е|у|ом)(?![\p{L}\p{N}])/gu,'max');
function printerNameMatches(name:string,hint:string){
  const names=printerKey(name).split(' '),words=printerKey(hint).split(' ');
  return names.length===words.length&&names.every((word,index)=>printerWordForms(word).has(words[index]));
}
function knownPrinter(hint:string,printers?:PrinterModel[]){
  return!!printers&&voicePrinterMatches(printers,hint).length>0||Object.values(aliases).some(names=>names.some(name=>printerNameMatches(name,hint)));
}
function matchingTargets(first:string,second:string,printers?:PrinterModel[]){
  if(printers){
    const left=voicePrinterMatches(printers,first).map(printer=>printer.id).sort(),right=voicePrinterMatches(printers,second).map(printer=>printer.id).sort();
    if(left.length&&right.length)return left.length===right.length&&left.every((id,index)=>id===right[index]);
  }
  if(printerKey(first)===printerKey(second))return true;
  const presets=(hint:string)=>Object.entries(aliases).filter(([,names])=>names.some(name=>printerNameMatches(name,hint))).map(([preset])=>preset);
  const left=presets(first),right=presets(second);return left.length===1&&right.length===1&&left[0]===right[0];
}
function splitPrinterTail(body:string,printers?:PrinterModel[]):{query:string;printerHint:string}&VoiceReferences{
  const reference=body.match(/(?:^|\s)(?:на|для)?\s*(?:(другом|другой)|(?:этом|том же|прежнем))\s+принтер(?:е|а)?$/u);
  if(reference)return{query:body.slice(0,reference.index).trim(),printerHint:'',...(reference[1]?{otherPrinter:true}:{usePreviousPrinter:true})};
  const explicit=body.match(/(?:^|\s)(?:на|для)\s+принтер(?:е|а)?\s+(.+)$/u);
  if(explicit)return{query:body.slice(0,explicit.index).trim(),printerHint:explicit[1]};
  for(const match of [...body.matchAll(/(?:^|\s)(?:на|для)\s+/gu)].reverse()){
    const hint=body.slice((match.index??0)+match[0].length);
    if(knownPrinter(hint,printers))return{query:body.slice(0,match.index).trim(),printerHint:hint};
  }
  return{query:body.trim(),printerHint:''};
}
function splitPrinterHead(body:string,printers?:PrinterModel[]){
  const plain=body.replace(/^(?:(?:на|для)\s+)?принтер(?:е|а)?\s+/u,'').replace(/^(?:на|для)\s+/u,''),words=plain.split(' ');
  for(let count=words.length;count>0;count--){const hint=words.slice(0,count).join(' ');if(knownPrinter(hint,printers))return{query:words.slice(count).join(' '),printerHint:hint};}
  return{query:body,printerHint:''};
}
const fileActionWords=/(?:^|\s)(?:найди|найти|поищи|отыщи|напечатай|напечатать|распечатай|распечатать|печатай|печатать|файл|файла|модель)(?:\s|$)/u;
const operationJoiner=/(?:^|\s)(?:и|или|а|но|затем|потом)(?:\s|$)/u;
/** Positive action evidence bounds a model-proposed command; no arbitrary G-code is accepted. */
export function voiceControlActions(value:string,printers?:PrinterModel[]):VoiceControlAction[]{
  const text=normalizeVoice(value).replace(/^(?:(?:ксения|ксюша|помощница|помощник|слушай|ну|так|а|и)\s+)+/u,'');
  if(negativeWords.test(text)||fileActionWords.test(text)||operationJoiner.test(text)||/(?:^|\s)(?:если|когда|после|перед|через|завтра|позже)(?:\s|$)/u.test(text))return[];
  const result:VoiceControlAction[]=[];
  if(/(?:^|\s)(?:свет|света|подсветку|подсветка|подсветки|освещение|освещения)(?:\s|$)/u.test(text)){
    if(/(?:^|\s)(?:включи|включить|зажги|зажечь|вруби|освети)(?:\s|$)/u.test(text))result.push('light-on');
    if(/(?:^|\s)(?:выключи|выключить|отключи|погаси|потуши|выруби)(?:\s|$)/u.test(text))result.push('light-off');
  }
  const shortTarget=(remainder:string)=>{
    const target=remainder.trim().replace(/^(?:на|у|для)\s+/u,'').replace(/^принтер(?:е|а)?\s+/u,'');
    return!!target&&(knownPrinter(target,printers)||/^(?:этом|том же|прежнем)\s+принтер(?:е|а)?$|^(?:нем|него)$/u.test(target));
  };
  const pauseVerb=/(?:^|\s)(?:приостанови|приостановить)(?:\s|$)/u;
  if(/(?:^|\s)(?:паузу|пауза)(?:\s|$)/u.test(text)&&/(?:^|\s)(?:поставь|поставить|сделай|приостанови|приостановить|пауза)(?:\s|$)/u.test(text)
    ||/(?:^|\s)(?:приостанови|приостановить)\s+(?:печать|работу)(?:\s|$)/u.test(text)
    ||pauseVerb.test(text)&&shortTarget(text.replace(pauseVerb,' ')))result.push('pause');
  const resume=/(?:^|\s)(?:продолжи|продолжить|возобнови|возобновить)(?:\s|$)/u;
  if(resume.test(text)&&(/(?:^|\s)(?:продолжи|продолжить|возобнови|возобновить)\s+(?:печать|работу)(?:\s|$)/u.test(text)||shortTarget(text.replace(resume,' ')))
    ||/(?:^|\s)(?:сними|убери)\s+(?:с\s+)?пауз(?:у|ы)(?:\s|$)/u.test(text))result.push('resume');
  if(/(?:^|\s)камер[ауыое](?:\s|$)/u.test(text)&&/(?:^|\s)(?:открой|открыть|покажи|показать|включи|включить|дай)(?:\s|$)/u.test(text))result.push('camera');
  return result;
}
function operationTarget(parts:string[],printers?:PrinterModel[]):{printerHint:string;usePreviousPrinter?:true}|undefined{
  let hint='',previous=false;
  for(const raw of parts){
    const part=raw.trim().replace(/^(?:пожалуйста\s+|мне\s+)+/u,'').replace(/\s+пожалуйста$/u,'');
    if(!part||/^(?:печать|работу|работы|принтер)$/u.test(part))continue;
    if(/^(?:(?:на|у|для)\s+)?(?:этом|этот|том же|прежнем)\s+принтер(?:е|а)?$|^(?:на нем|у него)$/u.test(part)){previous=true;continue;}
    const plain=part.replace(/^(?:(?:на|у|для)\s+)?принтер(?:е|а)?\s+/u,'').replace(/^(?:на|у|для)\s+/u,'');
    if(!plain||plain.length>128||operationJoiner.test(plain)||fileActionWords.test(plain))return;
    if(hint&&!matchingTargets(hint,plain,printers))return;
    hint=plain;
  }
  if(previous&&hint)return;
  return{printerHint:hint,...(previous?{usePreviousPrinter:true}:{})};
}
/** Read an explicitly stated horizon; an unspecified "later" has no numeric default. */
export function voiceForecastMinutes(value:string):number|undefined{
  if(/через\s*[-−]/iu.test(value))return;
  const horizon=normalizeVoice(value).match(/(?:^|\s)через\s+(.+)$/u)?.[1];
  if(!horizon||operationJoiner.test(horizon))return;
  const words:Record<string,number>={'полтора часа':90,'пол часа':30,полчаса:30,'один час':60,'два часа':120,'три часа':180,'четыре часа':240,'пять минут':5,'десять минут':10,'пятнадцать минут':15,'двадцать минут':20,'тридцать минут':30,час:60};
  for(const [word,minutes] of Object.entries(words))if(horizon===word||horizon.startsWith(word+' '))return minutes;
  const numeric=horizon.match(/^(\d+)\s*(минут(?:а|ы)?|мин|час(?:а|ов)?)(?=\s|$)/u);
  const minutes=numeric?Number(numeric[1])*(numeric[2].startsWith('час')?60:1):NaN;
  return Number.isInteger(minutes)&&minutes>=1&&minutes<=10_080?minutes:undefined;
}
function printerOperationIntent(value:string,printers?:PrinterModel[]):Extract<VoiceIntent,{kind:'control'|'forecast'}>|undefined{
  const text=value.replace(/^(?:(?:ксения|ксюша|помощница|помощник|слушай|ну|так|а|и)\s+)+/u,'')
    .replace(/^(?:(?:можешь|можете)(?:\s+ли)?(?:\s+ты|\s+вы)?|(?:я\s+)?хочу)\s+/u,'').replace(/^пожалуйста\s+/u,'')
    .replace(/^(?:скажи|подскажи|расскажи)(?:\s+мне)?\s+/u,'').replace(/\s+пожалуйста$/u,'');
  if(negativeWords.test(text)||operationJoiner.test(text))return;
  if(/^(?:кто|какой принтер|который принтер)(?:\s+из\s+(?:принтеров|них|наших))?\s+(?:освободится|закончит(?:\s+печать)?|завершит(?:\s+печать)?)\s+(?:первым|раньше(?: всех)?)$/u.test(text))return{kind:'forecast',mode:'first',printerHint:''};
  const after=text.match(/^(?:что|какие принтеры|кто)\s+(?:еще\s+)?буд(?:ет|ут)\s+(?:еще\s+)?печатать(?:ся)?\s+через\s+(.+)$/u);
  if(after){
    const minutes=voiceForecastMinutes(text);
    if(minutes!==undefined)return{kind:'forecast',mode:'after',printerHint:'',minutes};
    return;
  }
  const finish=text.match(/^когда\s+(?:закончит(?:\s+печать)?|закончится(?:\s+печать)?|завершит(?:\s+печать)?|завершится(?:\s+печать)?|освободится)(?=\s|$)\s*(.*)$/u)
    ??text.match(/^когда\s+(.+?)\s+(?:закончит(?:\s+печать)?|завершит(?:\s+печать)?|освободится)$/u)
    ??text.match(/^сколько\s+(?:еще\s+)?(?:времени\s+)?(?:будет\s+)?(?:занят|занята|занято|печатать)\s+(.+)$/u)
    ??text.match(/^сколько\s+(?:еще\s+)?(?:времени\s+)?(.+?)\s+(?:будет\s+)?(?:занят|занята|занято|печатать)$/u);
  if(finish){const target=operationTarget([finish[1]],printers);if(target)return{kind:'forecast',mode:'finish',...target};}
  const actions=voiceControlActions(text,printers);if(actions.length!==1)return;
  const patterns:Partial<Record<VoiceControlAction,RegExp[]>>={
    'light-on':[/^(.*?)\s*(?:включи|включить|зажги|зажечь|вруби|освети)\s+(?:пожалуйста\s+)?(?:свет|подсветку|освещение)(?:\s+(.*))?$/u],
    'light-off':[/^(.*?)\s*(?:выключи|выключить|отключи|погаси|потуши|выруби)\s+(?:пожалуйста\s+)?(?:свет|подсветку|освещение)(?:\s+(.*))?$/u],
    pause:[/^(.*?)\s*(?:поставь|поставить)\s+(.*?)\s*на\s+паузу(?:\s+(.*))?$/u,/^(.*?)\s*(?:приостанови|приостановить)\s+(?:печать|работу)(?:\s+(.*))?$/u,/^(.*?)\s*(?:приостанови|приостановить)(?:\s+(.*))?$/u,/^(.*?)\s*пауза(?:\s+(.*))?$/u],
    resume:[/^(.*?)\s*(?:продолжи|продолжить|возобнови|возобновить)\s+(?:печать|работу)(?:\s+(.*))?$/u,/^(.*?)\s*(?:продолжи|продолжить|возобнови|возобновить)(?:\s+(.*))?$/u],
    camera:[/^(.*?)\s*(?:открой|открыть|покажи|показать|включи|включить)\s+(?:мне\s+)?камеру(?:\s+(.*))?$/u],
  };
  for(const pattern of patterns[actions[0]]??[]){
    const match=text.match(pattern);if(!match)continue;
    const parts=match.slice(1).map(part=>part??'');
    // Text before a command is a printer name, never an arbitrary sentence prefix.
    const prefix=parts[0].trim();
    if(prefix&&!knownPrinter(prefix.replace(/^(?:на|у|для)\s+/u,'').replace(/^принтер(?:е|а)?\s+/u,''),printers))continue;
    const target=operationTarget(parts,printers);if(target)return{kind:'control',action:actions[0],...target};
  }
}
function followupIntent(text:string,printers?:PrinterModel[]):Extract<VoiceIntent,{kind:'followup'}>|undefined{
  const body=text.replace(/^(?:а\s+)?(?:нет\s+)?(?:лучше\s+)?/u,'');
  const target=splitPrinterTail(body,printers),reference=previousFile.test(target.query);
  if(!target.query||reference){
    if(target.printerHint||target.usePreviousPrinter||target.otherPrinter||reference)return{kind:'followup',...(target.printerHint?{printerHint:target.printerHint}:{}),...(target.usePreviousPrinter?{usePreviousPrinter:true}:{}),...(target.otherPrinter?{otherPrinter:true}:{}),...(reference?{usePreviousFile:true}:{})};
  }
  if(knownPrinter(body,printers))return{kind:'followup',printerHint:body};
}
const copyCounts:Record<string,number>={один:1,одну:1,одно:1,два:2,две:2,три:3,четыре:4,пять:5,шесть:6,семь:7,восемь:8,девять:9,десять:10};
/** A batch request creates a reviewable plan, never a direct print or confirmation. */
function planningIntent(text:string,printers?:PrinterModel[]):Extract<VoiceIntent,{kind:'plan'}>|undefined{
  let body:string|undefined,quantity=1,freeOnly=false;
  const batch=text.match(/^(?:(?:мне|нам)\s+)?(?:нужно|надо)\s+(один|одну|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|\d+)\s+(.+)$/u)
    ??text.match(/^(?:напечатай|напечатать|распечатай|распечатать|подготовь|подготовить)\s+(?:мне\s+)?(один|одну|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|\d+)\s+(.+)$/u);
  if(batch){quantity=copyCounts[batch[1]]??Number(batch[1]);body=batch[2].replace(/^(?:копи[яиюй]|экземпляр(?:а|ов)?|запуск(?:а|ов)?)\s+(?:файла\s+)?/u,'');}
  else{
    const plan=text.match(/^(?:составь|подготовь|предложи)\s+(?:мне\s+)?(?:план|очередь)\s+(?:печати\s+)?(?:для\s+)?(.+)$/u);
    const select=text.match(/^(?:(?:посмотри|проверь|покажи)\s+свободные\s+принтеры\s+и\s+)?подбери\s+(?:(свободный|подходящий)\s+)?(?:принтер\s+)?для\s+(.+)$/u);
    if(plan)body=plan[1];
    else if(select){body=select[2];freeOnly=select[1]==='свободный'||/^.*свободные принтеры и /u.test(text);}
  }
  if(!body||!Number.isInteger(quantity)||quantity<1||quantity>20||/(?:^|\s)(?:и|а|но)\s+(?:напечатай|запусти|отправь|подтверди|подтверждаю|удали|отмени)(?:\s|$)/u.test(body))return;
  const target=splitPrinterTail(body,printers),reference=previousFile.test(target.query)||/^(?:этой|этого)\s+(?:модели|файла)$/u.test(target.query);
  return{kind:'plan',query:reference?'':target.query,printerHint:target.printerHint,quantity,...(freeOnly?{freeOnly:true}:{}),...(reference?{usePreviousFile:true}:{}),...(target.usePreviousPrinter?{usePreviousPrinter:true}:{}),...(target.otherPrinter?{otherPrinter:true}:{})};
}
export function parseVoiceCommand(value:string,printers?:PrinterModel[],context:VoiceParseContext={}):VoiceIntent{
  const text=normalizeVoice(value).replace(/^(?:(?:пожалуйста|помощник)\s+)+/u,'').replace(/\s+пожалуйста$/u,'');
  const choice=text.match(/^(?:выбери|выбрать|вариант)\s+(?:вариант\s+)?(первый|второй|третий|четвертый|пятый|один|два|три|четыре|пять|\d+)$/u)
    ??(context.awaiting==='choice'||context.awaiting==='printer'?text.match(/^(первый|второй|третий|четвертый|пятый|один|два|три|четыре|пять|\d+)(?:\s+(?:файл|вариант))?$/u):null);
  if(choice){const numbers:Record<string,number>={первый:1,второй:2,третий:3,четвертый:4,пятый:5,один:1,два:2,три:3,четыре:4,пять:5};return{kind:'choose',index:(numbers[choice[1]]??Number(choice[1]))-1};}
  if(/^(?:подтверждаю печать|подтвердить печать|запускай печать)$/u.test(text))return{kind:'confirm'};
  if(/^(?:отмена|отмени|отменить|не печатай|нет)$/u.test(text))return{kind:'cancel'};
  const correction=context.awaiting==='file'||context.awaiting==='choice'?text.match(/^(?:правильно|я сказала|нет называется|название)\s+(.+)$/u):null;
  if(correction)return negativeWords.test(correction[1])?{kind:'help'}:{kind:'followup',query:correction[1],correctPreviousQuery:true};
  if(/^нет\s+/u.test(text)){const correction=followupIntent(text,printers);if(correction)return correction;}
  const spokenStatus=printerStatusQuery(text,printers);
  if(spokenStatus==='free'&&!/(?:^|\s)не(?:\s|$)/u.test(text.replace(/(?:^|\s)(?:ничем\s+)?не\s+занят\S*(?:\s|$)/u,' ')))return{kind:'printers',filter:'free',...(/(?:^|\s)сколько(?:\s|$)/u.test(text)?{countOnly:true}:{})};
  if(negativeWords.test(text))return{kind:'help'};
  const operation=printerOperationIntent(text,printers);if(operation)return operation.kind==='forecast'&&operation.mode==='after'&&/через\s*[-−]/iu.test(value)?{kind:'help'}:operation;
  if(/^(?:(?:покажи|расскажи|проверь|открой)\s+)?(?:(?:мою|мои|свои)\s+)?(?:очередь(?:\s+помощника)?|задания(?:\s+помощника)?|план\s+печати)$/u.test(text))return{kind:'tasks'};
  const planning=planningIntent(text,printers);if(planning)return planning;
  let commandText=text.replace(/^(?:(?:я\s+)?хочу|можешь(?:\s+ли)?(?:\s+ты)?|можете(?:\s+ли)?(?:\s+вы)?|(?:мне\s+)?(?:нужно|надо)|можно(?:\s+ли)?)\s+/u,'').replace(/^пожалуйста\s+/u,'');
  if(/^давай(?:те)?(?:\s|$)/u.test(commandText)){
    commandText=commandText.replace(/^давай(?:те)?\s*/u,'');
    const sharedActions:Record<string,string>={найдем:'найди',поищем:'поищи',напечатаем:'напечатай',распечатаем:'распечатай'};
    commandText=commandText.replace(/^(найдем|поищем|напечатаем|распечатаем)(?=\s|$)/u,word=>sharedActions[word]);
    if(/^(?:подтвер|запускай)/u.test(commandText))return{kind:'help'};
    if(/^(?:проверь|проверить|проверим|посмотрим|покажи(?!\s+файл)|скажи|подскажи|узнаем|отменим|остановим|останови|остановить|удали|удалить|сколько|какие|кто)(?:\s|$)/u.test(commandText))return{kind:'help'};
    if(!/^(?:найди|найти|поищи|покажи файл|напечатай|напечатать|распечатай|распечатать|печатай|печатать|поставь|отправь|запусти)(?:\s|$)/u.test(commandText))commandText='напечатай '+commandText;
  }
  const politePlanning=planningIntent(commandText,printers);if(politePlanning)return politePlanning;
  // A repeat is grounded in a selected file or a confirmed local task by the
  // assistant. It is never a filename invented by the language model.
  if(/(?:^|\s)(?:то\s*же\s+самое|ту\s+же\s+(?:деталь|модель)|повтори|повторить)(?:\s|$)/u.test(commandText)){
    commandText=commandText.replace(/^(?:(?:ксения|ксюша|помощница|слушай)\s+)+/u,'');
  }
  const repeatAction=commandText.match(/(?:^|\s)(?:повтори|повторить)\s+(?:(?:последнюю|предыдущую)\s+)?печать(?=\s|$)/u);
  if(repeatAction){
    const prefix=commandText.slice(0,repeatAction.index).trim(),head=splitPrinterHead(prefix,printers);
    const suffix=commandText.slice((repeatAction.index??0)+repeatAction[0].length).trim(),tail=splitPrinterTail(('то же самое '+suffix).trim(),printers);
    if((!prefix||head.printerHint&&!head.query)&&tail.query==='то же самое'&&!(head.printerHint&&(tail.otherPrinter||tail.usePreviousPrinter))&&!(head.printerHint&&tail.printerHint&&!matchingTargets(head.printerHint,tail.printerHint,printers)))return{kind:'repeat',printerHint:tail.printerHint||head.printerHint,fromHistory:true,...(tail.otherPrinter?{otherPrinter:true}:{}),...(tail.usePreviousPrinter?{usePreviousPrinter:true}:{})};
    return{kind:'help'};
  }
  commandText=commandText.replace(/^(.*?)(?:^|\s)(поставь|поставить|отправь|отправить)\s+(?:пожалуйста\s+)?(.+?)\s+на\s+печать(?=\s|$)/u,(whole:string,head:string,verb:string,body:string)=>{
    const target=splitPrinterHead(head.trim(),printers);
    return head.trim()&&(!target.printerHint||target.query)?whole:`${head} ${verb} на печать ${body}`.trim();
  });
  const action=commandText.match(/(?:^|\s)(найди|найти|поищи|покажи файл|напечатай|напечатать|напечатаю|распечатай|распечатать|распечатаю|печатай|печатать|поставь на печать|поставить на печать|отправь на печать|отправить на печать|запусти печать)(?=\s|$)/u);
  const prefix=action?commandText.slice(0,action.index).trim().replace(/\s+(?:пожалуйста|нужно|надо|можно)$/u,''):'';
  // Accept the named printer before the action, while rejecting arbitrary or negated prefixes.
  const leadingPrinter=prefix.match(/^(?:(?:на|для)\s+)?принтер(?:е|а)?\s+(.+)$/u)
    ??prefix.match(/^(?:на|для)\s+(.+)$/u)
    ??(prefix&&knownPrinter(prefix,printers)?['',prefix]:undefined);
  if(action){
    let bodyAfter=commandText.slice((action.index??0)+action[0].length).trim().replace(/^пожалуйста\s+/u,''),headHint=leadingPrinter?.[1]??'';
    const namedHead=splitPrinterHead(prefix,printers);
    if(prefix&&(!leadingPrinter||!knownPrinter(headHint,printers)&&namedHead.printerHint&&namedHead.query)){
      const suffix=splitPrinterTail(bodyAfter,printers);
      if(bodyAfter&&suffix.query)return{kind:'help'};
      headHint=namedHead.printerHint;bodyAfter=[namedHead.query,bodyAfter].filter(Boolean).join(' ');
    }
    const namedFile=/^файл(?:\s|$)/u.test(bodyAfter)||action[1]==='покажи файл';
    const rawBody=bodyAfter.replace(/^файл(?:\s+|$)/u,'');
    const compound=rawBody.match(/\s+и\s+(?:(?:поставь|отправь)\s+(?:его\s+)?на\s+печать|(?:запусти|напечатай|печатай)(?:\s+его)?)(?=\s+(?:на|для)\s+|$)/u)
      ??(!namedFile?rawBody.match(/\s+(?:поставь|отправь)\s+(?:его\s+)?на\s+печать(?=\s+(?:на|для)\s+|$)/u):null);
    const body=(compound?rawBody.slice(0,compound.index)+rawBody.slice((compound.index??0)+compound[0].length):rawBody).trim();
    if(/(?:^|\s)(?:и|а|но)\s+(?:найди|найти|поищи|покажи|напечатай|напечатать|напечатаю|распечатай|распечатать|распечатаю|печатай|печатать|поставь|отправь|запусти|проверь|проверить|отмена|отмени|отменить|подтверждаю|подтвердить)(?:\s|$)/u.test(body))return{kind:'help'};
    const target=splitPrinterTail(body,printers);
    if(headHint&&target.printerHint&&!matchingTargets(headHint,target.printerHint,printers))return{kind:'help'};
    if(headHint&&(target.usePreviousPrinter||target.otherPrinter))return{kind:'help'};
    const query=namedFile?target.query:target.query.replace(/^(?:этот|эту|это)\s+(?!файл$)/u,'');
    const reference=!namedFile&&previousFile.test(target.query);
    const print=!/^(?:найди|найти|поищи|покажи файл)$/u.test(action[1])||!!compound;
    if(print&&!namedFile&&repeatFile.test(target.query))return{kind:'repeat',printerHint:target.printerHint||headHint,...(target.usePreviousPrinter?{usePreviousPrinter:true}:{}),...(target.otherPrinter?{otherPrinter:true}:{})};
    return{kind:print?'print':'find',query:reference?'':query,printerHint:target.printerHint||headHint,...(reference?{usePreviousFile:true}:{}),...(target.usePreviousPrinter?{usePreviousPrinter:true}:{}),...(target.otherPrinter?{otherPrinter:true}:{})};
  }
  if(/^(?:проверь|проверить)\s+(?:запуск|печать)$/u.test(text))return{kind:'check'};
  if(/(?:пластик|филамент|катушк|запас)/u.test(text)&&/(?:сколько|остат|остал|запас)/u.test(text))return{kind:'stock',query:text,...(/(?:^|\s)остан(?:ется|утся)(?:\s|$)|после\s+(?:(?:этой|текущей)\s+печати|(?:этого|текущего)\s+файла|печати)/u.test(text)?{afterPrint:true}:{}),...(/после\s+(?:этой\s+печати|этого\s+файла)|(?:на|у)\s+(?:этом\s+принтере|том\s+же\s+принтере|нем|него)/u.test(text)?{usePreviousPrinter:true}:{})};
  const statusFilter=printerStatusQuery(commandText.replace(/^а\s+/u,''),printers);
  if(statusFilter)return{kind:'printers',filter:statusFilter,...(/(?:^|\s)сколько(?:\s|$)/u.test(text)?{countOnly:true}:{})};
  const followup=followupIntent(text,printers);if(followup)return followup;
  if(/подтвер(?:д|жд)|запускай\s+печать/u.test(text))return{kind:'help'};
  if(context.awaiting==='file'){
    const target=splitPrinterTail(text.replace(/^(?:файл|название файла)\s+/u,''),printers);
    return{kind:'followup',query:target.query,...(target.printerHint?{printerHint:target.printerHint}:{}),...(target.usePreviousPrinter?{usePreviousPrinter:true}:{}),...(target.otherPrinter?{otherPrinter:true}:{})};
  }
  if(context.awaiting==='printer')return{kind:'followup',printerHint:text.replace(/^(?:(?:на|для)\s+)?принтер(?:е|а)?\s+/u,'').replace(/^(?:на|для)\s+/u,'')};
  return{kind:'help'};
}
const aliases:Record<string,string[]>={
  'creality-k1-max':['k1 max','креалити k1 max','макс'],
  'creality-k1c-2025':['k1c','k1c 2025','креалити k1c'],
  'flashforge-ad5m':['5m','форж','флэшфордж','флешфордж','адвентурер 5m'],
  'ender3-v3-ke':['ке','эндер','эндер ке','эндер три ке'],
};
export function voicePrinterMatches(printers:PrinterModel[],hint:string){
  const query=normalizeVoice(hint);if(!query)return printers;
  const names=(p:PrinterModel)=>{
    const selected=p.modelSelection?.selectedPreset,preset=selected&&selected!=='custom'?selected:p.profile?.preset;
    return[p.name,...(aliases[preset??'']??[])];
  };
  const exact=printers.filter(p=>names(p).some(name=>normalizeVoice(name)===query));
  return exact.length?exact:printers.filter(p=>names(p).some(name=>printerNameMatches(name,hint)));
}
const transliteration:Record<string,string>={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
const searchable=(value:string)=>[...normalizeVoice(value)].map(c=>transliteration[c]??c).join('');
export function voiceFileMatches(path:string,query:string){
  const tokens=searchable(query).split(' ').filter(Boolean),words=searchable(path).split(' ').filter(Boolean).sort((a,b)=>a.length-b.length),used=new Set<number>();
  if(!tokens.length||tokens.length>20)return false;
  // Multiple spoken words must stay whole; split/merged words belong in suggestions.
  // A single plain name may still be a fragment, but identifiers cannot be truncated.
  return tokens.sort((a,b)=>b.length-a.length).every(token=>{
    const index=words.findIndex((word,index)=>!used.has(index)&&(tokens.length>1||/\d/.test(token)||token==='i'?word===token:word.includes(token)));
    if(index<0)return false;used.add(index);return true;
  });
}
function boundedFileEditMatch(query:string,candidate:string){
  if(query.length<5||query.length>64||candidate.length>64||/\d/.test(query+candidate))return false;
  const limit=query.length>=9?2:1;
  if(Math.abs(candidate.length-query.length)>limit)return false;
  let previous=Array.from({length:candidate.length+1},(_,i)=>i);
  for(let i=1;i<=query.length;i++){
    const current=[i];
    for(let j=1;j<=candidate.length;j++)current[j]=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(query[i-1]===candidate[j-1]?0:1));
    if(Math.min(...current)>limit)return false;
    previous=current;
  }
  return previous[candidate.length]<=limit;
}
// A near match is a suggestion only; short names and numeric identifiers stay exact.
export function voiceFileNearMatch(path:string,query:string){
  const queryTokens=normalizeVoice(query).split(' ').filter(Boolean).filter(word=>word!=='и').map(searchable),name=searchable(path),words=name.split(' ').filter(Boolean);
  if(!queryTokens.length||queryTokens.length>20)return false;
  if(queryTokens.some(token=>/\d/.test(token)&&!words.includes(token)))return false;
  // Speech can split a word, merge adjacent words, or insert a standalone «и».
  // These space-insensitive matches remain suggestions and never prepare a print.
  const compact=queryTokens.join('');
  if(compact.length>=5&&compact.length<=128&&words.join('').includes(compact))return true;
  const singleMatches=queryTokens.map(token=>{
    if(/\d/.test(token))return words.includes(token);
    if(words.includes(token)||token.length>=5&&name.includes(token))return true;
    return words.some(word=>boundedFileEditMatch(token,word));
  });
  if(singleMatches.every(Boolean))return true;
  // A short spoken fragment can also contain an error. Join only bounded,
  // contiguous letter spans and keep every numeric identifier outside this step.
  const spans=new Set<string>();
  for(let start=0;start<words.length;start++){
    let joined='';
    for(let end=start;end<Math.min(start+4,words.length);end++){
      if(/\d/.test(words[end]))break;joined+=words[end];
      if(joined.length>64)break;spans.add(joined);
    }
  }
  const candidates=[...spans];
  const matched=Array<boolean>(queryTokens.length+1).fill(false);matched[queryTokens.length]=true;
  for(let start=queryTokens.length-1;start>=0;start--){
    if(singleMatches[start]&&matched[start+1]){matched[start]=true;continue;}
    let joined='';
    for(let end=start;end<Math.min(start+4,queryTokens.length);end++){
      if(/\d/.test(queryTokens[end]))break;joined+=queryTokens[end];
      if(joined.length>64)break;
      if(matched[end+1]&&candidates.some(span=>boundedFileEditMatch(joined,span))){matched[start]=true;break;}
    }
  }
  return matched[0];
}
