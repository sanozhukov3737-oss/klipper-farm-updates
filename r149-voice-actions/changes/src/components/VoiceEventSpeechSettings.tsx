import { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { VOICE_EVENT_SPEECH_CHANGED, saveVoiceEventSpeechPreferences, voiceEventSpeechPreferences } from '../lib/voiceEventSpeech';

/** Spoken announcements for real print outcomes; each switch is independent. */
export function VoiceEventSpeechSettings() {
  const [settings, setSettings] = useState(voiceEventSpeechPreferences);
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setSettings(voiceEventSpeechPreferences());
    window.addEventListener(VOICE_EVENT_SPEECH_CHANGED, update); window.addEventListener('storage', update);
    return () => { window.removeEventListener(VOICE_EVENT_SPEECH_CHANGED, update); window.removeEventListener('storage', update); };
  }, []);
  const save = (value: typeof settings) => {
    try { setSettings(saveVoiceEventSpeechPreferences(value)); setError(''); }
    catch { setError('Не удалось сохранить настройку. Повторите изменение.'); }
  };
  return <section className="runtimeCard" aria-label="Голосовые объявления о печати"><Megaphone/><div style={{ gridColumn: '2 / -1', justifySelf: 'stretch' }}>
    <h3>Голосовые объявления</h3><p>Ксения проговорит итог печати и проблемы, даже если помощник закрыт. Озвучивается, пока приложение работает, в том числе в трее при включённом фоновом режиме.</p>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
      <label className="switch"><input type="checkbox" checked={settings.complete} onChange={event => save({ ...settings, complete: event.target.checked })}/>Печать завершена</label>
      <label className="switch"><input type="checkbox" checked={settings.error} onChange={event => save({ ...settings, error: event.target.checked })}/>Ошибки принтера</label>
      <label className="switch"><input type="checkbox" checked={settings.runout} onChange={event => save({ ...settings, runout: event.target.checked })}/>Закончился пластик</label>
    </div>
    <p>Объявление короткое и одноразовое; повторов и озвучки каждой потери связи нет.</p>
    {error && <p role="alert">{error}</p>}
  </div></section>;
}
