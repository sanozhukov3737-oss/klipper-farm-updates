/* Ответ Moonraker — это JSON, форма которого уточняется при чтении: разные
   прошивки и версии отдают разные ключи. Здесь зафиксирована граница: внутри
   приложения значения сужаются проверками (moonrakerRecord/moonrakerStatus), а
   не предполагаются. any стоит ровно в одном месте — в этом алиасе. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonRecord=Record<string,any>;

const record=(value:unknown):JsonRecord|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  ?value as JsonRecord
  :undefined;

/**
 * Vendor Moonraker builds occasionally retain one or two transport wrappers
 * (`result`, `data`, or `response`).  Keep traversal iterative and bounded so
 * malformed/cyclic payloads cannot recurse through the UI.
 */
/* Все уровни ответа, а не только самый глубокий: moonrakerRecord разворачивает
   вложенность и возвращает лист, а такие поля, как error, могут лежать выше. */
export const payloadRecords=(value:unknown)=>{
  const rows:JsonRecord[]=[];
  const queue:unknown[]=[value];
  const seen=new Set<object>();
  while(queue.length&&rows.length<12){
    const current=queue.shift(),item=record(current);
    if(!item||seen.has(item))continue;
    seen.add(item);rows.push(item);
    for(const key of ['result','data','response']){
      const child=item[key];
      if(record(child))queue.push(child);
    }
  }
  return rows;
};

export function moonrakerRecord(value:unknown):JsonRecord{
  const rows=payloadRecords(value);
  return rows.at(-1)??rows[0]??{};
}

export function moonrakerObjectNames(value:unknown):string[]{
  if(Array.isArray(value))return value.filter((item):item is string=>typeof item==='string').slice(0,4096);
  for(const item of payloadRecords(value)){
    if(Array.isArray(item.objects))return item.objects.filter((name:unknown):name is string=>typeof name==='string').slice(0,4096);
  }
  return [];
}

export function moonrakerStatus(value:unknown):JsonRecord{
  const rows=payloadRecords(value);
  for(const item of rows){
    const status=record(item.status);
    if(status)return status;
  }
  const known=new Set(['print_stats','virtual_sdcard','extruder','heater_bed','webhooks','toolhead','gcode_move','fan','display_status','configfile']);
  return rows.find(item=>Object.keys(item).some(key=>known.has(key)||/^(output_pin|led|neopixel|dotstar|pwm_cycle_time) /.test(key)))??{};
}

