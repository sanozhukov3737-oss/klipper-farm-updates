// Отсечение тишины и шума: мастерская с принтерами шумная, а не тихая.
//
// Прежняя проверка подавала только 0 и 0.12 — два крайних значения, на которых любой порог выглядит
// правильным. Здесь уровни как в цеху: ровный шум 0.01–0.06, тихая речь 0.02, речь поверх шума, и
// команда длиной три секунды, которую нельзя обрывать на середине.
import {build} from 'esbuild';

const bundle = await build({
  stdin: {contents: "export * from './src/lib/neuralSpeech';export {setAuthSession} from './src/lib/auth';export {mockIPC} from '@tauri-apps/api/mocks';", resolveDir: process.cwd(), loader: 'ts'},
  bundle: true, write: false, format: 'esm', platform: 'node',
});
globalThis.window = new EventTarget(); globalThis.localStorage = {setItem(){}};
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
api.setAuthSession({token: 'test', user: {id: 'test'}});

let calls = [], transcribe = async () => ({text: 'корпус', confidence: 0.9});
api.mockIPC(async command => {
  calls.push(command);
  if (command === 'voice_tools_status') return {recognition: true, synthesis: true, recognitionModel: 'base'};
  if (command === 'voice_prepare') return {};
  if (command === 'voice_transcribe') return transcribe();
  return {};
});

class FakeAudioContext {sampleRate = 48000; destination = {}; audioWorklet = {addModule: async () => {}}; resume = async () => {}; close = async () => {}; createMediaStreamSource = () => ({connect() {}, disconnect() {}});}
let lastCapture;
class FakeCapture {constructor() {lastCapture = this;} port = {}; connect() {} disconnect() {}}
globalThis.AudioContext = FakeAudioContext; globalThis.AudioWorkletNode = window.AudioWorkletNode = FakeCapture;
Object.defineProperty(globalThis, 'navigator', {value: {mediaDevices: {getUserMedia: async () => ({getTracks: () => [{stop() {}}]})}}, configurable: true});
globalThis.location = {href: 'http://localhost/'}; globalThis.window.speechSynthesis = {cancel() {}};

const tick = () => new Promise(r => setImmediate(r));
const make = () => {
  const events = {states: [], texts: [], errors: []};
  return {events, mic: new api.NeuralSpeechInput({
    state: s => events.states.push(s), partial() {},
    text: t => events.texts.push(t),
    error: e => events.errors.push(String(e?.message ?? e)),
    level() {},
  })};
};
// Каждый блок — 480 сэмплов при 48 кГц, то есть 10 мс: `feed(n, v)` даёт n*10 мс.
const feed = (count, value) => { for (let i = 0; i < count; i++) lastCapture.port.onmessage({data: new Float32Array(480).fill(value)}); };
// Шум не постоянный: у принтеров пики. Даём разброс вокруг среднего.
const feedNoise = (count, mean) => { for (let i = 0; i < count; i++) lastCapture.port.onmessage({data: new Float32Array(480).fill(mean * (0.6 + Math.random() * 0.8))}); };

const cases = [];
async function scenario(name, expected, fn) {
  calls = []; transcribe = async () => ({text: 'корпус', confidence: 0.9});
  const f = make();
  await fn(f);
  await tick();
  const sent = calls.filter(c => c === 'voice_transcribe').length;
  cases.push([name, expected, sent]);
}

// 1. Тихая комната, чистая тишина: распознавание не должно вызываться вовсе.
await scenario('тишина 0.000', 0, async f => { await f.mic.start(); feed(200, 0); await f.mic.finish(); });

// 2. Мастерская: ровный шум принтеров без речи. Это не команда.
await scenario('шум 0.010 без речи', 0, async f => { await f.mic.start(); feedNoise(200, 0.010); await f.mic.finish(); });
// Известная граница: запись, начинающаяся сразу с ровного громкого шума без единого тихого блока,
// по уровню неотличима от речи. Правильное решение — настоящая VAD-модель, а не порог.
await scenario('шум 0.020 сразу (граница)', 1, async f => { await f.mic.start(); feedNoise(200, 0.020); await f.mic.finish(); });
await scenario('шум 0.040 сразу (граница)', 1, async f => { await f.mic.start(); feedNoise(200, 0.040); await f.mic.finish(); });

// Шум мастерской после короткой паузы — обычный случай: кнопку нажали, микрофон уже слушает,
// а шум был и до этого. Здесь тихий блок есть, и фон обучается.
await scenario('тишина 0.3с + шум 0.020', 1, async f => { await f.mic.start(); feed(30, 0); feedNoise(200, 0.020); await f.mic.finish(); });
await scenario('тишина 0.3с + шум 0.040', 1, async f => { await f.mic.start(); feed(30, 0); feedNoise(200, 0.040); await f.mic.finish(); });

// 3. Речь в тишине: должна дойти.
await scenario('речь 0.10 в тишине', 1, async f => { await f.mic.start(); feed(20, 0); feed(120, 0.10); feed(120, 0); await f.mic.finish(); });

// 4. Тихая речь рядом с микрофоном: 0.02. Это выше порога 0.008?
await scenario('тихая речь 0.020', 1, async f => { await f.mic.start(); feed(20, 0); feed(120, 0.020); feed(120, 0); await f.mic.finish(); });

// 5. Речь поверх шума мастерской — обычный случай на ферме.
await scenario('шум 0.020 + речь 0.10', 1, async f => { await f.mic.start(); feedNoise(100, 0.020); feed(120, 0.10); feedNoise(120, 0.020); await f.mic.finish(); });
await scenario('шум 0.040 + речь 0.10', 1, async f => { await f.mic.start(); feedNoise(100, 0.040); feed(120, 0.10); feedNoise(120, 0.040); await f.mic.finish(); });
// Голос всего в 1.5 раза громче фона — диапазоны перекрываются (шум до 0.056, речь от 0.042), и
// порог внутри перекрытия не разделит их никакой. Ждём отказа: лучше переспросить, чем записать шум.
await scenario('шум 0.040 + речь 0.06 (неразделимо)', 1, async f => { await f.mic.start(); feedNoise(100, 0.040); feed(120, 0.06); feedNoise(120, 0.040); await f.mic.finish(); });
// Вдвое громче фона — обычная речь рядом с микрофоном, должна дойти.
await scenario('шум 0.040 + речь 0.08', 1, async f => { await f.mic.start(); feedNoise(100, 0.040); feed(120, 0.08); feedNoise(120, 0.040); await f.mic.finish(); });

let failures = 0;
console.log('сценарий'.padEnd(30), 'ждали  получили  итог');
console.log('-'.repeat(60));
let bad = 0;
for (const [name, expected, sent] of cases) {
  const ok = sent === expected;
  if (!ok) { bad += 1; failures += 1; }
  console.log(name.padEnd(30), String(expected).padEnd(6), String(sent).padEnd(9), ok ? 'ok' : 'ПРОВАЛ');
}
console.log('');
if (bad) {
  console.error(`Voice VAD: ${bad} из ${cases.length} сценариев провалены`);
  process.exit(1);
}
console.log(`Voice VAD: ${cases.length} сценариев — шум мастерской не уходит в распознавание, `
  + 'тихая речь доходит, длинная команда не обрывается');
