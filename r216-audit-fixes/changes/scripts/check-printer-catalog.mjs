#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from './typescript-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const data=JSON.parse(fs.readFileSync(path.join(root,'src/data/printerCatalog.json'),'utf8'));
let checks=0;
const check=(name,run)=>{run();checks++;console.log('PASS '+name)};
const normalized=value=>String(value).normalize('NFKC').toLocaleLowerCase('en').replace(/\+/g,'plus').replace(/[^\p{L}\p{N}]/gu,'');
const physicalName=entry=>{
  let model=normalized(entry.model),brand=normalized(entry.brand);
  if(model.startsWith(brand))model=model.slice(brand.length);
  return brand+':'+model;
};
const models=data.models;
const manufacturerSources={
  'flashforge-creator-pro-2':'https://www.flashforge.com/blogs/download-center-1/creator-series',
  'flashforge-creator-3':'https://www.flashforge.com/blogs/download-center-1/creator-series',
  'flashforge-creator-3-pro':'https://www.flashforge.com/blogs/download-center-1/creator-series',
  'flashforge-creator-4':'https://www.flashforge.com/blogs/download-center-1/creator-series',
  'flashforge-guider-2':'https://www.flashforge.com/blogs/download-center/guider-series',
  'flashforge-guider-3':'https://www.flashforge.com/blogs/download-center/guider-series',
  'flashforge-guider-3-plus':'https://www.flashforge.com/blogs/download-center/guider-series',
  'prusa-mk3s-plus':'https://help.prusa3d.com/product/mk3s-2',
  'prusa-mini-plus':'https://blog.prusa3d.com/november2020_40870/',
  'voron-0-2':'https://vorondesign.com/voron0.2',
};

