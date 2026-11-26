// Диалоговые цепочки: состояние между отдельными вызовами помощника.
//
// Одиночная команда может быть понята верно и всё равно привести не туда, если состояние между шагами
// теряется: смена принтера посреди подготовки, истёкший срок разговора, отмена на любом шаге. Все
// сценарии ниже проверяют именно переходы, а не отдельные фразы.
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled = await build({
  stdin: {contents: "export {VoiceAssistant} from './src/lib/voiceAssistant';export {VoiceTaskQueue} from './src/lib/voiceTaskQueue';export {VoiceLearnedNames} from './src/lib/voiceLearnedNames';export {emptyFilamentInventory} from './src/lib/filamentInventory';export {profileForPreset} from './src/lib/printerProfile';", resolveDir: process.cwd(), loader: 'ts'},
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const {VoiceAssistant, VoiceTaskQueue, VoiceLearnedNames, emptyFilamentInventory, profileForPreset} =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const printer = (id, name, preset) => ({id, name, host: '192.168.1.10', profile: profileForPreset(preset), status: {state: 'ready', connectionState: 'online'}, webcams: []});
const storage = () => { const m = new Map(); return {getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k)}; };

function fixture() {
  const data = {
    printers: [printer('max', 'K1 Max (Макс)', 'creality-k1-max'), printer('k1c', 'K1C 2025', 'creality-k1c-2025')],
    clock: 1_000_000, role: true, client: {}, start: [], upload: [], validate: [],
    filesByScope: {
      'model:creality-k1-max': [{path: 'детали/держатель.gcode', size: 100}, {path: 'детали/корпус.gcode', size: 200}],
      'model:creality-k1c-2025': [{path: 'детали/держатель.gcode', size: 100}, {path: 'детали/втулка.gcode', size: 50}],
    },
  };
  data.inventory = emptyFilamentInventory();
  const deps = {
    printers: () => data.printers,
    canOperate: () => data.role,
    client: () => data.client,
    now: () => data.clock,
    learning: new VoiceLearnedNames(storage(), 'chain', () => data.clock),
    tasks: new VoiceTaskQueue(storage(), 'chain', () => data.clock),
    inventory: async () => data.inventory,
    list: async scope => data.filesByScope[scope] ?? [],
    validate: async (p, candidate) => { data.validate.push(candidate.entry.path); return {sha256: 'a'.repeat(64), report: {ok: true, issues: [], metadata: {filament_weight_total: 50, filament_type: 'PLA'}}}; },
    ready: async () => {},
    upload: async p => { data.upload.push(p.id); return 'remote.gcode'; },
    start: async (p, path) => { data.start.push({printer: p.id, path}); return {}; },
    check: async () => true,
    audit: async () => {},
  };
  return {data, assistant: new VoiceAssistant(deps)};
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, 'ok', '']); }
  catch (error) { results.push([name, 'FAIL', String(error.message).slice(0, 120)]); }
}

// 1. Полная цепочка: печать → смена принтера → выбор файла → подтверждение.
await check('печать → смена принтера → файл → подтверждение', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель на Максе');
  const changed = await f.assistant.handle('Нет, лучше на K1C');
  assert.ok(changed.choices?.length, 'после смены принтера должен быть выбор файла');
  await f.assistant.choose(changed.choices[0]);
  await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 1, 'печать не стартовала');
  assert.equal(f.data.start[0].printer, 'k1c', 'старт не на том принтере: ' + f.data.start[0].printer);
});

// 2. Смена файла внутри той же цепочки.
await check('печать → другой файл → подтверждение', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель на Максе');
  // С голым существительным ассистент спрашивает «что сделать» — это верно, глагола нет.
  // Смена файла внутри цепочки делается явной командой.
  const other = await f.assistant.handle('Напечатай корпус');
  assert.ok(other.proposal || other.choices, 'после смены файла нет предложения');
  if (other.choices) await f.assistant.choose(other.choices[0]);
  await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 1, 'печать не стартовала');
});

// 3. Отмена посреди цепочки не даёт стартовать.
await check('печать → отмена → подтверждение', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель на Максе');
  await f.assistant.handle('Отмена');
  const reply = await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 0, 'печать стартовала после отмены');
  assert.ok(reply.text, 'отмена без ответа');
});

// 4. Три смены принтера подряд.
await check('три смены принтера подряд', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель на Максе');
  await f.assistant.handle('Нет, лучше на K1C');
  await f.assistant.handle('Нет, лучше на Максе');
  const last = await f.assistant.handle('Нет, лучше на K1C');
  assert.ok(last, 'третья смена потерялась');
  if (last.choices?.length) await f.assistant.choose(last.choices[0]);
  await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 1);
  assert.equal(f.data.start[0].printer, 'k1c');
});

// 5. Истечение разговора между шагами.
await check('истечение срока между шагами', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель на Максе');
  f.data.clock += 10 * 60_000;
  const reply = await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 0, 'печать стартовала после истечения');
  assert.ok(reply.text);
});

// 6. Смена принтера на несуществующий не ломает цепочку.
await check('смена на несуществующий принтер', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель на Максе');
  const reply = await f.assistant.handle('Нет, лучше на Призрак');
  assert.ok(reply.text, 'нет ответа');
  assert.equal(f.data.start.length, 0);
});

// 7. «Отмена» на этапе выбора файла.
await check('отмена на этапе выбора файла', async () => {
  const f = fixture();
  const ask = await f.assistant.handle('Напечатай держатель');
  assert.equal(ask.clarification, 'printer');
  await f.assistant.handle('Отмена');
  const after = await f.assistant.handle('Макс');
  assert.ok(after.text, 'после отмены выбор принтера не должен срабатывать');
  assert.equal(f.data.start.length, 0);
});

const failed = results.filter(row => row[1] !== 'ok');
for (const [name, state, detail] of failed) console.log('FAIL', name, '|', detail);
if (failed.length) {
  console.error(`Voice chains: ${failed.length} из ${results.length} сценариев провалены`);
  process.exit(1);
}
console.log(`Voice chains: ${results.length} сценариев — смена принтера, смена файла, отмена и истечение `
  + 'срока сохраняют состояние и не запускают печать зря');
