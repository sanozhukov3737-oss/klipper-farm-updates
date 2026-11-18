import type { JsonRecord } from './moonrakerPayload';
import type {
  KnownPrinterPreset,
  PrinterDetectionCandidate,
  PrinterDetectionConflict,
  PrinterDetectionEvidence,
  PrinterDetectionEvidenceGroup,
  PrinterDetectionFacts,
  PrinterDetectionResult,
  PrinterPreset
} from '../types';

export const PRINTER_DETECTION_ENGINE_VERSION = 6;
export const FLASHFORGE_5M_DISPLAY_NAME = 'FlashForge 5M';

const MAX_FACT_TEXT = 160;
const MAX_FACT_ITEMS = 512;
const PRESET_ORDER:KnownPrinterPreset[] = [
  'ender3-v3-ke',
  'ender3-v3-se',
  'creality-k1c-2025',
  'creality-k1-max',
  'flashforge-ad5m'
];

interface NormalizedFacts {
  identity:{manufacturer:string;model:string;product:string;board:string;hostname:string;machineId:string;uuid:string;serial:string;mcuSerial:string;macAddress:string};
  firmware:{distribution:string;family:string;version:string};
  kinematics:'cartesian'|'corexy'|'delta'|'unknown';
  configSections:string[];
  objectNames:string[];
  macroNames:string[];
  geometry:{xMin?:number;xMax?:number;yMin?:number;yMax?:number;zMax?:number;bedX?:number;bedY?:number;enclosed?:boolean};
}

const normalizeText=(value:unknown)=>typeof value==='string'
  ?value.normalize('NFKC').slice(0,MAX_FACT_TEXT).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
  :'';
const normalizeIdentityToken=(value:unknown)=>typeof value==='string'
  ?value.normalize('NFKC').slice(0,MAX_FACT_TEXT).toLowerCase().replace(/[^a-z0-9:._/-]+/g,' ').replace(/\s+/g,' ').trim()
  :'';

const normalizeList=(value:unknown)=>{
  if(!Array.isArray(value))return [];
  return [...new Set(value.slice(0,MAX_FACT_ITEMS).map(normalizeText).filter(Boolean))].sort();
};

const finiteDimension=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1_000
  ?Math.round(value*100)/100
  :undefined;
const finiteCoordinate=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1_000
  ?Math.round(value*100)/100
  :undefined;

const normalizeFacts=(facts:PrinterDetectionFacts):NormalizedFacts=>{
  const rawKinematics=facts?.kinematics;
  const kinematics=rawKinematics==='cartesian'||rawKinematics==='corexy'||rawKinematics==='delta'
    ?rawKinematics
    :'unknown';
  return {
    identity:{
      manufacturer:normalizeText(facts?.identity?.manufacturer),
      model:normalizeText(facts?.identity?.model),
      product:normalizeText(facts?.identity?.product),
      board:normalizeText(facts?.identity?.board),
      // Hostname is retained for display/snapshot use but never participates in scoring.
      hostname:normalizeText(facts?.identity?.hostname),
      machineId:normalizeIdentityToken(facts?.identity?.machineId),
      uuid:normalizeIdentityToken(facts?.identity?.uuid),
      serial:normalizeIdentityToken(facts?.identity?.serial),
      mcuSerial:normalizeIdentityToken(facts?.identity?.mcuSerial),
      macAddress:normalizeIdentityToken(facts?.identity?.macAddress),
    },
    firmware:{
      distribution:normalizeText(facts?.firmware?.distribution),
      family:normalizeText(facts?.firmware?.family),
      version:normalizeText(facts?.firmware?.version)
    },
    kinematics,
    configSections:normalizeList(facts?.configSections),
    objectNames:normalizeList(facts?.objectNames),
    macroNames:normalizeList(facts?.macroNames),
    geometry:{
      xMin:finiteCoordinate(facts?.geometry?.xMin),
      xMax:finiteDimension(facts?.geometry?.xMax),
      yMin:finiteCoordinate(facts?.geometry?.yMin),
      yMax:finiteDimension(facts?.geometry?.yMax),
      zMax:finiteDimension(facts?.geometry?.zMax),
      bedX:finiteDimension(facts?.geometry?.bedX),
      bedY:finiteDimension(facts?.geometry?.bedY),
      enclosed:typeof facts?.geometry?.enclosed==='boolean'?facts.geometry.enclosed:undefined
    }
  };
};

