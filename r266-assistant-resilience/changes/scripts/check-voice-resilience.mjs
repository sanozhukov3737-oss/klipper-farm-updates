// Устойчивость помощника: гонки, отмена, сбои и границы.
//
// Проверки ассистента покрывали happy path и отдельные отказы, но не то, что случается на ферме:
// оператор подтвердил дважды, принтер исчез посреди диалога, разговор истёк, пришёл мусор вместо речи,
// а внутри что-то упало. Каждый сценарий ниже либо охраняет печать от неверного запуска, либо
// гарантирует, что вместо технической ошибки оператор увидит понятную фразу.
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled = await build({
  stdin: {
    contents: "export {VoiceAssistant} from './src/lib/voiceAssistant';export {VoiceTaskQueue} from './src/lib/voiceTaskQueue';export {VoiceLearnedNames} from './src/lib/voiceLearnedNames';export {profileForPreset} from './src/lib/printerProfile';export {emptyFilamentInventory} from './src/lib/filamentInventory';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const {VoiceAssistant, VoiceTaskQueue, VoiceLearnedNames, profileForPreset, emptyFilamentInventory} =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const printer = (id = 'max', name = 'K1 Max', preset = 'creality-k1-max') => ({
  id, name, host: '192.168.1.10',
  profile: profileForPreset(preset),
  status: {state: 'ready', connectionState: 'online', telemetryUpdatedAt: 1_000_000},
});
const storage = () => { const map = new Map(); return {getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k)}; };

function fixture(overrides = {}) {
  const data = {
    printers: [printer()], clock: 1_000_000, role: true, client: {},
    files: [{path: 'детали/держатель.gcode', size: 1000}],
    list: [], start: [], validate: [], upload: [],
    ...overrides,
  };
  data.inventory = emptyFilamentInventory();
  const learning = new VoiceLearnedNames(storage(), 'probe', () => data.clock);
  const tasks = new VoiceTaskQueue(storage(), 'probe', () => data.clock);
  const deps = {
    printers: () => data.printers,
    canOperate: () => data.role,
    client: () => data.client,
    now: () => data.clock,
    learning, tasks,
    list: async scope => { data.list.push(scope); return data.files; },
    validate: async (...args) => { data.validate.push(args); return {sha256: 'a'.repeat(64), report: {ok: true, issues: []}}; },
    start: async (...args) => { data.start.push(args); return {path: 'remote.gcode'}; },
    upload: async (...args) => { data.upload.push(args); return 'remote.gcode'; },
    ready: async () => {},
    check: async () => true,
    audit: async () => {},
  };
  return {data, deps, assistant: new VoiceAssistant(deps), tasks};
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, 'ok', '']); }
  catch (error) { results.push([name, 'FAILED', String(error.message).slice(0, 160)]); }
}

// 1. Две команды одновременно: вторая не должна ломать первую и не должна молчать.
await check('две команды одновременно', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    f.assistant.handle('Напечатай держатель'),
    f.assistant.handle('Сколько пластика осталось?'),
  ]);
  assert.ok(a, 'первая команда потерялась');
  assert.ok(b, 'вторая команда потерялась');
});

// 2. Отмена посреди выполнения.
await check('отмена во время команды', async () => {
  const f = fixture();
  const pending = f.assistant.handle('Напечатай держатель');
  f.assistant.cancel?.();
  const reply = await pending;
  assert.ok(reply, 'отмена не дала ответа');
});

// 3. Сбой принтера во время списка файлов.
await check('сбой при получении файлов', async () => {
  const f = fixture();
  f.deps.list = async () => { throw new Error('принтер недоступен'); };
  const reply = await f.assistant.handle('Напечатай держатель');
  assert.ok(reply && reply.text, 'сбой не превратился в ответ');
  assert.ok(!/Error|undefined|null/.test(reply.text), 'в ответ утекла внутренняя ошибка: ' + reply.text);
});

// 4. Сбой при старте печати после подтверждения.
await check('сбой старта после подтверждения', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель');
  f.deps.start = async () => { throw new Error('принтер занят'); };
  const reply = await f.assistant.handle('Подтверждаю печать');
  assert.ok(reply && reply.text, 'сбой старта не дал ответа');
  assert.ok(!/undefined|null/.test(reply.text), 'в ответ утекла внутренняя ошибка: ' + reply.text);
});

// 5. Истёкший разговор.
await check('разговор истекает по времени', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель');
  f.data.clock += 10 * 60_000;
  const reply = await f.assistant.handle('держатель');
  assert.ok(reply && reply.text, 'после истечения нет ответа');
});

// 6. Очень длинный текст.
await check('очень длинный ввод', async () => {
  const f = fixture();
  const reply = await f.assistant.handle('Напечатай ' + 'держатель '.repeat(500));
  assert.ok(reply && reply.text, 'длинный ввод не обработан');
  assert.ok(reply.text.length < 4000, 'ответ раздулся: ' + reply.text.length);
});

// 7. Пустой и мусорный ввод.
await check('пустой и мусорный ввод', async () => {
  const f = fixture();
  for (const text of ['', '   ', '?!', '🎉🎉🎉', 'asdfgh', '\u0000\u0001']) {
    const reply = await f.assistant.handle(text);
    assert.ok(reply && typeof reply.text === 'string', 'ввод ' + JSON.stringify(text) + ' не дал ответа');
  }
});

