import { diagnosticWarning } from './diagnosticLog';

export type NotificationSoundEvent = 'complete' | 'error' | 'runout' | 'offline';
export type NotificationSoundPreferences = { enabled: boolean; volume: number; events: Record<NotificationSoundEvent, boolean> };
export const NOTIFICATION_SOUND_KEY = 'klipper-notification-sound-v1';
export const NOTIFICATION_SOUND_CHANGED = 'klipper-notification-sound-changed';
export const SOUND_DEFAULTS: NotificationSoundPreferences = { enabled: true, volume: 0.65, events: { complete: true, error: true, runout: true, offline: false } };
const notes: Record<NotificationSoundEvent, number[]> = { complete: [523.25, 659.25, 783.99], error: [440, 349.23, 261.63], runout: [659.25, 659.25, 440, 440], offline: [329.63, 261.63] };

function normalize(raw: unknown): NotificationSoundPreferences {
  // Настройки приходят из localStorage: там может лежать что угодно, включая
  // строку или null. Читаем поля только после проверки, что это объект, иначе
  // любое повреждённое значение роняло бы звук целиком.
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const events = value.events && typeof value.events === 'object' ? value.events as Record<string, unknown> : {};
  return { enabled: typeof value.enabled === 'boolean' ? value.enabled : SOUND_DEFAULTS.enabled,
    volume: typeof value?.volume === 'number' && Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : SOUND_DEFAULTS.volume,
    events: Object.fromEntries(Object.keys(notes).map(key => [key, typeof events[key] === 'boolean' ? events[key] : SOUND_DEFAULTS.events[key as NotificationSoundEvent]])) as NotificationSoundPreferences['events'] };
}
export function notificationSoundPreferences(): NotificationSoundPreferences {
  try { return normalize(JSON.parse(localStorage.getItem(NOTIFICATION_SOUND_KEY) ?? 'null')); }
  catch { return normalize(undefined); }
}
export function saveNotificationSoundPreferences(value: NotificationSoundPreferences) {
  const settings = normalize(value);
  localStorage.setItem(NOTIFICATION_SOUND_KEY, JSON.stringify(settings));
  if (!settings.enabled || settings.volume === 0) stopNotes();
  window.dispatchEvent(new Event(NOTIFICATION_SOUND_CHANGED));
  return settings;
}

let context: AudioContext | undefined;
let installations = 0;
let lastToneAt = -Infinity;
let lastToneEvent: NotificationSoundEvent | undefined;
const played = new Map<string, number>();
const active = new Set<OscillatorNode>();
function stopNotes() { for (const node of active) { try { node.stop(); } catch { /* Already ended. */ } } active.clear(); }
function audioContext() {
  const Constructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return undefined;
  if (!context || context.state === 'closed') context = new Constructor();
  return context;
}
const unlock = () => {
  if (!notificationSoundPreferences().enabled) return;
  try { const audio = audioContext(); if (audio?.state === 'suspended') void audio.resume().catch(() => {}); }
  catch (error) { diagnosticWarning('notifications.audio_unlock', error); }
};
/** Unlock on a real gesture, including the login screen. No continuous loop. */
export function installNotificationSound() {
  if (installations++ === 0) { document.addEventListener('pointerdown', unlock, true); document.addEventListener('keydown', unlock, true); }
  let disposed = false;
  return () => {
    if (disposed) return; disposed = true;
    if (--installations === 0) { document.removeEventListener('pointerdown', unlock, true); document.removeEventListener('keydown', unlock, true); stopNotes(); }
  };
}

/** Called only after the existing notification dedupe, independent of toasts. */
export async function playNotificationSound(event: NotificationSoundEvent, eventKey?: string, test = false): Promise<boolean> {
  let settings = notificationSoundPreferences();
  const now = Date.now();
  const critical = event === 'error' || event === 'runout';
  const rateLimited = () => now - lastToneAt < 500 && !(critical && lastToneEvent !== 'error' && lastToneEvent !== 'runout');
  if (!settings.enabled || settings.volume === 0 || (!test && !settings.events[event])) return false;
  if (!test && ((eventKey && now - (played.get(eventKey) ?? -Infinity) < 60_000) || rateLimited())) return false;
  try {
    const audio = audioContext(); if (!audio) return false;
    if (audio.state === 'suspended') {
      let timer: number | undefined;
      try { await Promise.race([audio.resume(), new Promise<void>(resolve => { timer = window.setTimeout(resolve, 250); })]); }
      finally { window.clearTimeout(timer); }
    }
    if (audio.state !== 'running') return false;
    settings = notificationSoundPreferences();
    if (!settings.enabled || settings.volume === 0 || (!test && !settings.events[event])) return false;
    // Reserve dedupe again after resume: concurrent completions must not pile up.
    if (!test && ((eventKey && now - (played.get(eventKey) ?? -Infinity) < 60_000) || rateLimited())) return false;
    if (critical) stopNotes();
    lastToneAt = now;
    lastToneEvent = event;
    if (eventKey) played.set(eventKey, now);
    for (const [key, at] of played) if (now - at > 60_000) played.delete(key);
    if (played.size > 128) played.delete(played.keys().next().value!);
    const start = audio.currentTime + 0.015;
    notes[event].forEach((frequency, index) => {
      const oscillator = audio.createOscillator(), gain = audio.createGain(), at = start + index * 0.19;
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(settings.volume * 0.18, at + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      oscillator.connect(gain); gain.connect(audio.destination); active.add(oscillator);
      oscillator.onended = () => { active.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(at); oscillator.stop(at + 0.17);
    });
    return true;
  } catch (error) { diagnosticWarning('notifications.audio', error); return false; }
}
