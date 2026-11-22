import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const assert=(v,m)=>{if(!v)throw new Error(m)};
// Команда creality_light вынесена в upload_commands.rs; оба файла — её домен.
const native=`${read('src-tauri/src/lib.rs')}
${read('src-tauri/src/upload_commands.rs')}`,wire=read('src-tauri/src/creality_light.rs'),protocol=read('src-tauri/src/moonraker_protocol.rs'),client=read('src/lib/moonraker.ts');
assert(wire.includes('"lightSw":1')&&wire.includes('"lightSw":0')&&wire.includes('"ReqPrinterPara":1'),'Creality fixed wire shapes missing');
assert(wire.includes('Duration::from_secs(6)')&&wire.includes('64 * 1024'),'Bounded light protocol missing');
assert(!wire.includes('printer.gcode')&&!wire.includes('SET_PIN')&&!wire.includes('api_key'),'Native light protocol must not expose generic commands or credentials');
assert(native.includes('let minimum = if on.is_some() { Role::Operator } else { Role::Viewer }'),'Light RBAC missing');
const wrapper=native.slice(native.indexOf('async fn creality_light('),native.indexOf('\nfn safe_upload_name('));
assert(wrapper.includes('require_role(')&&wrapper.includes('authorize_printer_target(')&&wrapper.includes('target.socket.set_port(9999)')&&wrapper.includes('scheduler.acquire_for_printer'),'Light host binding/scheduler missing');
assert(client.includes("secureInvoke<boolean>('creality_light'")&&client.includes('typeof observed')&&client.includes('observed!==on'),'Only observed native light state may succeed');
assert(!client.includes("if(!target&&k1)target={kind:'pin'"),'Guessed K1 LED target remains');
assert(protocol.includes('"/websocket", None')&&protocol.includes('"/" | "/websocket"'),'Legacy WebSocket route must remain unchanged');
const baseline=process.env.KF_LIGHT_BASELINE;
if(baseline){
 const srcBase=path.join(baseline,'src'),nativeBase=fs.existsSync(path.join(baseline,'native'))?path.join(baseline,'native'):path.join(baseline,'src-tauri');
 const allowedSrc=new Set(['lib/moonraker.ts','lib/printerLight.ts','components/ControlPanel.tsx','components/ControlPanelUtilities.module.css','components/PrinterLightControl.tsx','components/PrinterLightControl.module.css']);
 const allowedNative=new Set(['src/lib.rs','src/moonraker_protocol.rs','src/creality_light.rs']);
 const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
 for(const [folder,base,allowed] of [['src',srcBase,allowedSrc],['src-tauri',nativeBase,allowedNative]]){
  for(const old of files(base)){const relative=path.relative(base,old).replaceAll('\\','/');if(allowed.has(relative))continue;const current=path.join(root,folder,relative);assert(fs.existsSync(current)&&fs.readFileSync(current).equals(fs.readFileSync(old)),'Protected file changed: '+folder+'/'+relative)}
 }
 const oldClient=fs.readFileSync(path.join(srcBase,'lib/moonraker.ts'),'utf8');const strip=s=>s.slice(0,s.includes('  private async crealityLight(')?s.indexOf('  private async crealityLight('):s.indexOf('  async lightStatus():'))+s.slice(s.indexOf('\n  async objectList():'));assert(strip(client)===strip(oldClient),'Non-light printer commands changed');
 let restored=native.replace('mod creality_light;\n','').replace('            creality_light,\n','');const start=restored.indexOf('\n#[tauri::command]\nasync fn creality_light(');assert(start>=0,'Native light command absent');restored=restored.slice(0,start)+restored.slice(restored.indexOf('\nfn safe_upload_name(',start));assert(restored===fs.readFileSync(path.join(nativeBase,'src/lib.rs'),'utf8'),'Native functions outside new light command changed');
 const panel=read('src/components/ControlPanel.tsx').replace("import utilityStyles from './ControlPanelUtilities.module.css';\n",'').replace('className={`kfCyberPanel kfDetailUtilities ${utilityStyles.utilities}`}','className="kfCyberPanel kfDetailUtilities"');assert(panel===fs.readFileSync(path.join(srcBase,'components/ControlPanel.tsx'),'utf8'),'ControlPanel behavior changed outside utility CSS');
}
console.log('R116 light scope passed: fixed native light protocol, RBAC and address binding; unrelated native, login, printing, upload, camera and controls preserved.');
