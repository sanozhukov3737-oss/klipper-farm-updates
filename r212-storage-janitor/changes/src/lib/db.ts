import { secureInvoke } from './auth';

export type AuditEntry={id:number;ts:number;user:string;action:string;details:string};
export type AppUser={id:string;name:string;role:'admin'|'operator'|'viewer';enabled:boolean;createdAt:number;pinEnabled:boolean};

export async function dbGet<T>(key:string,fallback:T):Promise<T>{
  try{return await dbGetStrict(key,fallback)}catch{return fallback}
}
// A failed read is not a missing key. Migrations must never replace stored
// data with defaults after a transient SQLite/authentication or JSON error.
export async function dbGetStrict<T>(key:string,fallback:T):Promise<T>{
  const raw=await secureInvoke<string|null>('db_get_json',{key});
  return raw===null?fallback:JSON.parse(raw) as T;
}
export async function dbSet<T>(key:string,value:T){await secureInvoke('db_set_json',{key,value:JSON.stringify(value)})}
// Перечисление ключей только по префиксу и удаление ключа: без них следы
// удалённых принтеров из хранилища не убрать. Оба проверяются правами на стороне Rust.
export async function dbListKeys(prefix:string){return await secureInvoke<string[]>('db_list_keys',{prefix})}
export async function dbDelete(key:string){await secureInvoke('db_delete_json',{key})}
export async function migrateLocal<T>(key:string,legacyKeys:string[],fallback:T):Promise<T>{
  const fromDb=await dbGetStrict<T|null>(key,null);
  if(fromDb!==null)return fromDb;
  for(const old of legacyKeys){
    let value:T;
    try{const raw=localStorage.getItem(old);if(raw===null)continue;value=JSON.parse(raw) as T}catch{continue}
    await dbSet(key,value);return value;
  }
  await dbSet(key,fallback);return fallback;
}
export async function audit(action:string,details=''){try{await secureInvoke('audit_add',{action,details});window.dispatchEvent(new Event('klipper-notifications-updated'))}catch{}}
export async function auditList(limit=250){try{return await secureInvoke<AuditEntry[]>('audit_list',{limit})}catch{return []}}
export async function notificationList(limit=100){return await secureInvoke<AuditEntry[]>('notification_list',{limit})}
export async function usersList(){try{return await secureInvoke<AppUser[]>('users_list')}catch{return []}}
export async function userSave(user:AppUser,password?:string,pin?:string,clearPin=false){await secureInvoke('user_save',{user:{...user,password:password||null,pin:pin||null,clearPin}})}
export async function userDelete(id:string){await secureInvoke('user_delete',{id})}
export async function backupJson(){return await secureInvoke<string>('db_backup_json')}
export async function restoreJson(raw:string){return await secureInvoke('db_restore_json',{raw})}
