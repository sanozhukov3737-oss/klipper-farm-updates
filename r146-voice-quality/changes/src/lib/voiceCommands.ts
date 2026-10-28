import type { PrinterModel } from '../types';

export const normalizeVoice=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/ё/g,'е')
  .replace(/(?:кей|кэй|ка|к)\s*(?:один|1)\s*(?:си|с|c)/gu,'k1c')
  .replace(/(?:кей|кэй|ка|к)\s*(?:один|1)/gu,'k1')
  .replace(/(?:k|к)1\s*(?:max|макс|мах)(?![\p{L}\p{N}])/gu,'k1 max')
  .replace(/(?:пять|5)\s*(?:эм|м|m)/gu,'5m')
  .replace(/(?<![\p{L}\p{N}])(?:макс(?:имум)?|мах)(?![\p{L}\p{N}])/gu,'max').replace(/к1с|к1c|k1с/gu,'k1c').replace(/к1/gu,'k1')
  .replace(/\.gcode$/u,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
export type VoiceIntent={kind:'confirm'|'cancel'|'help'|'printers'|'check'}|{kind:'choose';index:number}|{kind:'stock';query:string}|{kind:'find'|'print';query:string;printerHint:string};
export function parseVoiceCommand(value:string):VoiceIntent{
  const text=normalizeVoice(value).replace(/^(?:(?:пожалуйста|помощник)\s+)+/u,'').replace(/\s+пожалуйста$/u,'');
  const choice=text.match(/^(?:выбери|выбрать|вариант)\s+(?:вариант\s+)?(первый|второй|третий|четвертый|пятый|один|два|три|четыре|пять|\d+)$/u);
  if(choice){const numbers:Record<string,number>={первый:1,второй:2,третий:3,четвертый:4,пятый:5,один:1,два:2,три:3,четыре:4,пять:5};return{kind:'choose',index:(numbers[choice[1]]??Number(choice[1]))-1};}
  if(/^(?:подтверждаю печать|подтвердить печать|запускай печать)$/u.test(text))return{kind:'confirm'};
  if(/^(?:отмена|отмени|отменить|не печатай|нет)$/u.test(text))return{kind:'cancel'};
  if(/(?:проверь|проверить) (?:запуск|печать)/u.test(text))return{kind:'check'};
  if(/(?:пластик|филамент|катушк|запас)/u.test(text)&&/(?:сколько|остат|остал|запас)/u.test(text))return{kind:'stock',query:text};
  if(/(?:какие|кто|покажи|список|состояние).*(?:принтер|свобод|печата)/u.test(text))return{kind:'printers'};
  const action=text.match(/(?:^|\s)(найди|найти|поищи|покажи файл|напечатай|напечатать|напечатаю|распечатай|распечатать|распечатаю|печатай|печатать|поставь на печать|отправь на печать|запусти печать)\s+/u);
  const prefix=action?text.slice(0,action.index).trim():'';
  // Accept the named printer before the action, while rejecting arbitrary or negated prefixes.
  const leadingPrinter=prefix.match(/^(?:(?:на|для)\s+)?принтер(?:е|а)?\s+(.+)$/u)
    ??prefix.match(/^(?:на|для)\s+(.+)$/u);
  if(action&&(!prefix||leadingPrinter)&&!/(?:^|\s)(?:не|нет|отмена|отмени)(?:\s|$)/u.test(prefix)){
    const print=/(?:напечатай|напечатать|напечатаю|распечатай|распечатать|распечатаю|печатай|печатать|поставь на печать|отправь на печать|поставь.*печать)/u.test(text);
    const body=text.slice((action.index??0)+action[0].length).replace(/^файл\s+/u,'')
      .replace(/\s+(?:и\s+)?(?:поставь|отправь)\s+(?:его\s+)?на\s+печать/u,'')
      .replace(/\s+(?:и\s+)?(?:запусти|напечатай|печатай)(?:\s+его)?/u,'').trim();
    const tail=body.match(/\s+(?:на|для)\s+(?:принтер(?:е|а)?\s+)?(.+)$/u);
    const query=(tail?body.slice(0,tail.index):body).trim();
    if(leadingPrinter&&tail&&normalizeVoice(leadingPrinter[1])!==normalizeVoice(tail[1]))return{kind:'help'};
    return{kind:print||action[1]==='запусти печать'?'print':'find',query,printerHint:tail?.[1]??leadingPrinter?.[1]??''};
  }
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
  return printers.filter(p=>[p.name,...(aliases[p.profile?.preset??'']??[])].some(name=>normalizeVoice(name)===query));
}
const transliteration:Record<string,string>={а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
const searchable=(value:string)=>[...normalizeVoice(value)].map(c=>transliteration[c]??c).join('');
export function voiceFileMatches(path:string,query:string){
  const tokens=searchable(query).split(' ').filter(Boolean),name=searchable(path);
  return tokens.length>0&&tokens.every(token=>name.includes(token));
}
// A near match is a suggestion only; short names and numeric identifiers stay exact.
export function voiceFileNearMatch(path:string,query:string){
  const queryTokens=searchable(query).split(' ').filter(Boolean),name=searchable(path),words=name.split(' ').filter(Boolean);
  if(!queryTokens.length||queryTokens.length>20)return false;
  return queryTokens.every(token=>{
    if(name.includes(token))return true;
    if(token.length<5||token.length>64||/\d/.test(token))return false;
    const limit=token.length>=9?2:1;
    return words.some(word=>{
      if(word.length>64||/\d/.test(word)||Math.abs(word.length-token.length)>limit)return false;
      let previous=Array.from({length:word.length+1},(_,i)=>i);
      for(let i=1;i<=token.length;i++){
        const current=[i];
        for(let j=1;j<=word.length;j++)current[j]=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(token[i-1]===word[j-1]?0:1));
        if(Math.min(...current)>limit)return false;
        previous=current;
      }
      return previous[word.length]<=limit;
    });
  });
}
