#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import ts from './typescript-runtime.mjs';

const root=path.resolve(import.meta.dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'kf-printer-identity-r125-'));
const modules=new Map(),productionSources=new Map(),cases=[];
const sha256=value=>createHash('sha256').update(value).digest('hex');

// Execute the actual production modules. Only their packaged image imports
// become path strings; no naming/selection algorithm is reproduced here.
function compile(absolute){
 if(modules.has(absolute))return modules.get(absolute);
 assert.ok(absolute.startsWith(root+path.sep),'Production import escapes the app');
 const source=fs.readFileSync(absolute),relative=path.relative(root,absolute).split(path.sep).join('/');
 const target=path.join(temporary,sha256(relative)+'.mjs'),url=pathToFileURL(target).href;
 modules.set(absolute,url);
 if(absolute.endsWith('.json'))fs.writeFileSync(target,'export default '+source.toString('utf8')+';\n');
 else if(!/\.tsx?$/.test(absolute))fs.writeFileSync(target,'export default '+JSON.stringify(relative)+';\n');
 else{
  productionSources.set(relative,sha256(source));
  const result=ts.transpileModule(source.toString('utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},fileName:absolute,reportDiagnostics:true});
  assert.equal(result.diagnostics?.length??0,0,'Production TypeScript failed to transpile: '+relative);
  let output=result.outputText;
  for(const match of [...output.matchAll(/\bfrom\s*(['"])(\.\.?\/[^'"]+)\1/g)]){
   const location=path.resolve(path.dirname(absolute),match[2]);
   const resolved=[location,location+'.ts',location+'.tsx',path.join(location,'index.ts')].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
   assert.ok(resolved,'Unresolved production import '+match[2]);
   output=output.replaceAll(match[0],'from '+JSON.stringify(compile(resolved)));
  }
  assert.doesNotMatch(output,/\b(?:fetch|XMLHttpRequest|WebSocket|secureInvoke|invoke)\s*\(/,'Identity modules must not initiate device/network work');
  fs.writeFileSync(target,output);
 }
 return url;
}
const check=(name,run)=>{run();cases.push({case:name,passed:true});console.log('PASS '+name)};
try{
 const {normalizeCatalogIdentity,isAutomaticPrinterName,applyCatalogModel}=await import(compile(path.join(root,'src/lib/printerCatalogSelection.ts')));
 const {printerDisplayName}=await import(compile(path.join(root,'src/lib/printerName.ts')));
 const {getCatalogModel,catalogModelArtwork}=await import(compile(path.join(root,'src/lib/printerCatalog.ts')));
 const {printerArtwork}=await import(compile(path.join(root,'src/lib/printerArtwork.ts')));
 const {profileForPreset}=await import(compile(path.join(root,'src/lib/printerProfile.ts')));
 const ff=getCatalogModel('flashforge-adventurer-5m'),ke=getCatalogModel('creality-ender-3-v3-ke');
 assert.ok(ff&&ke,'Exact reviewed models must exist in the packaged catalogue');
 const ffName='Flashforge Adventurer 5M',keName='Creality Ender-3 V3 KE';
 const base=()=>({id:'fixture-target-108',name:keName,host:'192.168.1.108:7125',icon:'ender',apiKeyStored:true,tags:['Левый стол'],accent:'#7654ab',profile:{...profileForPreset('ender3-v3-ke'),nozzle:.6,priority:7,materials:['PETG','ASA']},modelSelection:{mode:'manual',selectedPreset:'ender3-v3-ke',source:'legacy',updatedAt:123},deviceIdentity:{version:1,stableId:'hardware:existing-108',strength:'hardware',dedupeSafe:true,observedAt:123,signals:{machineId:'existing-board-108',serial:'fixture-serial'}},capabilities:{version:1,attestedAt:123,camera:false,macros:['LOCAL_START'],compatible:true},configSnapshot:{version:2,capturedAt:123,fingerprint:'fixture-existing',facts:{identity:{machineId:'existing-board-108'}}}});
 const unchangedSetup=(actual,before)=>{
  // Явный выбор модели в каталоге применяет её локальный пресет: имя, профиль
  // и modelSelection меняются намеренно (это и есть смысл выбора модели).
  // Проверяем обратное: выбор модели не трогает ничего, что относится к
  // железу, адресу, учётным данным и вложениям оператора.
  for(const key of Object.keys(before).filter(key=>!['name','nameSource','catalogModelId','profile','icon','modelSelection'].includes(key)))assert.deepEqual(actual[key],before[key],'Choosing a catalogue model rewrote '+key);
 };

 check('legacy-ke-label-becomes-exact-selected-flashforge-without-changing-working-setup',()=>{
  const initial=base(),before=structuredClone(initial),selected=applyCatalogModel(initial,ff);
  assert.equal(selected.name,ffName);assert.equal(selected.nameSource,'automatic');assert.equal(selected.catalogModelId,ff.id);
  unchangedSetup(selected,before);assert.deepEqual(initial,before,'Selection mutated the caller’s configuration');
  // Выбор модели применяет её пресет — профиль обязан стать пресетом
  // выбранной модели, а не остаться прежним. Идентичность устройства при этом
  // не переписывается.
  assert.equal(selected.profile.preset,'flashforge-ad5m');assert.equal(selected.deviceIdentity,initial.deviceIdentity);
 });
 check('automatic-numbered-label-preserves-operator-visible-number',()=>{
  for(const suffix of ['02','005','123']){
   const initial={...base(),name:keName+' '+suffix},selected=applyCatalogModel(initial,ff);
   assert.equal(selected.name,ffName+' '+suffix);unchangedSetup(selected,initial);
  }
 });
 check('legacy-flashforge-picture-and-ke-name-repair-without-reselection-is-idempotent',()=>{
  const initial={...base(),catalogModelId:ff.id},before=structuredClone(initial),repaired=normalizeCatalogIdentity(initial);
  assert.equal(repaired.name,ffName);assert.equal(repaired.catalogModelId,ff.id);unchangedSetup(repaired,initial);
  assert.equal(normalizeCatalogIdentity(repaired),repaired,'Repeated load must not keep allocating changed state');
  assert.deepEqual(initial,before,'Legacy repair mutated the input');
 });
 check('explicit-custom-name-equal-to-a-model-name-is-never-rewritten',()=>{
  const initial={...base(),nameSource:'custom'};
  assert.equal(isAutomaticPrinterName(initial),false);
  const selected=applyCatalogModel(initial,ff);
  assert.equal(selected.name,keName);assert.equal(selected.nameSource,'custom');
  assert.equal(normalizeCatalogIdentity(selected),selected);assert.equal(printerDisplayName(selected),keName);
  unchangedSetup(selected,initial);
 });
 check('legacy-operator-labels-with-model-substrings-remain-exact',()=>{
  for(const name of ['Мой KE у окна','Creality Ender-3 V3 KE — левый стол','Flashforge на полке','Номер 02','Мастерская K1 Max']){
   const initial={...base(),name},selected=applyCatalogModel(initial,ff);
   assert.equal(isAutomaticPrinterName(initial),false,name);assert.equal(selected.name,name);unchangedSetup(selected,initial);
  }
 });
 check('empty-address-and-generic-automatic-labels-use-the-explicit-catalogue',()=>{
  for(const name of ['',base().host,'192.168.1.108','http://192.168.1.108:7125','Klipper Printer','Klipper · 192.168.1.108']){
   const initial={...base(),name},selected=applyCatalogModel(initial,ff);
   assert.equal(isAutomaticPrinterName(initial),true,name);assert.equal(selected.name,ffName);unchangedSetup(selected,initial);
  }
 });
 check('recorded-automatic-name-can-follow-a-new-catalogue-model',()=>{
  const initial={...base(),name:'Старое автоматически созданное имя',nameSource:'automatic'};
  assert.equal(isAutomaticPrinterName(initial),true);
  const selected=applyCatalogModel(initial,ff);assert.equal(selected.name,ffName);unchangedSetup(selected,initial);
 });
 check('a-complete-other-catalogue-model-name-is-a-generated-legacy-label',()=>{
  const initial={...base(),name:'Bambu Lab A1 mini'},selected=applyCatalogModel(initial,ff);
  assert.equal(selected.name,ffName);unchangedSetup(selected,initial);
 });
 check('unselected-and-invalid-catalogue-identities-do-not-rewrite-existing-ke',()=>{
  const initial=base();assert.equal(normalizeCatalogIdentity(initial),initial);assert.equal(printerDisplayName(initial),keName);
  for(const catalogModelId of ['not-a-model','__proto__','constructor','../../flashforge-adventurer-5m']){
   const invalid={...initial,catalogModelId};assert.equal(normalizeCatalogIdentity(invalid),invalid);assert.equal(printerDisplayName(invalid),keName);
  }
 });
 check('displayed-card-name-and-image-agree-even-before-a-legacy-record-is-resaved',()=>{
  const initial={...base(),catalogModelId:ff.id},before=structuredClone(initial);
  assert.equal(printerDisplayName(initial),ffName);assert.equal(printerArtwork(initial),catalogModelArtwork(ff));
  assert.deepEqual(initial,before,'Rendering a card mutated saved data');
 });
 check('clearing-a-card-removes-only-the-catalogue-override',()=>{
  const selected=applyCatalogModel(base(),ff),cleared=applyCatalogModel(selected,undefined);
  assert.equal(cleared.catalogModelId,undefined);assert.equal(cleared.name,ffName);assert.equal(cleared.nameSource,'automatic');unchangedSetup(cleared,selected);
 });
 check('changing-the-card-keeps-a-user-supplied-image-and-all-hardware-evidence',()=>{
  const initial={...base(),imageData:'data:image/png;base64,fixture-only'},selected=applyCatalogModel(initial,ff);
  assert.equal(printerArtwork(selected),initial.imageData);unchangedSetup(selected,initial);
 });
 check('persisted-json-roundtrip-retains-the-selected-name-number-and-operational-profile',()=>{
  const initial={...base(),name:keName+' 02'},selected=applyCatalogModel(initial,ff),reloaded=JSON.parse(JSON.stringify(selected));
  assert.equal(normalizeCatalogIdentity(reloaded),reloaded);assert.equal(reloaded.name,ffName+' 02');assert.equal(printerDisplayName(reloaded),ffName+' 02');unchangedSetup(reloaded,initial);
 });
 check('repairing-one-printer-does-not-change-other-ke-printers',()=>{
  const target={...base(),catalogModelId:ff.id},neighbor={...base(),id:'fixture-neighbor-107',host:'192.168.1.107:7125',name:keName+' 05',catalogModelId:ke.id},before=structuredClone(neighbor);
  const repaired=[target,neighbor].map(normalizeCatalogIdentity);
  assert.equal(repaired[0].name,ffName);assert.equal(repaired[1],neighbor);assert.deepEqual(neighbor,before);
 });

 const report={schemaVersion:1,release:'R125',passed:true,caseCount:cases.length,cases,coverage:{actualProductionFunctions:true,legacyMismatchRepair:true,explicitCustomName:true,numberedLabels:true,noOperationalRewrite:true,exactCardIdentity:true,clearingSelection:true,unrelatedPrintersUnchanged:true},productionSources:Object.fromEntries(productionSources)};
 if(process.env.KF_PRINTER_IDENTITY_PROOF){let target=path.resolve(process.env.KF_PRINTER_IDENTITY_PROOF);if(path.extname(target)!=='.json')target=path.join(target,'printer-identity-core-r125-report.json');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');}
 console.log(`Printer identity R125: ${cases.length} production behavior cases passed.`);
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