check('500 distinct physical model identities with reproducible provenance',()=>{
  assert.equal(data.schemaVersion,1);
  assert.match(data.updatedAt,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(models.length,500,'The catalogue must contain 500 models, not nozzle or bundle variants');
  assert.equal(new Set(models.map(entry=>entry.id)).size,500,'Duplicate stable model ID');
  const names=new Map();
  for(const entry of models){
    assert.match(entry.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/,'Unsafe model ID: '+entry.id);
    assert.ok(entry.id.length<=100,'Unbounded catalogue ID');
    assert.ok(typeof entry.brand==='string'&&entry.brand.trim()===entry.brand&&entry.brand.length>0);
    assert.ok(typeof entry.model==='string'&&entry.model.trim()===entry.model&&entry.model.length>0);
    const name=physicalName(entry);
    assert.ok(!names.has(name),`One physical model appears twice: ${names.get(name)} / ${entry.id}`);
    names.set(name,entry.id);
    assert.ok(Array.isArray(entry.aliases)&&entry.aliases.every(alias=>typeof alias==='string'&&alias.trim()===alias&&alias.length>0));
    assert.equal(new Set(entry.aliases.map(alias=>alias.toLocaleLowerCase('en'))).size,entry.aliases.length,'Duplicate aliases: '+entry.id);
    const source=new URL(entry.sourceUrl);
    assert.equal(source.protocol,'https:');
    if(source.hostname==='github.com')assert.match(source.pathname,/^\/(?:OrcaSlicer\/OrcaSlicer\/blob\/fd28f6c1894a7fb09af2af0d8a8c935d98467e2d\/resources\/profiles|Ultimaker\/Cura\/blob\/5bea2f86153faed3a1c2d9081b8d6b753684678a\/resources\/definitions)\/.+\.json$/,'Unpinned or unrelated source: '+entry.id);
    else assert.equal(entry.sourceUrl,manufacturerSources[entry.id],'Unreviewed manufacturer source: '+entry.id);
    assert.ok(!/\b(?:nozzle|combo|bundle|kit|klipper|marlin|high[ -]?flow)\b|\b\d[.,]\d\s*mm\b/i.test(entry.model),'Slicer/nozzle/bundle variant counted as a model: '+entry.id);
    assert.deepEqual(Object.keys(entry).sort(),['aliases','brand','id','model','sourceUrl'],'Catalogue imported operational settings or unsupported compatibility claims: '+entry.id);
  }
  assert.ok(new Set(models.map(entry=>entry.brand)).size>=30,'Catalogue must span manufacturers');
  assert.equal(models.filter(entry=>new URL(entry.sourceUrl).hostname==='github.com').length,490,'Changed source provenance split requires review');
});

// Load production TypeScript without starting the UI or a native client. Asset
// modules become deterministic names; JSON is the exact packaged offline data.
const moduleCache=new Map();
function compile(relative){
  const absolute=path.resolve(root,relative);
  if(moduleCache.has(absolute))return moduleCache.get(absolute);
  if(!/\.(?:tsx?|json)$/.test(absolute)){
    const url=`data:text/javascript;base64,${Buffer.from('export default '+JSON.stringify(path.relative(root,absolute).split(path.sep).join('/'))).toString('base64')}`;
    moduleCache.set(absolute,url);return url;
  }
  if(absolute.endsWith('.json')){
    const url=`data:text/javascript;base64,${Buffer.from('export default '+fs.readFileSync(absolute,'utf8')).toString('base64')}`;
    moduleCache.set(absolute,url);return url;
  }
  const result=ts.transpileModule(fs.readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},fileName:absolute,reportDiagnostics:true});
  assert.equal(result.diagnostics?.length??0,0,'Transpile diagnostics: '+relative);
  let output=result.outputText;
  const imports=[...output.matchAll(/\bfrom\s*(['"])(\.\.?\/[^'"]+)\1/g)];
  for(const match of imports){
    const target=path.resolve(path.dirname(absolute),match[2]);
    const resolved=[target,target+'.ts',target+'.tsx',path.join(target,'index.ts')].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
    assert.ok(resolved,'Unresolved production import: '+match[2]);
    output=output.replaceAll(match[0],`from ${JSON.stringify(compile(path.relative(root,resolved)))}`);
  }
  assert.doesNotMatch(output,/\b(?:fetch|XMLHttpRequest|WebSocket|secureInvoke|invoke)\s*\(/,'Offline catalogue module must not initiate network/native work');
  const url=`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  moduleCache.set(absolute,url);return url;
}
const catalog=await import(compile('src/lib/printerCatalog.ts'));
const {PRINTER_CATALOG,catalogSearchModels,getCatalogModel,getCatalogPreset,catalogConnectionHint,catalogModelArtwork,catalogModelName}=catalog;
const {applyCatalogModel}=await import(compile('src/lib/printerCatalogSelection.ts'));
const {printerArtwork,printerArtworkByPreset,fallbackPrinterArtwork}=await import(compile('src/lib/printerArtwork.ts'));
const {catalogArtworkById,catalogPhotoIds}=await import(compile('src/lib/printerCatalogArtwork.ts'));
const profileModule=await import(compile('src/lib/printerProfile.ts'));
const {profileForPreset}=profileModule;
const {localLibraryScopeId}=await import(compile('src/lib/localLibraryScope.ts'));
const {printerPresentationPreset}=await import(compile('src/lib/printerPresentation.ts'));

check('production catalogue exposes the complete local data and rejects unknown IDs',()=>{
  assert.equal(PRINTER_CATALOG.length,500);
  assert.deepEqual(PRINTER_CATALOG.map(entry=>entry.id).sort(),models.map(entry=>entry.id).sort());
  for(const entry of PRINTER_CATALOG)assert.equal(getCatalogModel(entry.id)?.id,entry.id);
  for(const bad of [undefined,'','not-a-model','__proto__','constructor','../../creality-k1-max'])assert.equal(getCatalogModel(bad),undefined,'Invalid catalogue lookup should have no selection');
  assert.equal(catalogSearchModels('').length,500,'Empty query must search all pages');
  assert.equal(catalogSearchModels('never-a-real-printer-zzzzzz').length,0,'Unknown model should produce an empty result');
});

check('English and Russian search, punctuation and manufacturer filters work offline',()=>{
  const cases=[
    ['креалити','creality-k1-max'],['эндер 3 v3 ke','creality-ender-3-v3-ke'],
    ['бамбу','bambu-lab-a1-mini'],['пруса','prusa-mk4'],
    ['K1 MAX','creality-k1-max'],['Ender 3 V3 KE','creality-ender-3-v3-ke'],
    ['A1 mini','bambu-lab-a1-mini'],['Adventurer 5M Pro','flashforge-adventurer-5m-pro'],
  ];
  for(const [query,id] of cases)assert.ok(catalogSearchModels(query).some(entry=>entry.id===id),`Search '${query}' did not find ${id}`);
  const brandResults=catalogSearchModels('','Creality');
  assert.ok(brandResults.length>20&&brandResults.every(entry=>entry.brand==='Creality'),'Manufacturer filter leaks other brands');
  assert.equal(catalogSearchModels('A1 mini','Creality').length,0,'Search must respect the selected brand');
  for(const entry of PRINTER_CATALOG.filter(entry=>entry.aliases.length).slice(0,12)){
    assert.ok(catalogSearchModels(entry.aliases[0]).some(result=>result.id===entry.id),'Declared source alias is not searchable: '+entry.id);
  }
});

check('exact local model photos preserve the five existing illustrations and neutral fallbacks',()=>{
  const mapped=[
    ['creality-ender-3-v3-ke','ender3-v3-ke'],['creality-ender-3-v3-se','ender3-v3-se'],
    ['creality-k1c','creality-k1c-2025'],['creality-k1-max','creality-k1-max'],
    ['flashforge-adventurer-5m','flashforge-ad5m'],
  ];
  for(const [id,preset] of mapped){const entry=getCatalogModel(id);assert.ok(entry,id);assert.equal(getCatalogPreset(entry),preset);assert.equal(catalogModelArtwork(entry),printerArtworkByPreset[preset]);}
  assert.deepEqual(catalogPhotoIds,Object.keys(catalogArtworkById),'Photo ID index differs from the packaged mapping');
  assert.equal(new Set(catalogPhotoIds).size,catalogPhotoIds.length,'Repeated photo ID');
  for(const [id,image] of Object.entries(catalogArtworkById)){
    assert.ok(getCatalogModel(id),'Photo refers to an unknown catalogue ID: '+id);
    assert.equal(typeof image,'string','Photo path must be a bundled asset URL: '+id);
    assert.match(image,/^src\/assets\/printer-catalog(?:-cutouts)?\/[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp)$/,'Photo must be an explicitly imported local asset: '+id);
    assert.ok(fs.existsSync(path.join(root,image)),'Packaged photo is missing: '+id);
  }
  for(const entry of PRINTER_CATALOG){
    const preset=getCatalogPreset(entry);
    const expected=preset?printerArtworkByPreset[preset]:Object.hasOwn(catalogArtworkById,entry.id)?catalogArtworkById[entry.id]:fallbackPrinterArtwork;
    assert.equal(catalogModelArtwork(entry),expected,'Wrong artwork for exact model ID: '+entry.id);
    const config={name:'My printer',catalogModelId:entry.id,profile:{preset:'custom'}};
    assert.equal(printerArtwork(config),expected,'Printer surface differs from model picker: '+entry.id);
    assert.equal(printerArtwork({...config,imageData:'data:image/png;base64,custom'}),'data:image/png;base64,custom','Catalogue photo replaced a user image: '+entry.id);
  }
  for(const id of ['creality-k1','flashforge-adventurer-5m-pro','flashforge-ad5x','bambu-lab-a1-mini','prusa-mk4']){
    const entry=getCatalogModel(id);assert.equal(getCatalogPreset(entry),undefined,'Related model was given another model’s preset: '+id);
  }
  for(const id of ['unknown-model','__proto__','constructor','../../creality-k1-max']){
    assert.equal(catalogModelArtwork({id,brand:'Unknown',model:'Unknown',aliases:[],sourceUrl:'https://example.invalid'}),fallbackPrinterArtwork,'Unknown model must use neutral artwork');
    assert.equal(printerArtwork({name:'K1 Max',catalogModelId:id,profile:{preset:'creality-k1-max'}}),fallbackPrinterArtwork,'Unknown catalogue identity must not inherit a legacy model photo');
  }
  assert.match(catalogConnectionHint(getCatalogModel('bambu-lab-a1-mini')),/не поддерживается/,'Catalogue must not claim that the Bambu driver exists');
  assert.match(catalogConnectionHint(getCatalogModel('prusa-mk4')),/не поддерживается/,'Catalogue must not claim that the PrusaLink driver exists');
  assert.match(catalogConnectionHint(getCatalogModel('creality-k1-max')),/Klipper\/Moonraker/,'Network access still requires a working supported endpoint');
  assert.ok(catalogModelName(getCatalogModel('creality-k1-max')).includes('K1 Max'));
});

check('explicit supported choices apply local profiles while all catalogue choices preserve device identity',()=>{
  const config={id:'existing-printer',name:'Мой рабочий принтер',host:'192.168.1.105:7125',apiKeyStored:true,icon:'custom',imageData:'data:image/png;base64,kept',profile:profileForPreset('custom'),modelSelection:{mode:'manual',selectedPreset:'custom',source:'manual',updatedAt:123},deviceIdentity:{stableId:'hardware:existing'},capabilities:{camera:false},configSnapshot:{fingerprint:'existing'}};
  for(const entry of PRINTER_CATALOG){
    const before=structuredClone(config),result=applyCatalogModel(config,entry),preset=getCatalogPreset(entry);
    assert.equal(result.catalogModelId,entry.id);assert.equal(result.name,config.name);
    for(const field of ['id','host','apiKeyStored','imageData','deviceIdentity','capabilities','configSnapshot'])assert.strictEqual(result[field],config[field],entry.id+': changed '+field);
    if(preset){assert.deepEqual(result.profile,profileForPreset(preset));assert.equal(result.modelSelection.mode,'manual');assert.equal(result.modelSelection.selectedPreset,preset);assert.equal(localLibraryScopeId(result),'model:'+preset)}
    else{assert.strictEqual(result.profile,config.profile);assert.strictEqual(result.modelSelection,config.modelSelection);assert.equal(localLibraryScopeId(result),config.id)}
    const clear=applyCatalogModel(result,undefined);assert.equal(clear.catalogModelId,undefined);assert.deepEqual({...clear,catalogModelId:undefined},{...result,catalogModelId:undefined});
    assert.deepEqual(config,before,'Selection mutated the caller');
    assert.deepEqual(JSON.parse(JSON.stringify(result)).profile,result.profile);
    assert.ok(!Object.hasOwn(result,'modelId'),'A catalogue choice cannot attest native modelId');
  }
});

check('icon follows the chosen catalogue model so a card can show its silhouette',()=>{
  const {iconForPreset}=profileModule;
  for(const [id,preset] of [['creality-k1c','creality-k1c-2025'],['creality-k1-max','creality-k1-max'],
      ['creality-ender-3-v3-ke','ender3-v3-ke'],['flashforge-adventurer-5m','flashforge-ad5m']]){
    const entry=getCatalogModel(id);assert.ok(entry,id);
    const config={id:'icon-'+id,name:'Printer',host:'192.168.1.10:7125',profile:profileForPreset('custom')};
    assert.equal(applyCatalogModel(config,entry).icon,iconForPreset(preset),'Catalogue choice did not set the model icon: '+id);
  }
  // Модель без локального пресета не должна выдавать чужую иконку.
  const plain=getCatalogModel('alfawise-u20');
  if(plain){
    const config={id:'icon-plain',name:'Printer',host:'192.168.1.11:7125',icon:'ender',profile:profileForPreset('custom')};
    assert.equal(applyCatalogModel(config,plain).icon,'ender','A model without a preset must keep the existing icon');
  }
});

check('the printer card renders the model silhouette when the bundled photo fails',()=>{
  const card=fs.readFileSync(path.join(root,'src/components/FleetPrinterCard.tsx'),'utf8');
  assert.ok(card.includes("from './ModelIcon'"),'Printer card does not use the model icon');
  assert.ok(card.includes("printer.icon !== 'custom'"),'Printer card does not gate the icon on a known model');
  assert.ok(card.includes('photoFailed && modelIcon'),'Photo failure does not switch to the model icon');
  assert.ok(card.includes('<ModelIcon type={modelIcon}/>'),'Model icon is not rendered on photo failure');
  const css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8');
  assert.ok(css.includes('.artwork > .modelIcon'),'Model icon has no size in the artwork slot');
});

check('same supported preset keeps customized parameters and unsupported cards preserve operational profiles',()=>{
  for(const preset of ['ender3-v3-ke','ender3-v3-se','creality-k1c-2025','creality-k1-max','flashforge-ad5m']){
    const config={id:'existing-'+preset,name:'Моя настроенная ферма',host:'192.168.1.100:7125',profile:{...profileForPreset(preset),nozzle:.6,priority:7},modelSelection:{mode:'manual',selectedPreset:preset,source:'manual',updatedAt:1}};
    for(const entry of PRINTER_CATALOG){
      const result=applyCatalogModel(config,entry),target=getCatalogPreset(entry);
      if(!target||target===preset)assert.strictEqual(result.profile,config.profile);
      else assert.deepEqual(result.profile,profileForPreset(target));
      assert.equal(result.profile.preset,target??preset);
      assert.equal(result.modelSelection.selectedPreset,target??preset);
      assert.equal(localLibraryScopeId(result),'model:'+(target??preset));
    }
  }
});

check('catalogue cards never inherit another model’s legacy presentation badge',()=>{
  for(const entry of PRINTER_CATALOG){
    const config={name:catalogModelName(entry),catalogModelId:entry.id,profile:profileForPreset('custom')};
    assert.equal(printerPresentationPreset(config),undefined,'Catalogue title was interpreted as a legacy operational model: '+entry.id);
  }
  for(const id of ['flashforge-creator-4','flashforge-adventurer-5m-pro']){
    const entry=getCatalogModel(id);assert.ok(entry,id);
    assert.equal(printerPresentationPreset({name:catalogModelName(entry),catalogModelId:id,profile:profileForPreset('flashforge-ad5m')}),undefined,'A selected catalogue identity inherited the 5M badge: '+id);
  }
  const legacyNames={
    'ender3-v3-ke':'Ender-3 V3 KE',
    'ender3-v3-se':'Ender-3 V3 SE',
    'creality-k1c-2025':'Creality K1C 2025',
    'creality-k1-max':'Creality K1 Max',
    'flashforge-ad5m':'FlashForge 5M',
  };
  for(const [preset,name] of Object.entries(legacyNames)){
    assert.equal(printerPresentationPreset({name:'Старый принтер',profile:profileForPreset(preset)}),preset,'Existing saved profile lost its legacy presentation');
    assert.equal(printerPresentationPreset({name,profile:profileForPreset('custom')}),preset,'Existing name-only legacy printer lost its presentation');
    assert.equal(printerPresentationPreset({name:'Generic',profile:profileForPreset('custom'),modelSelection:{mode:'automatic',selectedPreset:'custom',lastDetection:{model:preset,status:'matched',decision:'probable',conflicts:[]}}}),preset,'Existing probable detection lost its presentation');
    assert.equal(printerPresentationPreset({name,catalogModelId:'removed-catalog-id',profile:profileForPreset(preset)}),undefined,'Unresolved catalogue identity revived the legacy badge fallback');
  }
});

console.log(JSON.stringify({passed:checks,models:PRINTER_CATALOG.length,offline:true,supportedPresetsApplied:true,deviceIdentityPreserved:true}));
