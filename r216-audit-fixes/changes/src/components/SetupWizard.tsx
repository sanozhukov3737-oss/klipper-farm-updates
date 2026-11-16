import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Database, LoaderCircle, Printer, ShieldCheck, TriangleAlert, Wifi } from 'lucide-react';
import type { PrinterConfig } from '../types';
import { LanguageSelect, useI18n } from '../i18n';
import appIcon from '../assets/app-icon-v1144.png';
import { MoonrakerClient, type PrinterDetection } from '../lib/moonraker';
import { profileForPreset } from '../lib/printerProfile';
import { applyModelDetection } from '../lib/modelSelection';
import { applyCatalogModel } from '../lib/printerCatalogSelection';
import { appConfirm } from '../lib/appDialogs';
import { secureInvoke } from '../lib/auth';
import { PrinterModelPicker } from './PrinterModelPicker';
import { catalogConnectionHint, catalogModelName, getCatalogModel, type PrinterCatalogModel } from '../lib/printerCatalog';
import catalogStyles from './PrinterModelPicker.module.css';

type ApiKeyValidation={valid:boolean;protocol:'rest'|'websocket';port:number;message:string};

const normalizeHost=(value:string)=>value.trim().replace(/^http:\/\//i,'').replace(/\/$/,'');
const friendlyError=(error:unknown)=>{
 const text=String(error instanceof Error?error.message:error).toLowerCase();
 if(text.includes('401')||text.includes('403')||text.includes('unauthorized')||text.includes('api key'))return 'Moonraker требует API Key. Введите ключ и повторите проверку.';
 if(text.includes('resolve')||text.includes('invalid')||text.includes('address'))return 'Адрес не распознан. Используйте формат 192.168.1.50:7125.';
 if(text.includes('timeout')||text.includes('connect')||text.includes('refused'))return 'Moonraker не отвечает. Проверьте IP, порты 80/7125 и подключение к одной сети.';
 return `Не удалось проверить Moonraker: ${String(error instanceof Error?error.message:error)}`;
};
const confidenceText=(value:PrinterDetection['confidence'])=>value==='high'?'высокая':value==='medium'?'средняя':value==='low'?'низкая':'недостаточно данных';

export function SetupWizard({onFinish,onAdd}:{onFinish:()=>void;onAdd:(cfg:PrinterConfig)=>void|Promise<void>}){
 const {t}=useI18n();
 const [step,setStep]=useState(0),[host,setHost]=useState(''),[name,setName]=useState(''),[apiKey,setApiKey]=useState('');
 const [automaticName,setAutomaticName]=useState('');
 const [catalogModelId,setCatalogModelId]=useState<string>(),[choosingModel,setChoosingModel]=useState(true),[adding,setAdding]=useState(false);
 const requestGeneration=useRef(0),nameRevision=useRef(0);
 useEffect(()=>()=>{requestGeneration.current++},[]);
 const [checking,setChecking]=useState(false),[detected,setDetected]=useState<PrinterDetection>(),[error,setError]=useState('');
 const catalog=getCatalogModel(catalogModelId);
 const invalidateVerification=()=>{requestGeneration.current++;setDetected(undefined);setChecking(false);setError('')};
 const chooseModel=(entry?:PrinterCatalogModel)=>{
  invalidateVerification();setCatalogModelId(entry?.id);setChoosingModel(false);
  if(!name.trim()||name===automaticName){const next=entry?catalogModelName(entry):'';setName(next);setAutomaticName(next)}
 };
 const finish=()=>{localStorage.setItem('klipper-setup-v07','done');onFinish()};
 const verify=async()=>{
  const normalized=normalizeHost(host);if(!normalized){setError('Введите IP-адрес и порт Moonraker.');return}
  const generation=++requestGeneration.current,nameVersion=nameRevision.current;
  setChecking(true);setDetected(undefined);setError('');
  try{
   const key=apiKey.trim();
   if(key){const validation=await secureInvoke<ApiKeyValidation>('validate_moonraker_api_key',{host:normalized,apiKey:key});if(generation!==requestGeneration.current)return;if(!validation.valid)throw new Error(validation.message||'Moonraker отклонил API Key')}
   const result=await new MoonrakerClient({id:'setup-check',name:name.trim()||'Klipper Printer',host:normalized,apiKey:key||undefined}).detect();
   if(generation!==requestGeneration.current)return;
   setHost(normalized);setDetected(result);
   if(nameVersion===nameRevision.current&&!catalog&&(!name.trim()||name===automaticName)&&result.decision==='confirmed'&&result.model!=='custom'){setName(result.name);setAutomaticName(result.name)}
  }catch(e){if(generation===requestGeneration.current)setError(friendlyError(e))}finally{if(generation===requestGeneration.current)setChecking(false)}
 };
 const add=async()=>{
  if(!detected?.reachable||adding)return;
  const generation=requestGeneration.current;setAdding(true);
  try{
   let confirmProbable=false;
   if(detected.decision==='probable'&&detected.model!=='custom')confirmProbable=await appConfirm(`Программа предполагает модель «${detected.name}», но уверенность средняя. Применить этот профиль? Без подтверждения будет сохранён безопасный универсальный профиль.`,{title:'Подтверждение модели',confirmLabel:'Да, применить профиль'});
   if(generation!==requestGeneration.current)return;
   const base:PrinterConfig={id:crypto.randomUUID(),name:name.trim()||(catalog?catalogModelName(catalog):detected.name),nameSource:!name.trim()||name===automaticName?'automatic':'custom',host:normalizeHost(host),catalogModelId:catalog?.id,apiKey:apiKey.trim()||undefined,profile:profileForPreset('custom'),modelSelection:{mode:'automatic',selectedPreset:'custom',source:'automatic'}};
   const configured=applyModelDetection(base,detected,confirmProbable);
   await onAdd(catalog?applyCatalogModel(configured,catalog):configured);if(generation===requestGeneration.current)setStep(2);
  }catch(e){if(generation===requestGeneration.current)setError(String(e instanceof Error?e.message:e))}finally{if(generation===requestGeneration.current)setAdding(false)}
 };
 return <div className={`wizard ${step===1?catalogStyles.wizardCatalog:''}`}><section className="wizardShell">
  <aside className="wizardAside"><img src={appIcon} alt="Klipper Farm"/><h1>Klipper Farm</h1><p>Локальный центр управления вашей фермой 3D‑принтеров.</p><div className="wizardSteps">{['Добро пожаловать','Подключение','Готово'].map((x,i)=><div key={x} className={i===step?'active':i<step?'done':''}><span>{i<step?'✓':i+1}</span><b>{x}</b></div>)}</div><small>Версия 1.14.5 · Transactional Core V13</small></aside>
  <main className="wizardMain"><header><div><span>ПЕРВЫЙ ЗАПУСК</span><b>Шаг {step+1} из 3</b></div><LanguageSelect compact/></header>
   {step===0&&<div className="wizardPage"><div className="wizardHeroIcon"><ShieldCheck/></div><h2>{t('setupIntro')}</h2><p>{t('setupIntroText')}</p><div className="wizardBenefits"><div><Wifi/><b>Локальная сеть</b><span>Без облачного аккаунта</span></div><div><Printer/><b>Несколько принтеров</b><span>Единая панель фермы</span></div><div><Database/><b>Данные на компьютере</b><span>История и настройки локально</span></div></div><button className="primary wizardNext" onClick={()=>setStep(1)}>{t('start')} →</button></div>}
   {step===1&&<div className="wizardPage wizardConnect">
    {choosingModel?<>
     <PrinterModelPicker selectedId={catalogModelId} onSelect={chooseModel} compact/>
     <div className="wizardActions"><button onClick={()=>{invalidateVerification();setStep(2)}}>{t('skip')}</button><button className="primary" onClick={()=>setChoosingModel(false)}>Продолжить {catalog?'с выбранной моделью':'с автоопределением'} →</button></div>
    </>:<>
     <div className="wizardHeroIcon"><Wifi/></div><h2>Подключите первый принтер</h2>
     <p>{catalog?catalogModelName(catalog):'Автоматическое определение модели'} · {catalog?catalogConnectionHint(catalog):'Требуется доступный Klipper/Moonraker'}</p>
     <button type="button" disabled={adding} onClick={()=>{invalidateVerification();setChoosingModel(true)}}>Выбрать другую модель</button>
     <p>{t('hostHelp')} Для K1C можно указать только IP — приложение проверит WebSocket на портах 80 и 7125.</p>
     <label>Название принтера<input disabled={adding} value={name} onChange={e=>{nameRevision.current++;setAutomaticName('');setName(e.target.value)}} placeholder="Определится автоматически"/></label>
     <label>Адрес Moonraker<input disabled={adding} value={host} onChange={e=>{setHost(e.target.value);invalidateVerification()}} placeholder="192.168.1.109 или 192.168.1.109:7125"/></label>
     <label>API Key — если включена авторизация<input disabled={adding} type="password" value={apiKey} onChange={e=>{setApiKey(e.target.value);invalidateVerification()}} placeholder="Можно оставить пустым"/></label>
     <small>Для поддерживаемой выбранной модели применяется её рабочий профиль. Проверка подключения уточняет доступные функции.</small>
     {checking&&<div className="wizardCheck checking"><LoaderCircle/> Проверяем Moonraker, конфигурацию и цифровой отпечаток…</div>}
     {detected&&<div className={`wizardCheck ${detected.ready?'ok':'warn'}`}><CheckCircle2/><div>
      <b>{detected.ready?'Подключение работает':'Moonraker доступен — Klipper ещё не готов'}</b>
      <span>{detected.status!=='matched'||detected.model==='custom'?detected.status==='ambiguous'?'Модель неоднозначна — будет сохранён безопасный пользовательский профиль':'Надёжная модель не определена — будет сохранён пользовательский профиль':`${detected.name} · уверенность: ${confidenceText(detected.confidence)} · ${detected.score} баллов`} · Klipper: {detected.klippyState} · {detected.latency} мс · проверок {detected.probeCoverage.successful}/{detected.probeCoverage.total}</span>
      {detected.probeWarnings.length>0&&<small>Неполный снимок: {detected.probeWarnings.join(', ')}. Принтер можно добавить — проверка повторится автоматически.</small>}
     </div></div>}
     {error&&<div className="wizardCheck error"><TriangleAlert/><span>{error}</span></div>}
     <div className="wizardActions"><button disabled={adding} onClick={()=>{invalidateVerification();setStep(2)}}>{t('skip')}</button><div>
      <button disabled={checking||adding||!host.trim()} onClick={verify}>{checking?'Проверка…':'Проверить подключение'}</button>
      <button className="primary" disabled={checking||adding||!detected?.reachable} onClick={add}>{adding?'Добавление…':'Добавить принтер'}</button>
     </div></div>
    </>}
   </div>}
   {step===2&&<div className="wizardPage"><div className="wizardHeroIcon success"><CheckCircle2/></div><h2>{t('done')}</h2><p>Klipper Farm готов к работе. Принтеры, очередь, камеры и статистика доступны на основной панели.</p><button className="primary wizardNext" onClick={finish}>{t('openFarm')} →</button></div>}
  </main>
 </section></div>;
}
