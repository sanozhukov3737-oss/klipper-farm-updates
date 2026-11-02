import {useState} from 'react';
import type {VoiceDiagnosticsSnapshot,VoiceDiagnosticStage} from '../lib/voiceDiagnostics';

const stageNames:Record<VoiceDiagnosticStage,string>={
  'microphone-setup':'Подготовка микрофона и модели',recording:'Запись',recognition:'Распознавание',command:'Обработка команды',semantic:'Понимание свободной речи',search:'Поиск файлов',validation:'Проверка файла',readiness:'Проверка принтера',upload:'Передача файла',launch:'Запуск печати',status:'Проверка запуска','synthesis-wait':'Ожидание озвучки',synthesis:'Подготовка голоса',playback:'Запуск и проигрывание',
};
const outcomeNames={running:'Выполняется',ok:'Ответ получен','needs-input':'Нужно уточнение',error:'Ошибка',cancelled:'Отменено'};
const duration=(milliseconds:number)=>milliseconds<1000?`${milliseconds} мс`:`${(milliseconds/1000).toFixed(1)} с`;
type Props={snapshot:VoiceDiagnosticsSnapshot;onCaptureText:(enabled:boolean)=>void;onClear:()=>void;onExport:()=>string};
export function VoiceDiagnosticsPanel({snapshot,onCaptureText,onClear,onExport}:Props){
  const [exported,setExported]=useState('');
  return <details className="kfVoiceDiagnostics"><summary>Диагностика речи · {snapshot.turns.length}</summary>
    <p>Последние 30 обращений хранятся на этом компьютере для текущего профиля. Звук не сохраняется. Время измеряется во время операции.</p>
    <label><input type="checkbox" checked={snapshot.captureTranscript} onChange={event=>{setExported('');onCaptureText(event.target.checked)}}/>Сохранять текст команд в диагностике</label>
    <p>По умолчанию сохраняются только этапы и время. При выключении текст убирается из открытой истории; сохранённую копию приложение пытается удалить.</p>
    {snapshot.cleanupFailed?<p role="alert">Не удалось удалить предыдущую сохранённую копию. В ней мог остаться текст команд. Повторите очистку истории.</p>:snapshot.storageError&&<p role="status">Не удалось сохранить изменения. Текущие измерения доступны до закрытия приложения.</p>}
    <div className="kfVoiceDiagnosticActions"><button type="button" disabled={!snapshot.turns.length} onClick={()=>setExported(onExport())}>Показать отчёт</button><button type="button" disabled={!snapshot.turns.length&&!snapshot.cleanupFailed} onClick={()=>{setExported('');onClear()}}>Очистить историю</button></div>
    {snapshot.turns.slice(0,10).map(turn=><article key={turn.id}><div><b>{new Date(turn.createdAt).toLocaleTimeString('ru-RU')}</b><span>{outcomeNames[turn.outcome]}</span></div>
      {turn.transcript&&<p className="kfVoiceDiagnosticTranscript">{turn.transcript}</p>}
      {turn.responseMilliseconds!==undefined&&<small>{turn.source==='preview'?'До завершения подготовки озвучки':'До текстового ответа'}: {duration(turn.responseMilliseconds)}</small>}
      <dl>{turn.timings.map((timing,index)=><div key={index}><dt>{stageNames[timing.stage]}{timing.outcome==='cancelled'?' · прервано':timing.outcome==='error'?' · ошибка':''}</dt><dd>{duration(timing.milliseconds)}</dd></div>)}</dl>
      {turn.issue&&<p role="status">{turn.issue.action}</p>}
    </article>)}
    {exported&&<label>Локальный отчёт<textarea aria-label="Локальный отчёт диагностики речи" readOnly value={exported} rows={7}/></label>}
  </details>;
}
export const voiceDiagnosticStageLabel=(stage:VoiceDiagnosticStage)=>stageNames[stage];
