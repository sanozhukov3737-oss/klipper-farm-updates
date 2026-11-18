import type { JsonRecord } from './moonrakerPayload';
export type PrinterLightTarget = {kind:'creality'}|{object:string;name:string;kind:'pin'|'led';scale:number}|{kind:'macro';onCommand:string;offCommand:string};
export type PrinterLightState = {supported:boolean;on?:boolean;detail?:string;target?:string};

// Only explicitly named chamber lights qualify. Never probe arbitrary output
// pins (fans, heaters and other actuators can also be output_pin objects).
const lightNames=['case_light','LED','led','chamber_light','chamber_led','light','lights','caselight','light_pin','LED_pin','led_pin','lighting','chamberlight','chamberlight_pin'];
export function discoverPrinterLight(objects:string[]):PrinterLightTarget|undefined{
  for(const name of lightNames)for(const prefix of ['output_pin','led','neopixel','dotstar','pwm_cycle_time']){
    const object=objects.find(item=>item.toLowerCase()===`${prefix} ${name}`.toLowerCase());
    if(object)return {object,name:object.slice(prefix.length+1),kind:prefix==='output_pin'||prefix==='pwm_cycle_time'?'pin':'led',scale:1};
  }
  for(const base of ['LIGHT','LIGHTS','LED','CASE_LIGHT','CHAMBER_LIGHT']){
    const onCommand=`${base}_ON`,offCommand=`${base}_OFF`;
    if(objects.includes(`gcode_macro ${onCommand}`)&&objects.includes(`gcode_macro ${offCommand}`))return {kind:'macro',onCommand,offCommand};
  }
}
export function printerLightCommand(target:PrinterLightTarget,on:boolean){
  if(target.kind==='creality')throw new Error('Подсветка Creality управляется штатным LAN-каналом, не G-code');
  if(target.kind==='macro')return on?target.onCommand:target.offCommand;
  if(!/^[A-Za-z0-9_]+$/.test(target.name))throw new Error('Недопустимое имя подсветки');
  if(target.kind==='pin')return `SET_PIN PIN=${target.name} VALUE=${on?target.scale:0}`;
  const value=on?1:0;
  return `SET_LED LED=${target.name} RED=${value} GREEN=${value} BLUE=${value} WHITE=${value} SYNC=0`;
}
export function printerLightState(target:PrinterLightTarget,status:JsonRecord):PrinterLightState{
  if(target.kind==='creality')return {supported:false};
  if(target.kind==='macro')return {supported:true};
  const row=status[target.object];
  if(target.kind==='pin'){
    const scale=Number(status.configfile?.settings?.[target.object]?.scale??status.configfile?.config?.[target.object]?.scale??target.scale);
    if(Number.isFinite(scale)&&scale>0&&scale<=1_000_000)target.scale=scale;
    const raw=row?.value;
    const value=typeof raw==='boolean'?Number(raw):typeof raw==='number'?raw:typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw.trim())?Number(raw):NaN;
    return {supported:true,...(Number.isFinite(value)?{on:value>0}: {})};
  }
  const colors=row?.color_data;
  if(!Array.isArray(colors)||!colors.length||!colors.every(row=>Array.isArray(row)&&row.length>=3&&row.every(v=>typeof v==='number'&&Number.isFinite(v))))return {supported:true};
  return {supported:true,on:colors.some(row=>row.some((v:number)=>v>0))};
}
