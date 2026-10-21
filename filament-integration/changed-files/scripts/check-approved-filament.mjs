import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from './typescript-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..');
const compile=(name,imports={})=>{
 let code=ts.transpileModule(fs.readFileSync(path.join(root,name),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 for(const [name,url] of Object.entries(imports))code=code.replaceAll(`from '${name}'`,`from '${url}'`);
 return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
};
const coreUrl=compile('src/lib/filamentInventory.ts');
const {emptyFilamentInventory,reduceFilamentInventory,restoreFilamentInventory,migrateFilamentInventory}=await import(coreUrl);
const {filamentStockOverview,spoolDescriptor}=await import(compile('src/lib/filamentSpool.ts',{'./filamentInventory':coreUrl}));
const cases=[],T=1800000000000;
let state=emptyFilamentInventory(T),clock=T;
const apply=command=>{state=reduceFilamentInventory(state,command,++clock).state};
const test=(name,run)=>{run();cases.push({name,passed:true})};
test('actual-spools-and-loose-stock-summed-once',()=>{
 apply({type:'add-stock',material:'PLA',grams:4500});
 apply({type:'add-spools',material:'PLA',count:1,weightGrams:1000,color:'#f47b24',finish:'silk',source:'purchase'});
 apply({type:'add-spools',material:'PETG',count:1,weightGrams:2000,color:'#2799ef',source:'purchase'});
 apply({type:'add-spools',material:'PLA',count:1,weightGrams:500,source:'purchase'});
 apply({type:'edit-spool',spoolId:state.spools[0].id,remainingGrams:680});
 apply({type:'edit-spool',spoolId:state.spools[1].id,remainingGrams:1500});
 apply({type:'edit-spool',spoolId:state.spools[2].id,remainingGrams:0});
 apply({type:'bind-printer',printerId:'a',material:'PLA',spoolId:state.spools[0].id});
 const overview=filamentStockOverview(state);
 assert.equal(overview.totalGrams,6680);assert.equal(overview.looseGrams,4500);
 assert.equal(overview.count,2);assert.equal(overview.mounted,1);assert.equal(overview.warehouse,1);
 assert.equal(overview.materials.reduce((sum,row)=>sum+row.totalGrams,0),overview.totalGrams);
 const duplicate={...state,spools:[...state.spools,state.spools[0]]};
 assert.equal(filamentStockOverview(duplicate).totalGrams,6680);assert.throws(()=>restoreFilamentInventory(duplicate));
});
test('swap-keeps-mass-and-counters-returns-old-spool',()=>{
 const before=filamentStockOverview(state),old=state.spools[0].id;
 apply({type:'bind-printer',printerId:'a',material:'PETG',spoolId:state.spools[1].id,expectedBindingId:state.printers.a.binding.id});
 const after=filamentStockOverview(state);
 for(const field of ['totalGrams','looseGrams','count','mounted','warehouse'])assert.equal(after[field],before[field]);
 assert.deepEqual(after.materials.map(({spool,...row})=>row),before.materials.map(({spool,...row})=>row));
 assert.equal(state.spools.find(s=>s.id===old).printerId,undefined);
 assert.equal(state.spools[1].printerId,'a');
});
test('empty-occupied-and-stale-assignments-fail-without-partial-state',()=>{
 const before=JSON.stringify(state);
 for(const command of [
  {type:'bind-printer',printerId:'b',material:'PLA',spoolId:state.spools[2].id},
  {type:'bind-printer',printerId:'b',material:'PETG',spoolId:state.spools[1].id},
  {type:'bind-printer',printerId:'a',material:'PLA',spoolId:state.spools[0].id,expectedBindingId:'stale'}
 ])assert.throws(()=>reduceFilamentInventory(state,command,T+100));
 assert.equal(JSON.stringify(state),before);
});
test('appearance-command-cannot-undo-a-concurrent-debit',()=>{
 apply({type:'manual-writeoff',printerId:'a',material:'PETG',spoolId:state.spools[1].id,grams:125});
 const before=state.spools[1].remainingWeight,history=JSON.stringify(state.usageHistory);
 apply({type:'spool-appearance',spoolId:state.spools[1].id,color:'#123456',finish:'matte'});
 assert.equal(state.spools[1].remainingWeight,before);assert.equal(JSON.stringify(state.usageHistory),history);
 const restored=restoreFilamentInventory(JSON.parse(JSON.stringify(state)));
 assert.equal(restored.spools[1].finish,'matte');assert.equal(restored.printers.a.binding.spoolId,state.spools[1].id);
});
test('old-data-preserved-without-inventing-finish-or-label-identifiers',()=>{
 const legacy={id:'old',name:'PET-G',material:'PET-G',color:'#abc',initialWeight:2000,remainingWeight:500,price:100,currency:'₽',createdAt:T};
 const inventory=migrateFilamentInventory([legacy],T);
 assert.deepEqual(inventory.spools[0],legacy);
 const d=spoolDescriptor(inventory.spools[0],2.85);
 assert.equal(d.finish,'normal');assert.equal(d.color,'#aabbcc');assert.equal(d.diameterMM,2.85);
 for(const field of ['serial','lot','barcode','ordinal'])assert.equal(field in d,false);
 assert.equal(filamentStockOverview(inventory).materials[0].count,1);
});
test('real-label-fields-preserved-only-valid-ean8-drawn',()=>{
 const d=spoolDescriptor({...state.spools[0],serial:'REAL-9',lot:'REAL-LOT',barcode:'12345670',ordinal:9});
 assert.equal(d.serial,'REAL-9');assert.equal(d.lot,'REAL-LOT');assert.equal(d.barcode,'12345670');assert.equal(d.ordinal,9);
 assert.equal(spoolDescriptor({...state.spools[0],barcode:'12345671'}).barcode,undefined);
 assert.equal(spoolDescriptor({...state.spools[0],barcode:12345670,serial:{legacy:true}}).barcode,undefined);
 assert.equal(spoolDescriptor({...state.spools[0],serial:{legacy:true}}).serial,undefined);
});
test('invalid-appearance-rejected-and-mass-above-capacity-preserved',()=>{
 const before=JSON.stringify(state);
 for(const finish of ['bad',null,2])assert.throws(()=>reduceFilamentInventory(state,{type:'spool-appearance',spoolId:state.spools[0].id,finish},T));
 assert.equal(JSON.stringify(state),before);
 apply({type:'edit-spool',spoolId:state.spools[0].id,remainingGrams:1200});
 assert.equal(spoolDescriptor(state.spools[0]).grams,1200);assert.equal(spoolDescriptor(state.spools[0]).capacityGrams,1000);
});
console.log(JSON.stringify({passed:cases.length,cases},null,2));