export function normalizePrinterDetectionFacts(facts:PrinterDetectionFacts):PrinterDetectionFacts{
  const value=normalizeFacts(facts);
  return {
    identity:{...value.identity},
    firmware:{...value.firmware},
    kinematics:value.kinematics,
    configSections:value.configSections,
    objectNames:value.objectNames,
    macroNames:value.macroNames,
    geometry:{...value.geometry}
  };
}

/**
 * V5 never fills missing classifier evidence from an old configuration probe.
 * Only immutable identity fields may be retained, and only when a fresh
 * hardware/network anchor proves that the response came from the same device.
 * This prevents a firmware change or partial query from reviving stale macros,
 * geometry, kinematics or config sections.
 */
export function mergePrinterDetectionFacts(current:PrinterDetectionFacts,previous?:PrinterDetectionFacts):PrinterDetectionFacts{
  if(!previous)return normalizePrinterDetectionFacts(current);
  const now=normalizePrinterDetectionFacts(current),old=normalizePrinterDetectionFacts(previous);
  const anchors=(facts:PrinterDetectionFacts)=>[
    facts.identity?.machineId,facts.identity?.uuid,facts.identity?.serial,facts.identity?.mcuSerial,facts.identity?.macAddress,
  ].filter((value):value is string=>!!value);
  const freshAnchors=anchors(now),oldAnchors=new Set(anchors(old));
  const sameDevice=freshAnchors.length>0&&freshAnchors.some(value=>oldAnchors.has(value));
  const value=<T,>(fresh:T|undefined,fallback:T|undefined)=>sameDevice&&(fresh===undefined||fresh==='')?fallback:fresh;
  return normalizePrinterDetectionFacts({
    identity:{
      manufacturer:value(now.identity?.manufacturer,old.identity?.manufacturer),
      model:value(now.identity?.model,old.identity?.model),
      product:value(now.identity?.product,old.identity?.product),
      board:value(now.identity?.board,old.identity?.board),
      hostname:value(now.identity?.hostname,old.identity?.hostname),
      machineId:value(now.identity?.machineId,old.identity?.machineId),
      uuid:value(now.identity?.uuid,old.identity?.uuid),
      serial:value(now.identity?.serial,old.identity?.serial),
      mcuSerial:value(now.identity?.mcuSerial,old.identity?.mcuSerial),
      macAddress:value(now.identity?.macAddress,old.identity?.macAddress),
    },
    firmware:{...now.firmware},
    kinematics:now.kinematics,
    configSections:now.configSections,
    objectNames:now.objectNames,
    macroNames:now.macroNames,
    geometry:{...now.geometry},
  });
}

export interface MoonrakerDetectionSnapshot {
  server?:unknown;
  printer?:unknown;
  machine?:unknown;
  listed?:unknown;
  configStatus?:unknown;
  toolheadStatus?:unknown;
}

const rawText=(...values:unknown[])=>{
  for(const value of values){
    if(typeof value==='string'&&value.trim())return value.trim().slice(0,MAX_FACT_TEXT);
    if(typeof value==='number'&&Number.isFinite(value))return String(value).slice(0,MAX_FACT_TEXT);
  }
  return undefined;
};
const rawNames=(value:unknown,limit=MAX_FACT_ITEMS)=>Array.isArray(value)
  ?value.filter((item):item is string=>typeof item==='string').map(item=>item.trim().slice(0,96)).filter(Boolean).slice(0,limit)
  :[];
