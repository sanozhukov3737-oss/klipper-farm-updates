import type { PrinterConfig } from '../types';
import { dbGetStrict, dbSet } from './db';

const CONFIG_KEY='printers.config';
const CACHE_KEY='printers';
const PENDING_KEY='klipper-printers-pending-v1';
type ConfigStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type PendingConfig={version:1;id:string;configs:PrinterConfig[]};
type StoreDependencies={
  storage?:ConfigStorage;
  read?:()=>Promise<PrinterConfig[]|null>;
  write?:(configs:PrinterConfig[])=>Promise<void>;
};
export type PrinterConfigLoad={configs:PrinterConfig[];needsSave:boolean;pending:boolean};

const parseConfigs=(value:unknown):PrinterConfig[]=>{
  if(!Array.isArray(value)||value.some(item=>!item||typeof item!=='object'||typeof item.id!=='string'||typeof item.name!=='string'||typeof item.host!=='string'))throw new Error('Сохранённые настройки принтеров повреждены. Исходные данные не изменены.');
  return value as PrinterConfig[];
};
export const persistablePrinterConfigs=(configs:PrinterConfig[]):PrinterConfig[]=>parseConfigs(configs).map(value=>{
  const {apiKey,status,webcams,...config}=value as PrinterConfig&{status?:unknown;webcams?:unknown};
  return config;
});

/** Keep the last requested configuration recoverable until SQLite confirms it.
 * The journal contains configuration only; credentials and live telemetry never
 * enter it. Writes are ordered, including retries after a failed write.
 */
export function createPrinterConfigStore(dependencies:StoreDependencies={}){
  const storage=dependencies.storage??localStorage;
  const read=dependencies.read??(()=>dbGetStrict<PrinterConfig[]|null>(CONFIG_KEY,null));
  const write=dependencies.write??(configs=>dbSet(CONFIG_KEY,configs));
  let tail:Promise<unknown>=Promise.resolve();
  const exclusive=<T,>(run:()=>Promise<T>)=>{
    const operation=tail.catch(()=>{}).then(run);
    tail=operation;
    return operation;
  };
  const pending=():PendingConfig|undefined=>{
    const raw=storage.getItem(PENDING_KEY);
    if(raw===null)return;
    const value=JSON.parse(raw) as PendingConfig;
    if(value?.version!==1||typeof value.id!=='string')throw new Error('Не удалось прочитать незавершённое сохранение принтеров. Исходные данные не изменены.');
    return {...value,configs:persistablePrinterConfigs(value.configs)};
  };
  const cached=():PrinterConfig[]=>{
    // A damaged journal is reported by load(), but must not hide an intact
    // last confirmed cache while that error is shown to the user.
    try{const staged=pending();if(staged)return staged.configs}catch{/* повреждённый журнал уже показан в load(); кеш ниже всё равно нужен */}
    try{
      const raw=storage.getItem(CACHE_KEY);
      return raw===null?[]:persistablePrinterConfigs(parseConfigs(JSON.parse(raw)));
    }catch{return []}
  };
  const finishCache=(staged:PendingConfig)=>{
    // A completed older write must not remove a later request's journal.
    if(pending()?.id!==staged.id)return;
    storage.setItem(CACHE_KEY,JSON.stringify(staged.configs));
    storage.removeItem(PENDING_KEY);
  };
  return{
    cached,
    load({canWrite=true}:{canWrite?:boolean}={}):Promise<PrinterConfigLoad>{
      // Capture before the asynchronous read. A new save queued during this
      // read must keep its own journal and is committed after this operation.
      let staged:PendingConfig|undefined,legacy:PrinterConfig[]|undefined;
      try{
        staged=pending();
        const raw=storage.getItem(CACHE_KEY);
        if(raw!==null)try{legacy=parseConfigs(JSON.parse(raw))}catch{/* устаревший кеш не разобрался: читаем из базы */}
      }catch(error){return Promise.reject(error)}
      return exclusive(async()=>{
        const stored=await read();
        if(stored!==null)parseConfigs(stored);
        if(staged){
          if(canWrite){await write(staged.configs);finishCache(staged)}
          return{configs:staged.configs,needsSave:false,pending:!canWrite};
        }
        if(stored!==null){
          if(!pending())storage.setItem(CACHE_KEY,JSON.stringify(persistablePrinterConfigs(stored)));
          return{configs:stored,needsSave:false,pending:false};
        }
        // Legacy credentials are migrated by App before its awaited save.
        // Never write them to the database or the pending journal here.
        return{configs:legacy??[],needsSave:!!legacy,pending:false};
      });
    },
    save(configs:PrinterConfig[]):Promise<void>{
      let staged:PendingConfig;
      try{
        staged={version:1,id:crypto.randomUUID(),configs:persistablePrinterConfigs(configs)};
        storage.setItem(PENDING_KEY,JSON.stringify(staged));
      }catch(error){return Promise.reject(error)}
      return exclusive(async()=>{await write(staged.configs);finishCache(staged)});
    },
  };
}
