import { invoke } from '@tauri-apps/api/core';

export type UserRole='admin'|'operator'|'viewer';
export type AuthUser={id:string;name:string;role:UserRole;enabled:boolean;createdAt:number};
export type AuthSession={token:string;user:AuthUser};
export type AuthStatus={needsSetup:boolean};

let sessionToken='';

export function setAuthSession(session?:AuthSession){
  sessionToken=session?.token??'';
  // Последний пользователь — подсказка для экрана входа, а не данные:
  // в приватном режиме localStorage недоступен, и вход должен работать.
  if(session)try{localStorage.setItem('klipper-auth-user',session.user.id)}catch{/* подсказка не сохранилась */}
}

export function currentSessionToken(){return sessionToken}

export async function secureInvoke<T>(command:string,args:Record<string,unknown>={}):Promise<T>{
  if(!sessionToken)throw new Error('AUTH_REQUIRED: требуется вход');
  try{
    return await invoke<T>(command,{...args,sessionToken});
  }catch(error){
    const message=String(error instanceof Error?error.message:error);
    // Only a structured local authorization error may reset the application.
    // A Moonraker response merely containing these words must stay an inline RPC error.
    if(/^AUTH_REQUIRED(?:\s|:|$)/.test(message))window.dispatchEvent(new CustomEvent('klipper-auth-required'));
    throw error;
  }
}

export const getAuthStatus=()=>invoke<AuthStatus>('auth_status');
export const bootstrapAuth=(password:string,pin?:string)=>invoke<AuthSession>('auth_bootstrap',{password,pin:pin||null});
export const login=(userId:string,password:string)=>invoke<AuthSession>('auth_login',{userId,password});
export const loginWithPin=(userId:string,pin:string)=>invoke<AuthSession>('auth_pin_login',{userId,pin});
export const changePassword=(currentPassword:string,newPassword:string)=>secureInvoke<void>('auth_change_password',{currentPassword,newPassword});
export async function logout(){
  const token=sessionToken;
  sessionToken='';
  if(token)await invoke('auth_logout',{sessionToken:token}).catch(()=>{});
}

export type LoginMethod='password'|'pin'|'hello';
export type HelloStatus={available:boolean;enrolled:boolean;detail:string};
export function preferredLoginMethod():LoginMethod{try{const value=localStorage.getItem('klipper-auth-mode');return value==='pin'||value==='hello'?value:'password'}catch{return 'password'}}
export function preferredLoginUser(){try{return localStorage.getItem('klipper-auth-user')||'admin'}catch{return 'admin'}}
export function saveLoginMethod(method:LoginMethod){try{localStorage.setItem('klipper-auth-mode',method);window.dispatchEvent(new Event('klipper-auth-method-changed'))}catch{/* выбранный способ входа — подсказка, не данные */}}
export const helloStatus=(userId:string)=>invoke<HelloStatus>('auth_hello_status',{userId});
export const loginWithHello=(userId:string)=>invoke<AuthSession>('auth_hello_login',{userId});
export const enableHello=()=>secureInvoke<void>('auth_hello_enable');
export const disableHello=()=>secureInvoke<void>('auth_hello_disable');
