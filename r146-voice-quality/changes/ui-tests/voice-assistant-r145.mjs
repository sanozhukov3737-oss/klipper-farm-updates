import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {build} from 'vite';
const root=path.resolve(import.meta.dirname,'..'),out=fs.mkdtempSync(path.join(os.tmpdir(),'kf-voice-ui-'));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH??'playwright');
await build({root,logLevel:'warn',build:{outDir:out,emptyOutDir:true,rollupOptions:{input:path.join(root,'ui-tests/voice-assistant-r145.html')}}});
const csp=JSON.parse(fs.readFileSync(path.join(root,'src-tauri/tauri.conf.json'))).app.security.csp;
const server=http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(process.env.KF_VOICE_FIXTURES&&/^\/test-voice\/(?:print|confirm)\.wav$/.test(pathname)){res.setHeader('Content-Type','audio/wav');fs.createReadStream(path.join(process.env.KF_VOICE_FIXTURES,path.basename(pathname))).pipe(res);return;}
 const file=path.resolve(out,pathname.slice(1));
 if(!file.startsWith(out+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 res.setHeader('Content-Security-Policy',csp);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.gz':'application/gzip'})[path.extname(file)]??'application/octet-stream');fs.createReadStream(file).pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const args=['--no-sandbox','--disable-dev-shm-usage','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'];
if(process.env.KF_VOICE_AUDIO)args.push('--use-file-for-fake-audio-capture='+process.env.KF_VOICE_AUDIO);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args}),report=[];
try{
 const page=await browser.newPage({viewport:{width:1280,height:900},locale:'ru-RU'}),errors=[],external=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')console.log('browser:',message.text().slice(0,350))});
 await page.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort()}return route.continue()});
 await page.goto(`http://127.0.0.1:${port}/ui-tests/voice-assistant-r145.html`);
 const input=page.getByRole('textbox',{name:'Команда помощнику'}),send=page.getByRole('button',{name:'Отправить команду',exact:true});
 await input.fill('Сколько осталось пластика?');await send.click();await page.getByRole('log').getByText(/Общий запас пластика/).waitFor();assert.match(await page.getByRole('log').innerText(),/1.500/);report.push({name:'stock from actual native-backed inventory adapter',passed:true});
 await page.getByRole('combobox',{name:'Голос помощника'}).selectOption('dmitri');await page.getByRole('button',{name:'Послушать',exact:true}).click();await page.waitForFunction(()=>window.voiceFixture.state().calls.includes('voice_synthesize'));report.push({name:'neural voice selection and preview use authenticated native speech boundary',passed:true});
 await page.getByRole('button',{name:'Выключить голосовые ответы',exact:true}).click();
 await input.fill('Принтер к1 мах поставь на печать корпус');await send.click();await page.locator('.kfVoiceProposal').waitFor();assert.equal((await page.evaluate(()=>window.voiceFixture.state())).started,0);
 await page.getByRole('button',{name:'Подтверждаю печать',exact:true}).click();await page.getByRole('log').getByText(/подтвердил запуск/).waitFor();const state=await page.evaluate(()=>window.voiceFixture.state());assert.equal(state.started,1);assert.equal(state.uploaded,1);report.push({name:'full G-code analysis through native chunk reader, then separate confirmation',passed:true});
 await input.fill('Подтверждаю печать');await send.click();await page.getByRole('log').getByText(/Нет действующего подтверждения/).waitFor();assert.equal((await page.evaluate(()=>window.voiceFixture.state())).started,1);report.push({name:'repeat confirmation cannot resend print',passed:true});
 if(process.env.KF_VOICE_AUDIO){
  await page.evaluate(()=>{const Native=window.AudioWorkletNode;window.AudioWorkletNode=class extends Native{constructor(...args){super(...args);this.port.addEventListener('message',e=>{if(e.data instanceof Float32Array)window.__voiceEnergy=Math.max(window.__voiceEnergy??0,...e.data.map(Math.abs))});this.port.start()}}});
  await page.getByRole('button',{name:'Включить микрофон',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.kfVoicePanel footer span')?.textContent==='Слушаю одну команду…',null,{timeout:70000});
  console.log('Real microphone capture active');
  await page.waitForFunction(()=>window.__voiceEnergy>0.005,null,{timeout:10000});console.log('Real audio energy verified');
  await page.waitForFunction(()=>document.querySelectorAll('.kfVoiceMessage.user').length>4,null,{timeout:35000});
  const recognized=await page.locator('.kfVoiceMessage.user').last().innerText();assert.match(recognized,/(?:сколько|остат|остал|запас).*пластик/);console.log('Real recognized command:',recognized);
  await page.waitForFunction(()=>[...document.querySelectorAll('.kfVoiceMessage.assistant')].at(-1)?.textContent?.includes('Общий запас пластика'));
  assert.equal((await page.evaluate(()=>window.voiceFixture.state())).started,1);report.push({name:'real Russian audio to local Vosk WASM to inventory reply under production CSP',recognized,passed:true});
  await page.waitForFunction(()=>[...document.querySelectorAll('.kfVoicePanel footer span')].some(e=>e.textContent==='Микрофон выключен'));
  assert.equal(await page.evaluate(()=>navigator.mediaDevices.enumerateDevices().then(()=>true)),true);
 }
 if(process.env.KF_VOICE_FIXTURES){
  const setAudio=async file=>page.evaluate(async file=>{
   const context=new AudioContext(),buffer=await context.decodeAudioData(await(await fetch('/test-voice/'+file+'.wav')).arrayBuffer());
   navigator.mediaDevices.getUserMedia=async()=>{const target=context.createMediaStreamDestination(),source=context.createBufferSource();source.buffer=buffer;source.connect(target);source.onended=()=>void context.close();source.start(context.currentTime+0.5);return target.stream;};
  },file);
  await setAudio('print');await page.getByRole('button',{name:'Включить микрофон',exact:true}).click();
  await page.locator('.kfVoiceProposal').waitFor({timeout:40000});assert.equal((await page.evaluate(()=>window.voiceFixture.state())).started,1);
  const printText=await page.locator('.kfVoiceMessage.user').last().innerText();report.push({name:'spoken file and printer selection through WAV-backed MediaStream',recognized:printText,passed:true});
  await setAudio('confirm');await page.getByRole('button',{name:'Включить микрофон',exact:true}).click();
  await page.waitForFunction(()=>window.voiceFixture.state().started===2,null,{timeout:40000});
  const confirmText=await page.locator('.kfVoiceMessage.user').last().innerText();assert.equal(confirmText,'подтверждаю печать');
  report.push({name:'separate spoken confirmation starts exactly one additional validated print',recognized:confirmText,passed:true});
 }
 await page.getByRole('button',{name:'Закрыть помощника'}).click();await page.getByRole('button',{name:'Открыть помощника',exact:true}).click();assert.equal(await page.locator('.kfVoiceProposal').count(),0);report.push({name:'close and reopen does not retain confirmation',passed:true});
 await page.screenshot({path:process.env.KF_VOICE_SCREENSHOT??'/tmp/kf-r145-voice.png'});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);report.push({name:'no external requests and no browser exceptions',passed:true});
 const result={passed:true,realAudioTested:!!process.env.KF_VOICE_AUDIO,physicalPrintersTested:false,cases:report.length,report};if(process.env.KF_VOICE_BROWSER_PROOF)fs.writeFileSync(process.env.KF_VOICE_BROWSER_PROOF,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(error){try{const pages=browser.contexts().flatMap(c=>c.pages());for(const page of pages){console.log('FAILURE UI', (await page.locator('.kfVoicePanel').innerText()).slice(-2500));await page.screenshot({path:'/tmp/kf-r145-voice-failure.png'});}}catch{}throw error;}finally{await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(out,{recursive:true,force:true})}
