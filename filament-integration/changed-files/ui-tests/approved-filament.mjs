import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {build} from 'vite';
const root=path.resolve(import.meta.dirname,'..'),out=fs.mkdtempSync(path.join(os.tmpdir(),'kf-approved-filament-'));
const shots=process.env.KF_UI_SCREENSHOTS,report=[],errors=[];
let browser,server,current;
try{
 await build({root,logLevel:'error',build:{outDir:out,emptyOutDir:true,rollupOptions:{input:path.join(root,'ui-tests/filament-inventory.html')}}});
 server=http.createServer((req,res)=>{
  const file=path.resolve(out,new URL(req.url,'http://localhost').pathname.slice(1));
  if(!file.startsWith(out+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]??'application/octet-stream');res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH??'playwright');
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
 if(shots)fs.mkdirSync(shots,{recursive:true});
 const open=async(theme='dark',width=1366,extra='',noGL=false)=>{
  const page=await browser.newPage({viewport:{width,height:1100},locale:'ru-RU'});current=page;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({noGL})=>{
   window.__contexts=[];window.__maxContexts=0;
   const original=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(name,...args){
    if(noGL&&/^webgl|experimental-webgl/.test(name))return null;
    const context=original.call(this,name,...args);
    if(name==='webgl'&&context&&!window.__contexts.some(item=>item.gl===context)){
     window.__contexts.push({canvas:this,gl:context});
     window.__maxContexts=Math.max(window.__maxContexts,window.__contexts.filter(item=>!item.gl.isContextLost()).length);
    }
    return context;
   };
  },{noGL});
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  await page.goto(`${origin}/ui-tests/filament-inventory.html?seed=handoff&theme=${theme}${extra}`);
  await page.getByTestId('filament-total-kg').waitFor();return page;
 };
 const inventory=page=>page.evaluate(()=>window.__inventory());
 const viewer=page=>page.getByTestId('filament-3d-viewer');
 const selected=page=>page.getByRole('region',{name:'Выбранная катушка',exact:true});
 const ready=page=>page.waitForFunction(()=>document.querySelector('[data-testid="filament-3d-viewer"]')?.dataset.ready==='true',null,{timeout:60000});
 const totals=state=>({grams:Object.values(state.materials).reduce((sum,row)=>sum+row.looseGrams,0)+state.spools.reduce((sum,row)=>sum+row.remainingWeight,0),count:state.spools.filter(s=>s.remainingWeight>0).length,mounted:state.spools.filter(s=>s.remainingWeight>0&&s.printerId).length});
 const assertTotals=async(page,state)=>{
  const t=totals(state);
  assert.equal((await page.getByTestId('filament-total-kg').innerText()).replace(/\s/g,''),(t.grams/1000).toLocaleString('ru-RU',{maximumFractionDigits:3}).replace(/\s/g,''));
  assert.equal(await page.getByTestId('filament-nonempty-count').innerText(),String(t.count));assert.equal(await page.getByTestId('filament-mounted-count').innerText(),String(t.mounted));assert.equal(await page.getByTestId('filament-warehouse-count').innerText(),String(t.count-t.mounted));
 };
 for(const theme of ['light','dark'])for(const width of [1366,910,390]){
  const page=await open(theme,width);await ready(page);const state=await inventory(page);await assertTotals(page,state);
  assert.equal(await selected(page).locator('canvas').getAttribute('data-vertices'),'1081728','Approved 680g geometry changed');
  for(const spool of state.spools.filter(s=>s.remainingWeight>0)){
   const img=page.getByTestId(`filament-spool-${spool.id}`).getByRole('img');
   assert.equal(await img.getAttribute('data-filament-color'),spool.color);assert.equal(await img.getAttribute('data-filament-grams'),String(spool.remainingWeight));
  }
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.command==='filament_inventory_commit').length),0);
  assert.equal(await page.getByRole('slider').count(),0,'Demo slider must never control inventory');
  await selected(page).getByRole('button',{name:'Повернуть влево',exact:true}).focus();await page.keyboard.press('Enter');
  await selected(page).getByRole('button',{name:'Повернуть вправо',exact:true}).click();
  if(shots&&width===1366)await page.screenshot({path:path.join(shots,`approved-default-${theme}.png`)});
  await selected(page).getByRole('button',{name:'Крупно',exact:true}).click();
  await selected(page).getByRole('button',{name:'Приблизить катушку',exact:true}).click();
  assert.equal(await viewer(page).locator('output').innerText(),'110%');
  if(shots&&width===1366)await page.screenshot({path:path.join(shots,`approved-inspect-${theme}.png`)});
  await selected(page).getByRole('button',{name:'К карточке',exact:true}).click();
  await selected(page).getByLabel('Выбрать отдельную катушку',{exact:true}).selectOption(state.spools[1].id);
  await page.waitForFunction(()=>document.querySelector('[data-testid="filament-3d-viewer"] canvas')?.getAttribute('aria-label')?.startsWith('PETG,'));
  assert.equal(await selected(page).getByTestId('filament-selected-grams').innerText(),'1 500');
  await selected(page).getByLabel('Выбрать отдельную катушку',{exact:true}).selectOption(state.spools[0].id);
  const overflow=await page.locator('body').evaluate(el=>el.scrollWidth>innerWidth+1);assert.equal(overflow,false,`${theme}/${width} horizontal overflow`);
  assert.ok(await page.evaluate(()=>window.__maxContexts<=2),'One viewer plus one shared thumbnail worker maximum');
  assert.deepEqual(await inventory(page),state,'Viewing/rotating/selecting changed database');
  if(shots)await page.screenshot({path:path.join(shots,`approved-card-${theme}-${width}.png`),fullPage:width!==1366});
  report.push({case:'actual-card',theme,width,realTotals:true,approvedVertices:true,keyboard:true,inspect:true,capacity2000:true,noOverflow:true,maxContexts:await page.evaluate(()=>window.__maxContexts)});
  await page.close();current=undefined;
 }
 {
  const page=await open();await ready(page);let state=await inventory(page);const before=totals(state),blue=state.spools[1];
  await selected(page).getByLabel('Выбрать отдельную катушку',{exact:true}).selectOption(blue.id);
  await selected(page).getByLabel('Выбрать свой цвет пластика',{exact:true}).fill('#20b784');
  await page.waitForFunction(id=>window.__inventory().spools.find(s=>s.id===id).color==='#20b784',blue.id);
  await selected(page).getByLabel('Поверхность пластика',{exact:true}).selectOption('matte');
  await page.waitForFunction(id=>window.__inventory().spools.find(s=>s.id===id).finish==='matte',blue.id);
  assert.deepEqual(totals(await inventory(page)),before);
  assert.equal(await page.getByTestId(`filament-spool-${blue.id}`).getByRole('img').getAttribute('data-filament-finish'),'matte');
  await selected(page).getByRole('button',{name:'Остаток и цвет',exact:true}).click();
  await page.locator('form').getByLabel(/^Остаток пластика, кг/).fill('1,25');
  await page.locator('form').getByRole('button',{name:'Сохранить',exact:true}).click();await page.locator('form').waitFor({state:'detached'});
  state=await inventory(page);assert.equal(state.spools[1].remainingWeight,1250);await assertTotals(page,state);
  await page.reload();await ready(page);assert.deepEqual(await inventory(page),state,'Appearance and corrected mass lost after restart');
  await selected(page).getByRole('button',{name:'Сменить пластик',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'Заменить пластик',exact:true});
  await dialog.getByRole('radio',{name:/Синяя PETG/}).check();await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
  assert.deepEqual(await inventory(page),state,'Cancel changed inventory');
  await selected(page).getByRole('button',{name:'Сменить пластик',exact:true}).click();dialog=page.getByRole('dialog',{name:'Заменить пластик',exact:true});
  await dialog.getByRole('radio',{name:/Синяя PETG/}).check();
  await page.evaluate(()=>{window.__fault.commit=true});await dialog.getByRole('button',{name:'Установить катушку',exact:true}).click();
  await dialog.getByRole('alert').waitFor();assert.deepEqual(await inventory(page),state,'Failed swap lost stock or binding');
  await page.evaluate(()=>{window.__fault.commit=false});await dialog.getByRole('button',{name:'Установить катушку',exact:true}).click();await dialog.waitFor({state:'detached'});
  const swapped=await inventory(page);assert.equal(await selected(page).getByLabel('Выбрать отдельную катушку',{exact:true}).inputValue(),blue.id,'Selection must follow the newly mounted spool');assert.deepEqual(totals(swapped),totals(state));assert.equal(swapped.spools[0].printerId,undefined);assert.equal(swapped.spools[1].printerId,'printer-one');
  await page.reload();await ready(page);assert.deepEqual(await inventory(page),swapped,'Atomic swap lost after restart');
  await selected(page).getByLabel('Выбрать отдельную катушку',{exact:true}).selectOption(swapped.spools[1].id);
  await selected(page).getByRole('button',{name:'Сменить пластик',exact:true}).click();dialog=page.getByRole('dialog',{name:'Заменить пластик',exact:true});
  await dialog.getByRole('radio',{name:/Полная ABS/}).check();
  await page.evaluate(async()=>{const s=window.__inventory();await window.__dispatch({type:'bind-printer',printerId:'printer-one',material:'PLA',spoolId:s.spools[0].id})});
  const changed=await inventory(page);await dialog.getByRole('button',{name:'Установить катушку',exact:true}).click();
  await dialog.getByRole('alert').filter({hasText:'уже изменён'}).waitFor();assert.deepEqual(await inventory(page),changed,'Stale dialog overwrote a newer assignment');
  await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
  await page.getByLabel('Расположение катушек',{exact:true}).selectOption('empty');await ready(page);
  const emptyVertices=Number(await selected(page).locator('canvas').getAttribute('data-vertices'));assert.ok(emptyVertices<1081728);
  if(shots)await page.screenshot({path:path.join(shots,'approved-empty.png')});
  await page.getByLabel('Расположение катушек',{exact:true}).selectOption('all');await selected(page).getByLabel('Выбрать отдельную катушку',{exact:true}).selectOption(swapped.spools[2].id);
  assert.ok(Number(await selected(page).locator('canvas').getAttribute('data-vertices'))>emptyVertices);
  await assertTotals(page,await inventory(page));
  report.push({case:'persistence-swap-conflict',appearance:true,manualCorrection:true,restart:true,cancel:true,rollback:true,staleAssignmentRejected:true,emptyFullGeometry:true});await page.close();current=undefined;
 }
 {
  const page=await open();await ready(page);const before=await inventory(page);
  await selected(page).locator('canvas').evaluate(canvas=>canvas.getContext('webgl').getExtension('WEBGL_lose_context').loseContext());
  await viewer(page).getByRole('button',{name:'Повторить 3D-просмотр',exact:true}).waitFor();
  assert.equal(await viewer(page).getByRole('img').getAttribute('data-filament-color'),before.spools[0].color);
  await viewer(page).getByRole('button',{name:'Повторить 3D-просмотр',exact:true}).click();await ready(page);
  await page.setViewportSize({width:390,height:1000});assert.equal(await page.locator('body').evaluate(e=>e.scrollWidth>innerWidth+1),false);
  for(let i=0;i<3;i++){await page.getByRole('textbox',{name:'Найти катушку',exact:true}).fill('нет такой катушки');await viewer(page).waitFor({state:'detached'});await page.getByRole('button',{name:'Очистить поиск',exact:true}).click();await ready(page)}
  assert.ok(await page.evaluate(()=>window.__maxContexts<=2));assert.ok(await page.evaluate(()=>window.__contexts.filter(o=>!o.gl.isContextLost()).length<=2));
  await page.waitForFunction(()=>window.__thumbnailStats().generated>=2,null,{timeout:60000});
  assert.ok(await page.locator('[data-spool-thumbnail] > img').count()>0);assert.ok(await page.evaluate(()=>window.__thumbnailStats().cached<=64));assert.equal(await page.locator('[data-spool-thumbnail] canvas').count(),0);
  assert.deepEqual(await inventory(page),before);
  report.push({case:'gpu-lifecycle',contextLossFallback:true,retry:true,repeatedUnmounts:true,resize:true,boundedCache:true,maxContexts:await page.evaluate(()=>window.__maxContexts)});await page.close();current=undefined;
 }
 {
  const page=await open('dark',390,'&role=viewer',true);const state=await inventory(page);
  await viewer(page).getByRole('button',{name:'Повторить 3D-просмотр',exact:true}).waitFor();
  assert.equal(await selected(page).getByLabel('Поверхность пластика',{exact:true}).isDisabled(),true);
  assert.equal(await selected(page).getByRole('button',{name:'Остаток и цвет',exact:true}).isDisabled(),true);
  await assertTotals(page,state);assert.deepEqual(await inventory(page),state);
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.command==='filament_inventory_commit').length),0);
  if(shots)await page.screenshot({path:path.join(shots,'approved-no-webgl.png')});
  report.push({case:'no-webgl-viewer',correctColor:true,readableMass:true,noWrites:true,roleEnforced:true});await page.close();current=undefined;
 }
 assert.deepEqual(errors,[]);
 const result={passed:report.length,report,runtimeErrors:errors,scope:'Real React components/reducer/store; native SQLite boundary emulated. Chromium software WebGL. Windows/GPU and installer not tested.'};
 if(shots)fs.writeFileSync(path.join(shots,'approved-integration-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}catch(error){
 console.error('APPROVED_FILAMENT_FAILURE',String(error));if(current&&!current.isClosed()){console.error((await current.locator('body').innerText()).slice(0,3000));if(shots)await current.screenshot({path:path.join(shots,'approved-failure.png')}).catch(()=>{})}throw error;
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());fs.rmSync(out,{recursive:true,force:true})}