const rawNumber=(value:unknown)=>{
  const parsed=typeof value==='number'?value:typeof value==='string'?Number.parseFloat(value):Number.NaN;
  return Number.isFinite(parsed)?parsed:undefined;
};
const rawObject=(value:unknown):JsonRecord=>value&&typeof value==='object'?value as JsonRecord:{};
const rawSections=(value:unknown)=>Object.fromEntries(Object.entries(rawObject(value)).slice(0,MAX_FACT_ITEMS).map(([key,section])=>[key.toLowerCase().slice(0,96),section]));
const rawSectionValue=(section:unknown,key:string)=>rawObject(section)[key];
const rawAxisValue=(value:unknown,axis:'x'|'y'|'z')=>{
  const vector=rawObject(value);
  const objectValue=rawNumber(vector[axis]);
  if(objectValue!==undefined)return objectValue;
  if(Array.isArray(value))return rawNumber(value[axis==='x'?0:axis==='y'?1:2]);
  return undefined;
};
const rawMacAddress=(value:unknown)=>{
  const candidates:string[]=[];
  const visit=(item:unknown,depth=0)=>{
    if(depth>3||!item)return;
    if(typeof item==='string'){candidates.push(item);return}
    if(Array.isArray(item)){item.slice(0,32).forEach(child=>visit(child,depth+1));return}
    if(typeof item==='object')Object.entries(item as Record<string,unknown>).slice(0,64).forEach(([name,child])=>{
      if(/mac(?:_address)?|hwaddr/i.test(name))visit(child,depth+1);
      else if(depth<2&&typeof child==='object')visit(child,depth+1);
    });
  };
  visit(value);
  return candidates.map(item=>item.trim().toLowerCase()).find(item=>/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(item)&&item!=='00:00:00:00:00:00');
};

/**
 * Reduces real Moonraker responses to the only bounded, structured fields the
 * classifier is allowed to see. Raw config text, comments, filenames and the
 * user's saved printer name never enter this boundary.
 */
export function printerDetectionFactsFromMoonraker(snapshot:MoonrakerDetectionSnapshot):PrinterDetectionFacts{
  const server=rawObject(snapshot.server),printer=rawObject(snapshot.printer),machine=rawObject(snapshot.machine);
  const system=rawObject(machine.system_info??machine),distribution=rawObject(system.distribution);
  const listed=rawObject(snapshot.listed),configStatus=rawObject(snapshot.configStatus);
  const status=rawObject(configStatus.status),configRoot=rawObject(status.configfile??configStatus.configfile??configStatus);
  const toolheadStatus=rawObject(snapshot.toolheadStatus),toolheadRoot=rawObject(rawObject(toolheadStatus.status).toolhead??toolheadStatus.toolhead??toolheadStatus);
  const settings=rawSections(configRoot.settings);
  const objects=rawNames(listed.objects),sectionNames=rawNames(Object.keys(settings));
  const macroNames=objects.filter(name=>name.toLowerCase().startsWith('gcode_macro ')).map(name=>name.slice(12)).slice(0,256);
  const stepperX=settings.stepper_x,stepperY=settings.stepper_y,stepperZ=settings.stepper_z;
  const mcu=settings.mcu;
  const xMax=rawNumber(rawSectionValue(stepperX,'position_max'))??rawAxisValue(toolheadRoot.axis_maximum,'x');
  const yMax=rawNumber(rawSectionValue(stepperY,'position_max'))??rawAxisValue(toolheadRoot.axis_maximum,'y');
  const zMax=rawNumber(rawSectionValue(stepperZ,'position_max'))??rawAxisValue(toolheadRoot.axis_maximum,'z');
  const explicitXMin=rawNumber(rawSectionValue(stepperX,'position_min'))??rawAxisValue(toolheadRoot.axis_minimum,'x');
  const explicitYMin=rawNumber(rawSectionValue(stepperY,'position_min'))??rawAxisValue(toolheadRoot.axis_minimum,'y');
  const xMin=explicitXMin??(xMax===undefined?undefined:0),yMin=explicitYMin??(yMax===undefined?undefined:0);
  const kinematicsValue=rawText(rawSectionValue(settings.printer,'kinematics'))?.toLowerCase();
  const kinematics:PrinterDetectionFacts['kinematics']=kinematicsValue==='corexy'||kinematicsValue==='cartesian'||kinematicsValue==='delta'?kinematicsValue:'unknown';
  return {
    identity:{
      manufacturer:rawText(system.manufacturer,machine.manufacturer,server.manufacturer,printer.manufacturer),
      model:rawText(system.model,system.model_name,machine.model,server.model,printer.model),
      product:rawText(system.product_name,system.product,machine.product_name,server.product_name,printer.product_name),
      board:rawText(system.board_name,system.machine,rawObject(system.cpu_info).model,printer.mcu_model),
      hostname:rawText(system.hostname,machine.hostname,printer.hostname),
      machineId:rawText(system.machine_id,system.machineId,machine.machine_id,printer.machine_id),
      uuid:rawText(system.product_uuid,system.uuid,machine.uuid,printer.uuid),
      serial:rawText(system.serial_number,system.board_serial,machine.serial_number,printer.serial_number),
      mcuSerial:rawText(rawSectionValue(mcu,'serial'),printer.mcu_serial),
      macAddress:rawMacAddress(system.network??machine.network),
    },
    firmware:{
      distribution:rawText(distribution.name,distribution.id,system.distribution_name),
      family:rawText(printer.klipper_path,system.os_name),
      version:rawText(printer.software_version,server.moonraker_version,distribution.version)
    },
    configSections:sectionNames,
    objectNames:objects,
    macroNames,
    kinematics,
    geometry:{
      xMin,xMax,yMin,yMax,zMax,
      bedX:xMax===undefined?undefined:Math.max(0,xMax-(xMin??0)),
      bedY:yMax===undefined?undefined:Math.max(0,yMax-(yMin??0)),
      enclosed:sectionNames.length?sectionNames.some(name=>/(?:^|\s)(?:chamber|heater chamber|temperature sensor chamber)(?:$|\s)/i.test(normalizeText(name))):undefined
    }
  };
}

