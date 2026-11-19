export type VoicePronunciationEntry={word:string;pronunciation:string};
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type WriteResult={saved:boolean;reason?:'invalid-input'|'storage-unavailable'|'limit'};
export const VOICE_PRONUNCIATION_MAX_ENTRIES=64;
const PREFIX='klipper-voice-pronunciation-v1:',MAX_STORED=16_384;
const wordKey=(value:unknown)=>typeof value==='string'&&value.length<=80&&/^[а-яё]+$/iu.test(value.trim())?value.trim().toLocaleLowerCase('ru'):'';
function entry(word:unknown,pronunciation:unknown):VoicePronunciationEntry|undefined{
  const key=wordKey(word);
  if(!key||typeof pronunciation!=='string'||pronunciation.length>160)return;
  const marked=pronunciation.trim().normalize('NFC').replace(/([аеиоуыэюяё])\u0301/giu,'+$1');
  if(!/^[а-яё]*\+[аеёиоуыэюя][а-яё]*$/iu.test(marked)||marked.replace('+','').toLocaleLowerCase('ru')!==key)return;
  return{word:key,pronunciation:marked.toLocaleLowerCase('ru')};
}

/** Profile-local pronunciation only. It never rewrites commands, catalog names or paths. */
export class VoicePronunciation{
  private readonly key?:string;
  constructor(private readonly storage:StorageLike|undefined,readonly profileId:string){
    if(!profileId||profileId.length>128||!profileId.trim()||/[\p{Cc}\p{Cf}]/u.test(profileId))return;
    try{this.key=PREFIX+encodeURIComponent(profileId)}catch{/* профиль не кодируется: словарь работает без сохранения */}
  }
  snapshot():{available:boolean;entries:VoicePronunciationEntry[]}{
    if(!this.storage||!this.key)return{available:false,entries:[]};
    let raw:string|null;try{raw=this.storage.getItem(this.key)}catch{return{available:false,entries:[]}}
    const entries:VoicePronunciationEntry[]=[],seen=new Set<string>();
    if(!raw||raw.length>MAX_STORED)return{available:true,entries};
    try{
      const parsed:unknown=JSON.parse(raw);
      if(!parsed||typeof parsed!=='object'||(parsed as {version?:unknown}).version!==1||!Array.isArray((parsed as {entries?:unknown}).entries))return{available:true,entries};
      for(const value of (parsed as {entries:unknown[]}).entries.slice(0,VOICE_PRONUNCIATION_MAX_ENTRIES*2)){
        if(!value||typeof value!=='object')continue;
        const row=value as {word?:unknown;pronunciation?:unknown},valid=entry(row.word,row.pronunciation);
        if(!valid||seen.has(valid.word))continue;seen.add(valid.word);entries.push(valid);
        if(entries.length===VOICE_PRONUNCIATION_MAX_ENTRIES)break;
      }
    }catch{
      // Хранилище прочиталось, но содержимое разобрать нельзя: файл повреждён,
      // запись оборвалась на середине или его правили руками. Вернуть здесь
      // «доступно, записей нет» значит показать оператору пустой словарь
      // произношений вместо повреждённого — он не поймёт, что слова пропали.
      return{available:false,entries:[]};
    }
    return{available:true,entries};
  }
  save(word:string,pronunciation:string):WriteResult{
    const row=entry(word,pronunciation);if(!row)return{saved:false,reason:'invalid-input'};
    const current=this.snapshot();if(!current.available)return{saved:false,reason:'storage-unavailable'};
    const remaining=current.entries.filter(value=>value.word!==row.word);
    if(remaining.length===VOICE_PRONUNCIATION_MAX_ENTRIES)return{saved:false,reason:'limit'};
    return this.write([...remaining,row]);
  }
  remove(word:string):WriteResult{
    const key=wordKey(word);if(!key)return{saved:false,reason:'invalid-input'};
    const current=this.snapshot();if(!current.available)return{saved:false,reason:'storage-unavailable'};
    return this.write(current.entries.filter(row=>row.word!==key));
  }
  reset():WriteResult{
    if(!this.snapshot().available)return{saved:false,reason:'storage-unavailable'};
    return this.write([]);
  }
  apply(text:string,maxCharacters=1200):string{
    const limit=Number.isFinite(maxCharacters)?Math.max(0,Math.min(1200,Math.floor(maxCharacters))):1200;
    if(!limit)return'';
    const pronunciations=new Map(this.snapshot().entries.map(row=>[row.word,row.pronunciation]));
    const spoken=text.slice(0,4096).replace(/\s+/gu,' ').trim().replace(/(?<![\p{L}\p{M}\p{N}_+])[а-яё]+(?![\p{L}\p{M}\p{N}_+])/giu,word=>{
      const marked=pronunciations.get(word.toLocaleLowerCase('ru'));if(!marked)return word;
      const stress=marked.indexOf('+');return word.slice(0,stress)+'+'+word.slice(stress);
    });
    let bounded=spoken.slice(0,limit);
    // Do not cut between a stress marker and its vowel or speak a partial word.
    if(spoken.length>limit&&/[\p{L}\p{M}\p{N}_+]/u.test(spoken[limit]??'')&&/[\p{L}\p{M}\p{N}_+]$/u.test(bounded))bounded=bounded.replace(/[\p{L}\p{M}\p{N}_+]+$/u,'').trimEnd();
    return bounded;
  }
  private write(entries:VoicePronunciationEntry[]):WriteResult{
    if(!this.storage||!this.key)return{saved:false,reason:'storage-unavailable'};
    try{if(entries.length)this.storage.setItem(this.key,JSON.stringify({version:1,entries}));else this.storage.removeItem(this.key);return{saved:true}}
    catch{return{saved:false,reason:'storage-unavailable'}}
  }
}
