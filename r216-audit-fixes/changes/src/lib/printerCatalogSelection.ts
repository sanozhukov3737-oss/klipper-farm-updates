import type { PrinterConfig } from '../types';
import { PRINTER_CATALOG, catalogModelName, getCatalogModel, getCatalogPreset, type PrinterCatalogModel } from './printerCatalog';
import { iconForPreset, profileForPreset } from './printerProfile';

const nameKey=(name:string)=>name.normalize('NFKC').toLocaleLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const generatedModelNames=new Set(PRINTER_CATALOG.flatMap(entry=>[catalogModelName(entry),entry.model]).concat([
  'Ender-3 V3 KE','Ender-3 V3 SE','Creality K1C 2025','FlashForge 5M','AD5M',
]).map(nameKey));
const profileModelFields=['bedX','bedY','maxZ','xMin','xMax','yMin','yMax','firmwareFamily'] as const;

/** A saved preset label alone does not prove that its geometry or driver agrees. */
export function catalogProfileMismatch(config:PrinterConfig,entry:PrinterCatalogModel):boolean{
  const preset=getCatalogPreset(entry);
  if(!preset)return false;
  const expected=profileForPreset(preset),profile=config.profile;
  return profile?.preset!==preset||(config.modelSelection?.selectedPreset??profile?.preset)!==preset
    ||profileModelFields.some(key=>profile?.[key]!==expected[key]);
}

// Older releases stored generated model names without recording their origin.
// Match complete model names, never substrings in an operator's own label.
function automaticNameSuffix(config:Pick<PrinterConfig,'name'|'host'|'nameSource'>):string|undefined{
  if(config.nameSource==='custom')return undefined;
  const name=config.name.trim();
  if(generatedModelNames.has(nameKey(name)))return '';
  const numbered=name.match(/^(.+?)\s+(\d{2,})$/);
  if(numbered&&generatedModelNames.has(nameKey(numbered[1])))return ` ${numbered[2]}`;
  if(config.nameSource==='automatic'||!name||name===config.host||/^klipper(?:\s+printer)?(?:\s*[·-]\s*.+)?$/i.test(name)||/^(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/i.test(name))return '';
  return undefined;
}

export const isAutomaticPrinterName=(config:Pick<PrinterConfig,'name'|'host'|'nameSource'>)=>automaticNameSuffix(config)!==undefined;

/** Repair the legacy picture/name mismatch without touching a live setup. */
export function normalizeCatalogIdentity<T extends PrinterConfig>(config:T):T{
  const entry=getCatalogModel(config.catalogModelId),suffix=automaticNameSuffix(config);
  if(!entry||suffix===undefined)return config;
  const name=catalogModelName(entry)+suffix;
  return name===config.name?config:{...config,name,nameSource:'automatic'};
}

/** Explicit operator selection applies a supported model's local preset.
 * Reading an existing catalogue identity never silently changes hardware settings.
 */
export function applyCatalogProfile(config:PrinterConfig,entry:PrinterCatalogModel):PrinterConfig{
  const preset=getCatalogPreset(entry);
  if(!preset)return config;
  const expected=profileForPreset(preset);
  const profile=config.profile?.preset===preset
    ?profileModelFields.every(key=>config.profile?.[key]===expected[key])?config.profile
      :{...expected,...config.profile,...Object.fromEntries(profileModelFields.map(key=>[key,expected[key]]))}
    :expected;
  // Иконка следует за выбранной моделью: если фото модели недоступно,
  // карточка покажет именно её силуэт, а не общую заглушку.
  return {...config,icon:iconForPreset(preset),
    profile,
    modelSelection:{mode:'manual',selectedPreset:preset,source:'manual',updatedAt:Date.now(),lastDetection:config.modelSelection?.lastDetection}};
}

export function applyCatalogModel(config:PrinterConfig,entry?:PrinterCatalogModel):PrinterConfig{
  if(!entry)return {...config,catalogModelId:undefined};
  return applyCatalogProfile(normalizeCatalogIdentity({...config,catalogModelId:entry.id}),entry);
}