const fingerprintPayload=(facts:NormalizedFacts)=>JSON.stringify({
  // Only facts used by the classifier are fingerprinted. A UI rename, hostname or
  // firmware patch update must not cause a new model decision.
  identity:{
    manufacturer:facts.identity.manufacturer,
    model:facts.identity.model,
    product:facts.identity.product,
    board:facts.identity.board
  },
  firmware:{distribution:facts.firmware.distribution,family:facts.firmware.family},
  kinematics:facts.kinematics,
  configSections:facts.configSections,
  objectNames:facts.objectNames,
  macroNames:facts.macroNames,
  geometry:facts.geometry
});

const fnv1a64=(value:string)=>{
  let hash=0xcbf29ce484222325n;
  for(const byte of new TextEncoder().encode(value)){
    hash^=BigInt(byte);
    hash=BigInt.asUintN(64,hash*0x100000001b3n);
  }
  return hash.toString(16).padStart(16,'0');
};

export function printerDetectionFingerprint(facts:PrinterDetectionFacts){
  return fnv1a64(fingerprintPayload(normalizeFacts(facts)));
}

export function printerDetectionFirmwareSignature(facts:PrinterDetectionFacts){
  const value=normalizeFacts(facts).firmware;
  return fnv1a64(JSON.stringify(value));
}

const matches=(values:string[],pattern:RegExp)=>values.some(value=>pattern.test(value));
const containsAny=(values:string[],needles:string[])=>values.some(value=>needles.some(needle=>value.includes(needle)));
const near=(value:number|undefined,target:number,tolerance=4)=>value!==undefined&&Math.abs(value-target)<=tolerance;
const axisMatches=(travel:number|undefined,maximum:number|undefined,target:number,tolerance=target>=280?18:15)=>near(travel,target,tolerance)||near(maximum,target,tolerance);

const geometryMatches=(facts:NormalizedFacts,x:number,y:number,z:number)=>{
  // Klipper exposes travel limits, not a canonical bed size. Some configs use
  // negative minima while others use a slightly oversized maximum, so either
  // the span or maximum may corroborate the nominal X/Y class.
  return axisMatches(facts.geometry.bedX,facts.geometry.xMax,x)&&axisMatches(facts.geometry.bedY,facts.geometry.yMax,y)&&near(facts.geometry.zMax,z,6);
};

const geometryKnown=(facts:NormalizedFacts)=>
  (facts.geometry.bedX??facts.geometry.xMax)!==undefined&&
  (facts.geometry.bedY??facts.geometry.yMax)!==undefined&&
  facts.geometry.zMax!==undefined;

const expectedGeometry:Record<KnownPrinterPreset,[number,number,number]>={
  'ender3-v3-ke':[220,220,240],
  'ender3-v3-se':[220,220,250],
  'creality-k1c-2025':[220,220,250],
  'creality-k1-max':[300,300,300],
  'flashforge-ad5m':[220,220,220]
};

const expectedKinematics:Record<KnownPrinterPreset,'cartesian'|'corexy'>={
  'ender3-v3-ke':'cartesian',
  'ender3-v3-se':'cartesian',
  'creality-k1c-2025':'corexy',
  'creality-k1-max':'corexy',
  'flashforge-ad5m':'corexy'
};