// 8. Много принтеров и много файлов.
await check('много принтеров и файлов', async () => {
  const f = fixture();
  f.data.printers = Array.from({length: 40}, (_, i) => printer('p' + i, 'Принтер ' + i));
  f.data.files = Array.from({length: 500}, (_, i) => ({path: 'детали/деталь-' + i + '.gcode', size: 100}));
  const reply = await f.assistant.handle('Напечатай держатель');
  assert.ok(reply && reply.text, 'большая ферма не обработана');
});

// 9. Роль без прав.
await check('нет прав на печать', async () => {
  const f = fixture();
  f.data.role = false;
  const reply = await f.assistant.handle('Напечатай держатель');
  assert.ok(reply && reply.text, 'нет ответа без прав');
  assert.equal(f.data.start.length, 0, 'печать стартовала без прав');
});

// 10. Принтер без статуса.
await check('принтер без статуса', async () => {
  const f = fixture();
  f.data.printers = [{id: 'x', name: 'Голый', host: 'h', profile: profileForPreset('creality-k1-max')}];
  const reply = await f.assistant.handle('Напечатай держатель');
  assert.ok(reply && reply.text, 'принтер без статуса сломал ассистента');
});


// 10b. Внутренняя ошибка (не ситуация фермы, а дефект кода) не должна попадать в речь ассистента.
await check('внутренняя ошибка не попадает в речь', async () => {
  const f = fixture();
  f.deps.validate = async () => { throw new TypeError("Cannot read properties of undefined (reading 'ok')"); };
  const reply = await f.assistant.handle('Напечатай держатель');
  assert.ok(!/Cannot read|undefined|TypeError/.test(reply.text), 'техническая строка утекла в ответ: ' + reply.text);
  assert.match(reply.text, /внутренней ошибки/u, 'нет понятного объяснения: ' + reply.text);
  assert.ok(reply.diagnosticDetail && /Cannot read/.test(reply.diagnosticDetail), 'техническая деталь потеряна');
});

// 10c. Ошибка, описывающая ситуацию, наоборот должна дойти до оператора своим текстом.
await check('ситуационная ошибка доходит как есть', async () => {
  const f = fixture();
  f.deps.upload = async () => { throw new Error('SHA256 differs'); };
  await f.assistant.handle('Напечатай держатель');
  const reply = await f.assistant.handle('Подтверждаю печать');
  assert.match(reply.text, /SHA256/, 'осмысленная ошибка скрыта от оператора: ' + reply.text);
});

// 11. После сбоя старта не должно остаться предложения, которое сработает от следующей фразы.
await check('сбой старта не оставляет опасного состояния', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель');
  f.deps.start = async () => { throw new Error('принтер занят'); };
  await f.assistant.handle('Подтверждаю печать');
  f.deps.start = async (...args) => { f.data.start.push(args); return 'ok.gcode'; };
  // следующая фраза не про подтверждение — старт произойти не должен
  await f.assistant.handle('Сколько пластика осталось?');
  assert.equal(f.data.start.length, 0, 'старт произошёл от посторонней фразы после сбоя');
});

// 12. Повторное подтверждение не должно стартовать печать дважды.
await check('двойное подтверждение', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель');
  await f.assistant.handle('Подтверждаю печать');
  await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 1, 'печать стартовала дважды: ' + f.data.start.length);
});

// 13. Отмена на этапе подтверждения отменяет намерение.
await check('отмена до подтверждения', async () => {
  const f = fixture();
  await f.assistant.handle('Напечатай держатель');
  await f.assistant.handle('Отмена');
  const reply = await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 0, 'печать стартовала после отмены');
  assert.ok(reply && reply.text, 'отмена не дала ответа');
});

// 14. Смена цели посреди диалога не печатает на старом принтере.
await check('смена принтера в диалоге', async () => {
  const f = fixture({printers: [printer('max','K1 Max'), printer('c','K1C','creality-k1c-2025')]});
  await f.assistant.handle('Напечатай держатель на K1C');
  f.data.printers = f.data.printers.filter(p => p.id === 'max');
  const reply = await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 0, 'печать стартовала на исчезнувшем принтере');
  assert.ok(reply && reply.text, 'исчезновение принтера не дало ответа');
});

// 15. Ошибка валидации G-code не даёт даже предложения, а значит и старта.
await check('провал проверки G-code', async () => {
  const f = fixture();
  f.deps.validate = async () => { throw new Error('файл повреждён'); };
  const reply = await f.assistant.handle('Напечатай держатель');
  await f.assistant.handle('Подтверждаю печать');
  assert.equal(f.data.start.length, 0, 'печать стартовала без проверки');
  assert.ok(reply && reply.text, 'провал проверки не дал ответа');
  assert.ok(!/TypeError|undefined/.test(reply.text), 'в ответ утекла внутренняя ошибка');
});

const failures = results.filter(row => row[1] !== 'ok');
for (const [name, state, detail] of results) {
  if (state !== 'ok') console.log('FAIL', name, '|', detail);
}
if (failures.length) {
  console.error(`Assistant resilience: ${failures.length} из ${results.length} сценариев провалены`);
  process.exit(1);
}
console.log(`Assistant resilience: ${results.length} сценариев — печать не уходит без подтверждения, `
  + 'технические ошибки не попадают в речь');
