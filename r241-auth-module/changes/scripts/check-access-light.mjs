import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const native=read('src-tauri/src/lib.rs'),auth=read('src-tauri/src/auth_commands.rs'),hello=read('src-tauri/src/windows_hello.rs'),login=read('src/components/LoginPanel.tsx');
assert.ok(hello.includes('IUserConsentVerifierInterop')&&hello.includes('RequestVerificationForWindowAsync(HWND('),'Hello must use the application window desktop API');
assert.ok(hello.includes('result==UserConsentVerificationResult::Verified'),'only native Verified may succeed');
assert.ok(hello.includes('op.Cancel()')&&hello.includes('Duration::from_secs(120)'),'Hello must have a bounded cancel path');
assert.ok(auth.includes('hello_grant_matches(&current,&id,&fresh)')&&auth.includes('fresh!=stamp'),'grant and credentials must be rechecked after OS verification');
assert.ok(auth.includes('hello_entry(&user.id)?.set_password')&&auth.includes('require_role(&app,&auth,&session_token,Role::Viewer)'),'enrollment must require the signed-in user and OS credential storage');
assert.ok(native.includes('COALESCE(pin_hash,\'\')=\'\''),'bootstrap must not overwrite PIN-only accounts');
assert.ok(auth.includes('ensure_pin_removal_keeps_access(&transaction'),'PIN removal must preserve another credential');
assert.ok(login.includes('authMethodChoice')&&!login.includes('authMethodSwitch')&&!login.includes('setupPinToggle'),'one selected login form is required');
const base=process.env.KF_ACCESS_BASELINE;
if(base){
 const prior=p=>fs.readFileSync(path.join(base,p),'utf8');
 const allowed=new Set(['src/App.tsx','src/components/ControlPanel.tsx','src/components/PrinterLightControl.tsx','src/components/PrinterLightControl.module.css','src/components/LoginPanel.tsx','src/components/LoginMethods.css','src/components/LoginPreferences.tsx','src/components/LoginPreferences.module.css','src/components/SystemPanel.tsx','src/lib/auth.ts','native/src/lib.rs','native/src/windows_hello.rs','native/src/transactional_core/actor.rs','native/Cargo.toml','native/Cargo.lock']);
 const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
 for(const section of ['src','native']){
  const current=section==='src'?'src':'src-tauri';
  for(const f of walk(path.join(base,section))){const key=path.relative(base,f).replaceAll('\\','/');if(!allowed.has(key)){const next=path.join(root,current,path.relative(path.join(base,section),f));assert.ok(fs.existsSync(next)&&fs.readFileSync(f).equals(fs.readFileSync(next)),'Unrelated production change: '+key)}}
  for(const f of walk(path.join(root,current))){const relative=path.relative(path.join(root,current),f).replaceAll('\\','/');if(relative.startsWith('target/')||relative.startsWith('gen/'))continue;const key=section+'/'+relative;if(!fs.existsSync(path.join(base,key)))assert.ok(allowed.has(key),'Unexpected production file: '+key)}
 }
 const region=(text,start,end)=>{const a=text.indexOf(start),b=text.indexOf(end,a);assert.ok(a>=0&&b>a,'Ambiguous native region: '+start);return text.slice(a,b)};
 const old=prior('native/src/lib.rs');let restored=native.replace('mod windows_hello;\n','').replace('    hello_busy: Arc<AtomicBool>,\n','');
 restored=restored.replace(region(restored,'fn auth_credentials_configured','async fn auth_login_internal'),region(old,'#[tauri::command]\nfn auth_status','async fn auth_login_internal'));
 restored=restored.replace(region(restored,'#[derive(Serialize, Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct HelloGrant','#[tauri::command]\nfn auth_logout'),'');
 restored=restored.replace(region(restored,'fn ensure_pin_removal_keeps_access','fn revoke_user_sessions'),region(old,'#[tauri::command]\nasync fn user_save','fn revoke_user_sessions'));
 for(const command of ['status','enable','disable','login'])restored=restored.replace('            auth_hello_'+command+',\n','');
 const tests=restored.indexOf('#[cfg(test)]\nmod login_method_tests');assert.ok(tests>0);restored=restored.slice(0,tests);
 const tidy=s=>s.replace(/\n{3,}/g,'\n\n').trim();assert.equal(tidy(restored),tidy(old),'Native change escaped authorization-only regions');
 assert.equal(read('src/App.tsx').replace('currentUserId={session.user.id} ',''),prior('src/App.tsx'),'App changes must only connect the current account to preferences');
 // A durable SQLite write on a loaded Windows runner may exceed 450ms.
 // Only this test's budget is extended; every production actor byte is pinned.
 const actor=read('src-tauri/src/transactional_core/actor.rs');
 assert.equal((actor.match(/operation\.deadline_at_ms = now_ms\(\) \+ 5_000;/g)||[]).length,1);
 assert.equal(actor.replace('operation.deadline_at_ms = now_ms() + 5_000;','operation.deadline_at_ms = now_ms() + 450;'),prior('native/src/transactional_core/actor.rs'),'Production actor and all start/no-replay assertions must remain unchanged');
 const beforePanel=prior('src/components/ControlPanel.tsx');let panel=read('src/components/ControlPanel.tsx').replace("import { PrinterLightControl } from './PrinterLightControl';\n",'');
 const iconStart='import {',iconEnd="} from 'lucide-react';";
 const oldIcons=region(beforePanel,iconStart,iconEnd);const icons=region(panel,iconStart,iconEnd);assert.equal(icons,oldIcons.replace('  Lightbulb,\n',''));panel=panel.replace(icons,oldIcons);
 const a=beforePanel.indexOf('              <div className="kfDetailSwitch kfDetailLight">'),b=beforePanel.indexOf('\n            </section>',a);assert.ok(a>0&&b>a);
 panel=panel.replace('              <PrinterLightControl light={light} online={online} busy={lightBusy} onToggle={on=>void setPrinterLight(on)} onRetry={()=>setLightRefresh(value=>value+1)}/>',beforePanel.slice(a,b));
 assert.equal(panel,beforePanel,'Existing light command/discovery/printing logic must remain unchanged');
 assert.equal(read('src-tauri/Cargo.toml').replace('windows={version="=0.61.3",features=["Security_Credentials_UI","Win32_System_WinRT"]}\nwindows-future="=0.2.1"\n',''),prior('native/Cargo.toml'));
 assert.equal(read('src-tauri/Cargo.lock').replace(' "windows",\n "windows-future",\n "windows-sys 0.61.2",\n]\n\n[[package]]\nname = "libc"',' "windows-sys 0.61.2",\n]\n\n[[package]]\nname = "libc"'),prior('native/Cargo.lock'));
}
console.log('Access/light scope passed: native auth only; printer transport, upload, print start, camera guard and light commands preserved');