export function classifyPrinterModel(input:PrinterDetectionFacts):PrinterDetectionResult{
  const facts=normalizeFacts(input);
  const evidence:PrinterDetectionEvidence[]=[];
  const evidenceKeys=new Set<string>();
  const add=(model:KnownPrinterPreset,id:string,source:PrinterDetectionEvidence['source'],group:PrinterDetectionEvidenceGroup,weight:number,strength:PrinterDetectionEvidence['strength'])=>{
    const key=`${model}:${id}`;
    if(evidenceKeys.has(key))return;
    evidenceKeys.add(key);
    evidence.push({id,model,source,group,weight,strength});
  };

  const identityValues=[facts.identity.model,facts.identity.product].filter(Boolean);
  const manufacturer=facts.identity.manufacturer;
  const creality=/\bcreality\b/.test(manufacturer);
  const flashforge=/\bflashforge\b/.test(manufacturer);
  const explicit:KnownPrinterPreset[]=[];
  const unsupportedAd5mPro=matches(identityValues,/\b(?:(?:flashforge )?(?:adventurer 5m|ad5m|adventurer5m)|flashforge 5m) pro\b/)
    ||(flashforge&&matches(identityValues,/^5m pro$/));
  const exact=(model:KnownPrinterPreset,pattern:RegExp,id:string)=>{
    if(matches(identityValues,pattern)){
      explicit.push(model);
      add(model,id,'machine','identity',72,'strong');
    }
  };
  exact('ender3-v3-ke',/\b(?:creality )?ender 3 v3 ke\b|\be3v3ke\b/,'identity.exact.ender3-v3-ke');
  exact('ender3-v3-se',/\b(?:creality )?ender 3 v3 se\b|\be3v3se\b/,'identity.exact.ender3-v3-se');
  exact('creality-k1c-2025',/\b(?:creality )?k1c(?: 2025)?\b/,'identity.exact.creality-k1c');
  exact('creality-k1-max',/\b(?:creality )?k1 max\b|\bk1max\b/,'identity.exact.creality-k1-max');
  exact('flashforge-ad5m',/\b(?:(?:flashforge )?(?:adventurer 5m|ad5m|adventurer5m)|flashforge 5m)\b(?!\s+pro\b)/,'identity.exact.flashforge-ad5m');
  if(flashforge&&matches(identityValues,/^5m$/)){
    explicit.push('flashforge-ad5m');
    add('flashforge-ad5m','identity.exact.flashforge-ad5m','machine','identity',72,'strong');
  }

  if(creality){
    for(const model of PRESET_ORDER.filter(value=>value!=='flashforge-ad5m'))add(model,'manufacturer.creality','machine','platform',5,'weak');
  }
  if(flashforge)add('flashforge-ad5m','manufacturer.flashforge','machine','platform',8,'weak');

  const config=[...facts.configSections,...facts.objectNames];
  const exactConfig=(model:KnownPrinterPreset,pattern:RegExp,id:string)=>{
    // Section/object names are useful corroboration, but they are administrator
    // editable. They must never be strong enough to identify a model alone.
    if(matches(config,pattern))add(model,id,'config','identity',30,'medium');
  };
  exactConfig('ender3-v3-ke',/\bender 3 v3 ke\b|\be3v3ke\b/,'config.signature.ender3-v3-ke');
  exactConfig('ender3-v3-se',/\bender 3 v3 se\b|\be3v3se\b/,'config.signature.ender3-v3-se');
  exactConfig('creality-k1c-2025',/\bcreality k1c\b|\bk1c 2025\b/,'config.signature.creality-k1c');
  exactConfig('creality-k1-max',/\bcreality k1 max\b|\bk1max\b/,'config.signature.creality-k1-max');
  exactConfig('flashforge-ad5m',/\bflashforge (?:ad5m|5m)\b|\badventurer 5m\b/,'config.signature.flashforge-ad5m');

  if(containsAny(config,['prtouch v2','pr touch v2','cx pr touch']))add('ender3-v3-ke','levelling.prtouch-v2','config','levelling',18,'medium');
  if(containsAny(config,['z compensate','z compensation']))add('ender3-v3-ke','levelling.z-compensation','config','levelling',14,'medium');
  if(containsAny(config,['bl24c16f']))add('ender3-v3-ke','board.bl24c16f','objects','board',14,'medium');
  if(containsAny(config,['crtouch','cr touch','bltouch','bl touch'])&&!containsAny(config,['prtouch v2','pr touch v2']))add('ender3-v3-se','levelling.crtouch','config','levelling',12,'weak');

  // Both the official and community AD5M Klipper configurations expose this
  // reverse-engineered load-cell/power-pin cluster. No single generic probe or
  // fan name is sufficient; the classifier combines these independent groups.
  if(containsAny(config,['temperature sensor load cell','temperature sensor weightvalue']))add('flashforge-ad5m','levelling.ad5m-load-cell','config','levelling',16,'medium');
  if(containsAny(config,['output pin level h1'])&&containsAny(config,['output pin level h2'])&&containsAny(config,['output pin level h3']))add('flashforge-ad5m','board.ad5m-level-pins','objects','board',24,'strong');
  if(containsAny(config,['output pin power off'])&&containsAny(config,['output pin clear power off']))add('flashforge-ad5m','platform.ad5m-power-pins','objects','platform',12,'medium');
  if(containsAny(config,['fan generic fanm106','controller fan stepper driver fan']))add('flashforge-ad5m','platform.ad5m-fan-layout','objects','platform',10,'medium');

  const firmware=[facts.firmware.distribution,facts.firmware.family];
  if(containsAny(firmware,['creality os','crealityos','creality klipper'])){
    add('ender3-v3-ke','firmware.creality-os','firmware','platform',8,'weak');
    add('creality-k1c-2025','firmware.creality-os','firmware','platform',8,'weak');
    add('creality-k1-max','firmware.creality-os','firmware','platform',8,'weak');
  }
  if(containsAny(firmware,['flashforge','ff klipper']))add('flashforge-ad5m','firmware.flashforge-klipper','firmware','platform',22,'strong');

  if(containsAny(facts.macroNames,['qmode','cx pr touch','wait temp start']))add('ender3-v3-ke','macros.ke-family','config','macros',8,'weak');
  const k1StockMacroMarkers=['printer param','print prepared','print prepare clear','end print point without lifting','load material close fan2'];
  const k1StockMacroCount=k1StockMacroMarkers.filter(marker=>facts.macroNames.includes(marker)).length;
  if(k1StockMacroCount>=3){
    add('creality-k1c-2025','macros.creality-k1-stock','config','macros',26,'strong');
    add('creality-k1-max','macros.creality-k1-stock','config','macros',26,'strong');
  }else if(facts.macroNames.some(value=>value.startsWith('cx '))){
    // CX_* names may be copied by an administrator and are only a weak hint.
    add('creality-k1c-2025','macros.creality-cx-compatible','config','macros',8,'weak');
    add('creality-k1-max','macros.creality-cx-compatible','config','macros',8,'weak');
  }

  if(facts.kinematics==='cartesian'){
    add('ender3-v3-ke','kinematics.cartesian','kinematics','mechanics',16,'medium');
    add('ender3-v3-se','kinematics.cartesian','kinematics','mechanics',16,'medium');
  }else if(facts.kinematics==='corexy'){
    add('creality-k1c-2025','kinematics.corexy','kinematics','mechanics',16,'medium');
    add('creality-k1-max','kinematics.corexy','kinematics','mechanics',16,'medium');
    add('flashforge-ad5m','kinematics.corexy','kinematics','mechanics',16,'medium');
  }

  // FlashForge Adventurer 5M community Klipper configurations use a centered
  // 220 mm coordinate system (-110..110) with a 220 mm Z range. Combined with
  // CoreXY this is a stable machine signature and does not depend on filenames,
  // UI labels or administrator-editable macro names.
  const centeredFlashForgeGeometry=near(facts.geometry.xMin,-110,3)&&near(facts.geometry.xMax,110,4)
    &&near(facts.geometry.yMin,-110,3)&&near(facts.geometry.yMax,110,4)&&near(facts.geometry.zMax,220,6);
  if(centeredFlashForgeGeometry&&facts.kinematics==='corexy'){
    add('flashforge-ad5m','geometry.centered-flashforge-220','geometry','geometry',46,'strong');
  }

  for(const model of PRESET_ORDER){
    const [x,y,z]=expectedGeometry[model];
    if(geometryMatches(facts,x,y,z))add(model,`geometry.${x}x${y}x${z}`,'geometry','geometry',model==='creality-k1-max'?32:20,model==='creality-k1-max'?'strong':'medium');
  }

  const candidates:PrinterDetectionCandidate[]=PRESET_ORDER.map(model=>{
    const modelEvidence=evidence.filter(item=>item.model===model);
    const groups=[...new Set(modelEvidence.map(item=>item.group))].sort() as PrinterDetectionEvidenceGroup[];
    return {
      model,
      score:Math.min(100,modelEvidence.reduce((total,item)=>total+item.weight,0)),
      groups,
      evidenceIds:modelEvidence.map(item=>item.id).sort()
    };
  }).filter(candidate=>candidate.score>0).sort((left,right)=>right.score-left.score||PRESET_ORDER.indexOf(left.model)-PRESET_ORDER.indexOf(right.model));

  const top=candidates[0];
  const second=candidates[1];
  const score=top?.score??0;
  const margin=top?top.score-(second?.score??0):0;
  const conflicts:PrinterDetectionConflict[]=[];
  const uniqueExplicit=[...new Set(explicit)];
  if(uniqueExplicit.length>1)conflicts.push({id:'multiple-explicit-identities',models:uniqueExplicit});
  if(unsupportedAd5mPro)conflicts.push({id:'unsupported-variant',models:['flashforge-ad5m']});
  if(top&&second&&second.score>=24&&margin<15)conflicts.push({id:'insufficient-margin',models:[top.model,second.model]});
  if(top&&facts.kinematics!=='unknown'&&facts.kinematics!==expectedKinematics[top.model])conflicts.push({id:'kinematics-mismatch',models:[top.model]});
  if(top&&geometryKnown(facts)){
    const [x,y,z]=expectedGeometry[top.model];
    if(!axisMatches(facts.geometry.bedX,facts.geometry.xMax,x,20)||!axisMatches(facts.geometry.bedY,facts.geometry.yMax,y,20)||!near(facts.geometry.zMax,z,20))conflicts.push({id:'geometry-mismatch',models:[top.model]});
  }

  const blocking=conflicts.length>0;
  const topEvidence=top?evidence.filter(item=>item.model===top.model):[];
  const strongCount=topEvidence.filter(item=>item.strength==='strong').length;
  let status:PrinterDetectionResult['status']='unknown';
  let model:PrinterPreset='custom';
  let confidence:PrinterDetectionResult['confidence']=score>=24?'low':'unknown';
  if(blocking&&score>=24){
    status='ambiguous';
    confidence='low';
  }else if(top&&uniqueExplicit.includes(top.model)&&score>=82&&top.groups.length>=2&&strongCount>=1&&margin>=25){
    status='matched';model=top.model;confidence='high';
  }else if(top&&score>=60&&margin>=18&&(strongCount>=1||(score>=74&&top.groups.length>=4))){
    status='matched';model=top.model;confidence='medium';
  }

  const decision:PrinterDetectionResult['decision']=status==='ambiguous'
    ?'conflict'
    :status==='matched'&&confidence==='high'
      ?'confirmed'
      :status==='matched'&&confidence==='medium'
        ?'probable'
        :'unknown';

  return {
    engineVersion:PRINTER_DETECTION_ENGINE_VERSION,
    status,
    decision,
    model,
    confidence,
    score,
    margin,
    candidates,
    evidence:evidence.sort((left,right)=>PRESET_ORDER.indexOf(left.model)-PRESET_ORDER.indexOf(right.model)||right.weight-left.weight||left.id.localeCompare(right.id)),
    conflicts,
    fingerprint:fnv1a64(fingerprintPayload(facts))
  };
}

export function printerPresetDisplayName(preset:PrinterPreset){
  if(preset==='ender3-v3-ke')return 'Creality Ender-3 V3 KE';
  if(preset==='ender3-v3-se')return 'Creality Ender-3 V3 SE';
  if(preset==='creality-k1c-2025')return 'Creality K1C 2025';
  if(preset==='creality-k1-max')return 'Creality K1 Max';
  if(preset==='flashforge-ad5m')return FLASHFORGE_5M_DISPLAY_NAME;
  return 'Klipper Printer';
}
