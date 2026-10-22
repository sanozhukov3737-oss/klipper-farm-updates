import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]??process.cwd()),out=fs.mkdtempSync(path.join(os.tmpdir(),'kf-r136-ui-'));
const proof=path.resolve(process.env.KF_R136_UI_PROOF_DIR??path.join(root,'R136-UI-proof'));
const {build}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')).href);
const modulePath=process.env.PLAYWRIGHT_MODULE_PATH??path.join(root,'ui-tests/node_modules/playwright/index.mjs');
const {chromium}=await import(modulePath.startsWith('file:')?modulePath:pathToFileURL(modulePath).href);
let browserPath=process.env.CHROMIUM_EXECUTABLE,args=['--no-sandbox','--disable-dev-shm-usage'];
if(process.env.KF_R136_SPARTICUZ_MODULE){
 const {default:sparticuz}=await import(pathToFileURL(process.env.KF_R136_SPARTICUZ_MODULE).href);
 browserPath=await sparticuz.executablePath();args=sparticuz.args.filter(arg=>!arg.includes('single-process')&&!arg.includes('disable-web-security'));
}
fs.mkdirSync(proof,{recursive:true});
await build({root,logLevel:'error',build:{outDir:out,emptyOutDir:true,rollupOptions:{input:path.join(root,'ui-tests/r136-review.html')}}});
const server=http.createServer((req,res)=>{
 const file=path.resolve(out,new URL(req.url,'http://localhost').pathname.slice(1));
 if(!file.startsWith(out+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm'})[path.extname(file)]??'application/octet-stream');fs.createReadStream(file).pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,executablePath:browserPath,args});
const report=[],errors=[];let current;
const coolBlue=color=>{const rgb=color.match(/[0-9.]+/g)?.map(Number)??[];return rgb.length>=3&&rgb[2]>rgb[0]&&rgb[2]>rgb[1]};
const open=async(page,theme)=>{
 await page.goto(`${origin}/ui-tests/r136-review.html?r126=files&r136=review`);
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid^="live-printer-"]').length===7);
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 const badge=await page.locator('.kfCyberEyebrow.mode-cache-only').evaluate(e=>getComputedStyle(e).color);assert.ok(coolBlue(badge),'Waiting LAN badge is not blue: '+badge);
};
const cost=async page=>{
 await page.locator('.kfSidebar nav').getByRole('button',{name:'Файлы',exact:true}).click();
 await page.getByRole('button',{name:'Себестоимость',exact:true}).click();
 await page.getByRole('spinbutton',{name:'Электричество за кВт⋅ч',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('input[aria-label="Электричество за кВт⋅ч"]')?.value==='6.5');
};
try{
 for(const theme of ['dark','light'])for(const [width,height,scale] of [[1536,960,1.25],[1366,900,1],[910,900,1],[390,844,1]]){
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:scale,locale:'ru-RU'});current=page;page.on('pageerror',e=>errors.push(e.message));await open(page,theme);await cost(page);
  await page.waitForFunction(()=>document.querySelector('[aria-label="Стоимость текущей библиотеки"] strong')?.textContent?.replace(/\s/g,'')==='5584,00');
  const fit=await page.locator('input[aria-label],section[aria-label="Параметры расчёта себестоимости"],section[aria-label="Стоимость текущей библиотеки"]').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,label:e.getAttribute('aria-label'),x:r.x,right:r.right,overflow:e.scrollWidth>e.clientWidth+2,radius:parseFloat(s.borderRadius),clip:s.clipPath}}));
  assert.ok(fit.every(e=>e.x>=0&&e.right<=width+1&&!e.overflow),JSON.stringify(fit));
  assert.ok(fit.filter(e=>e.tag==='SECTION').every(e=>e.radius>=14&&e.clip==='none'));
  assert.equal(await page.locator('body').evaluate(e=>e.scrollWidth>innerWidth+1),false);
  if(width===1536||width===390)await page.screenshot({path:path.join(proof,`cost-${theme}-${width}.png`),fullPage:width===390});
  report.push({view:'cost',theme,width,scale,passed:true});await page.close();current=undefined;
 }
 const page=await browser.newPage({viewport:{width:1536,height:960},deviceScaleFactor:1.25,locale:'ru-RU'});current=page;page.on('pageerror',e=>errors.push(e.message));await open(page,'dark');await cost(page);
 await page.getByRole('spinbutton',{name:'Средняя мощность принтера, Вт',exact:true}).fill('500');
 await page.getByRole('spinbutton',{name:'Работа оператора за час',exact:true}).fill('100');
 await page.waitForFunction(()=>document.querySelector('[aria-label="Стоимость текущей библиотеки"] strong')?.textContent?.replace(/\s/g,'')==='15340,00');
 await page.waitForFunction(()=>window.__farmStartup.state().database['production.cost']?.laborPerHour===100);
 const before=await page.evaluate(()=>({cost:window.__farmStartup.state().database['production.cost'],config:window.__farmStartup.state().database['printers.config']}));
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll('[data-testid^="live-printer-"]').length===7);await page.locator('.kfSidebar nav').getByRole('button',{name:'Файлы',exact:true}).click();await page.getByRole('button',{name:'Себестоимость',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('input[aria-label="Работа оператора за час"]')?.value==='100');
 assert.equal(await page.getByRole('spinbutton',{name:'Средняя мощность принтера, Вт',exact:true}).inputValue(),'500');
 assert.deepEqual(await page.evaluate(()=>window.__farmStartup.state().database['production.cost']),before.cost);
 assert.deepEqual(await page.evaluate(()=>window.__farmStartup.state().database['printers.config']),before.config);
 report.push({view:'cost-recalculate-and-reopen',passed:true,expectedTotal:15340,printerConfigPreserved:true});await page.close();current=undefined;
 const models=[['printer-1','ender-v3-ke-integrated-v2'],['printer-5','creality-k1c-clean-v1144'],['printer-6','creality-k1-max-neon-v114']];
 if(!process.env.KF_REVIEW_COST_ONLY)for(const theme of ['dark','light']){
  const page=await browser.newPage({viewport:{width:1536,height:960},deviceScaleFactor:1.25,locale:'ru-RU'});current=page;page.on('pageerror',e=>errors.push(e.message));await open(page,theme);
  for(const route of ['dashboard','printers']){
   if(route==='printers')await page.locator('.kfSidebar nav').getByRole('button',{name:'Принтеры',exact:true}).click();
   for(const [id,asset] of models){
    const card=page.getByTestId(`live-printer-${id}`),img=card.getByTestId('printer-artwork');await img.waitFor();
    await img.evaluate(e=>e.decode());const details=await img.evaluate(e=>({url:e.currentSrc,width:e.naturalWidth,height:e.naturalHeight,fit:getComputedStyle(e).objectFit,filter:getComputedStyle(e).filter}));
    assert.ok(details.url.includes(asset),id+' wrong photo');assert.equal(details.width,1280);assert.equal(details.height,1280);assert.equal(details.fit,'contain');
    report.push({view:route,theme,id,...details,passed:true});
   }
   const colors=await page.locator('[data-tone="warning"][data-testid^="live-printer-"]').evaluateAll(cards=>cards.map(card=>({state:getComputedStyle(card.querySelector('[data-tone="warning"]')).color,stale:getComputedStyle(card.querySelector('[data-freshness="stale"] b')).color,footer:getComputedStyle(card.querySelector('footer i')).backgroundColor,line:getComputedStyle(card,'::before').backgroundColor})));
   assert.ok(colors.length>=3);for(const row of colors)for(const value of Object.values(row))assert.ok(coolBlue(value),'Non-blue card accent: '+JSON.stringify(row));
   await page.screenshot({path:path.join(proof,`photos-${route}-${theme}.png`)});
  }
  for(const [id,asset] of models){
   await page.getByTestId(`live-printer-${id}`).getByRole('button',{name:/^Открыть /}).click();
   const img=page.locator('.kfDetailHeroStage>img');await img.waitFor({timeout:10000});await img.evaluate(e=>e.decode());
   const details=await img.evaluate(e=>({url:e.currentSrc,width:e.naturalWidth,height:e.naturalHeight,fit:getComputedStyle(e).objectFit}));
   assert.ok(details.url.includes(asset));assert.equal(details.width,1280);assert.equal(details.fit,'contain');report.push({view:'detail',theme,id,...details,passed:true});
   await page.screenshot({path:path.join(proof,`photo-detail-${id}-${theme}.png`)});
   await page.getByRole('button',{name:'К списку принтеров',exact:true}).click();
  }
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('[data-testid^="live-printer-"]').length===7);
  for(const [id,asset] of models)assert.ok((await page.getByTestId(`live-printer-${id}`).getByTestId('printer-artwork').getAttribute('src')).includes(asset));
  report.push({view:'photos-reopen',theme,passed:true});await page.close();current=undefined;
 }
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(proof,'r136-review-report.json'),JSON.stringify({passed:report.length,report,runtimeErrors:errors,syntheticPreviewData:true,physicalPrintersTested:false,windowsInstallerBuilt:false,blueAccentsVerified:true},null,2)+'\n');
 console.log(JSON.stringify({passed:report.length,runtimeErrors:errors,proof}));
}catch(error){if(current)await current.screenshot({path:path.join(proof,'failure.png'),fullPage:true});console.error(error);process.exitCode=1}
finally{await browser.close();server.close();fs.rmSync(out,{recursive:true,force:true})}
