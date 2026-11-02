import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  stdin: {
    contents: "export { validateVoiceSemanticResult, semanticVoiceIntent } from './src/lib/voiceSemantic';\nexport { VoiceAssistant } from './src/lib/voiceAssistant';\nexport { normalizeVoiceEventSpeechPreferences, voiceEventSpeechText, VOICE_EVENT_SPEECH_DEFAULTS } from './src/lib/voiceEventSpeech';",
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { validateVoiceSemanticResult, semanticVoiceIntent, VoiceAssistant, normalizeVoiceEventSpeechPreferences, voiceEventSpeechText, VOICE_EVENT_SPEECH_DEFAULTS } =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const results = [];
const test = async (name, check) => { await check(); results.push({ name, passed: true }); console.log('PASS', name); };

const makePrinter = (id, name, preset = 'creality-k1c-2025') => ({ id, name, host: '192.168.1.10', profile: { preset, bedX: 220, bedY: 220, maxZ: 250, nozzle: .4, materials: ['PLA'], enclosed: true }, status: { state: 'ready', connectionState: 'online' }, webcams: [] });
const input = (text, context = {}) => ({
  text,
  context: {
    printers: [{ id: 'max', name: 'K1Max(Макс)', preset: 'creality-k1-max' }, { id: 'k1c', name: 'K1C', preset: 'creality-k1c-2025' }],
    fileChoices: [], printerChoices: [], ...context,
  },
});

await test('navigate intent validates and maps section targets', () => {
  for (const [text, target] of [['Открой инструменты', 'tools'], ['Покажи пластик', 'spools'], ['Открой ТВ', 'tv'], ['Перейди в настройки', 'settings'], ['Открой очередь', 'queue'], ['Покажи историю', 'history'], ['Открой панель', 'dashboard'], ['Открой принтеры', 'printers'], ['Открой файлы', 'files'], ['Открой помощника', 'assistant'], ['Открой контроль камеры', 'camera-guard']]) {
    const semantic = validateVoiceSemanticResult({ kind: 'navigate', target }, input(text));
    assert.equal(semantic.kind, 'navigate');
    const intent = semanticVoiceIntent(semantic, text);
    assert.equal(intent.kind, 'navigate');
    assert.equal(intent.target, target);
  }
});

await test('navigate flash requires a positive open request and an exact named printer', () => {
  const ok = validateVoiceSemanticResult({ kind: 'navigate', target: 'flash', printerId: 'max' }, input('Открой мою флешку на Максе'));
  assert.equal(ok.kind, 'navigate');
  assert.equal(ok.printerId, 'max');
  // No open verb -> ambiguous
  const noVerb = validateVoiceSemanticResult({ kind: 'navigate', target: 'flash' }, input('моя флешка на максе'));
  assert.equal(noVerb.kind, 'clarify');
  // Unknown printer id rejected
  assert.throws(() => validateVoiceSemanticResult({ kind: 'navigate', target: 'flash', printerId: 'unknown' }, input('Открой флешку')));
  // printerId forbidden for plain sections
  assert.throws(() => validateVoiceSemanticResult({ kind: 'navigate', target: 'tools', printerId: 'max' }, input('Открой инструменты')));
  // Unknown target rejected
  assert.throws(() => validateVoiceSemanticResult({ kind: 'navigate', target: 'shell' }, input('Открой консоль')));
});

await test('assistant opens a section through the navigate dependency', async () => {
  const opened = [];
  const assistant = new VoiceAssistant({
    printers: () => [], canOperate: () => true, client: () => undefined,
    list: async () => [], inventory: async () => ({ materials: [] }),
    validate: async () => { throw Error('unused'); }, ready: async () => {}, upload: async () => { throw Error('unused'); },
    start: async () => {}, check: async () => false,
    audit: async () => {},
    navigate: (target, printerId) => { opened.push([target, printerId]); return true; },
    interpret: async () => ({ kind: 'navigate', target: 'tools' }),
  });
  const reply = await assistant.handle('Открой инструменты');
  assert.match(reply.text, /Открыла инструменты/);
  assert.deepEqual(opened, [['tools', undefined]]);
});

await test('flash opens directly for one printer and asks when the farm has several', async () => {
  const opened = [];
  const deps = printers => ({
    printers: () => printers, canOperate: () => true, client: () => undefined,
    list: async () => [], inventory: async () => ({ materials: [] }),
    validate: async () => { throw Error('unused'); }, ready: async () => {}, upload: async () => { throw Error('unused'); },
    start: async () => {}, check: async () => false,
    audit: async () => {},
    navigate: (target, printerId) => { opened.push([target, printerId]); return true; },
    interpret: async (input) => input.text.includes('Максе') || input.text.includes('максе')
      ? { kind: 'navigate', target: 'flash', printerId: 'max' }
      : { kind: 'navigate', target: 'flash' },
  });
  const single = new VoiceAssistant(deps([makePrinter('max', 'K1Max(Макс)', 'creality-k1-max')]));
  const direct = await single.handle('Открой мою флешку на Максе');
  assert.match(direct.text, /Открыла Мою флешку/);
  assert.deepEqual(opened, [['flash', 'max']]);
  opened.length = 0;
  const many = new VoiceAssistant(deps([makePrinter('max', 'K1Max(Макс)', 'creality-k1-max'), makePrinter('k1c', 'K1C')]));
  const ask = await many.handle('Открой мою флешку');
  assert.match(ask.text, /На каком принтере/);
  assert.equal(ask.printerChoices.length, 2);
  const chosen = await many.choosePrinter('k1c');
  assert.match(chosen.text, /Открыла Мою флешку/);
  assert.deepEqual(opened, [['flash', 'k1c']]);
});

await test('event speech preferences normalize and produce bounded spoken texts', () => {
  assert.deepEqual(normalizeVoiceEventSpeechPreferences(null), VOICE_EVENT_SPEECH_DEFAULTS);
  assert.deepEqual(normalizeVoiceEventSpeechPreferences({ error: false }), { complete: true, error: false, runout: true });
  assert.equal(normalizeVoiceEventSpeechPreferences({ complete: 'yes' }).complete, true);
  const long = 'x'.repeat(500);
  const text = voiceEventSpeechText('error', 'K1 Max', long);
  assert.ok(text.length < 400);
  assert.match(voiceEventSpeechText('complete', 'K1 Max', 'jobs/держатель.gcode'), /завершена/);
  assert.match(voiceEventSpeechText('runout', 'K1C'), /пластик/);
});

console.log(JSON.stringify({ script: 'check-voice-navigate.mjs', passed: results.length, results }, null, 2));
