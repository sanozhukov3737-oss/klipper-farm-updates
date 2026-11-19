// Поведенческая проверка разбора ответов Moonraker на всех путях, где ответ
// читается. Раньше эти места были покрыты типами any: компилятор молчал, и
// любая ошибка формы проявлялась только на живой ферме.
//
// Здесь настоящий MoonrakerClient, подменён только IPC-мост к Rust. Каждый
// случай — реальная форма ответа: обёрнутая (Creality), вложенная, строковая,
// null, массив вместо объекта.
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');

const { outputFiles } = await build({
  stdin: {
    contents: "export {MoonrakerClient} from './src/lib/moonraker';export {setAuthSession} from './src/lib/auth';" +
      "export {moonrakerRecord,moonrakerStatus,moonrakerObjectNames,payloadRecords} from './src/lib/moonrakerPayload';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  plugins: [{
    name: 'native',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, args => ({ path: args.path, namespace: 'native' }));
      builder.onLoad({ filter: /.*/, namespace: 'native' }, () => ({
        contents: 'export const invoke=(c,a)=>globalThis.__native(c,a);export const listen=async()=>()=>{};',
        loader: 'js',
      }));
    },
  }],
});

let now = 1_800_000_000_000;
Date.now = () => now;
// Таймеры не выстреливают: фоновый часовой иначе отменял бы запрос раньше,
// чем подменённый IPC успевал ответить, и тест падал бы на отмене, а не на
// разборе ответа. Проверяем разбор, а не расписание.
let timerId = 1;
globalThis.window = {
  setTimeout: () => timerId++,
  clearTimeout: () => {},
  dispatchEvent: () => {},
};
globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };

const bundled = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const { MoonrakerClient, setAuthSession } = bundled;
const { moonrakerRecord, moonrakerStatus, moonrakerObjectNames, payloadRecords } = bundled;
setAuthSession({ token: 'protocol-behaviour', user: { id: 'operator', role: 'operator' } });

let failures = 0;
const check = (name, run) => {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
};

const makeClient = (preset = 'flashforge-ad5m') => {
  const client = new MoonrakerClient({ id: 'behaviour', name: 'Behaviour', host: '127.0.0.1:7125', profile: { preset } });
  client.actorActive = false;
  client.schedulePoll = () => {};
  return client;
};

/** Подмена IPC: rpc-ответы берутся из очереди, остальное — отказ. */
const withRpc = (responses, run) => {
  const calls = [];
  globalThis.__native = async (command, args) => {
    calls.push({ command, args });
    if (command === 'moonraker_rpc' || command === 'moonraker_ws_rpc') {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
    // HTTP-путь (getJson): отдаём тот же JSON через тело ответа.
    if (command.startsWith('moonraker_http') || command === 'native_http' || command === 'moonraker_snapshot') {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      const payload = next && next.__http !== undefined ? next.__http : next;
      return { status: 200, body: Array.from(new TextEncoder().encode(JSON.stringify(payload))) };
    }
    if (command === 'printer_actor_rpc') return { operationId: 'op', sessionEpoch: 1, state: 'confirmed', result: { status: {} } };
    return {};
  };
  return run(calls);
};

console.log('разбор формы: обёрнутые и повреждённые ответы');
check('обёрнутый результат Creality разворачивается', () => {
  assert.deepEqual(moonrakerStatus({ result: { result: { status: { print_stats: { state: 'ready' } } } } }), { print_stats: { state: 'ready' } });
});
check('список объектов внутри result.data', () => {
  assert.deepEqual(moonrakerObjectNames({ result: { data: { objects: ['extruder', 7, 'heater_bed'] } } }), ['extruder', 'heater_bed']);
});
check('null-список объектов не роняет разбор', () => {
  assert.deepEqual(moonrakerObjectNames({ result: { objects: null } }), []);
});
check('строка вместо объекта не даёт полей', () => {
  assert.deepEqual(moonrakerRecord('ответ'), {});
  assert.deepEqual(moonrakerRecord(42), {});
});
check('массив не считается объектом статуса', () => {
  assert.deepEqual(moonrakerRecord([1, 2, 3]), {});
});
check('циклическая ссылка не зацикливает обход', () => {
  const loop = { result: {} };
  loop.result.response = loop;
  const levels = payloadRecords(loop);
  assert.ok(levels.length <= 12, 'обход обязан быть ограничен');
});
check('глубина обхода ограничена', () => {
  let deep = { value: 1 };
  for (let i = 0; i < 40; i += 1) deep = { result: deep };
  assert.ok(payloadRecords(deep).length <= 12, 'обход не должен идти глубже предела');
});

console.log('список катушек Spoolman');
const spoolClient = () => makeClient();

check('обычный ответ отдаёт массив катушек', async () => {});
{
  const client = spoolClient();
  await withRpc([{ result: [{ id: 1 }, { id: 2 }] }], async () => {
    const spools = await client.spoolmanSpools();
    assert.deepEqual(spools, [{ id: 1 }, { id: 2 }]);
  });
  console.log('  ok   обычный ответ отдаёт массив катушек');
}
{
  const client = spoolClient();
  await withRpc([{ result: { response: [{ id: 7 }] } }], async () => {
    assert.deepEqual(await client.spoolmanSpools(), [{ id: 7 }]);
  });
  console.log('  ok   response внутри result читается');
}
{
  const client = spoolClient();
  await withRpc([{ result: { error: { message: 'нет доступа к Spoolman' } } }], async () => {
    await assert.rejects(() => client.spoolmanSpools(), /нет доступа к Spoolman/);
  });
  console.log('  ok   объектная ошибка даёт причину');
}
{
  const client = spoolClient();
  await withRpc([{ result: { error: 'Spoolman выключен' } }], async () => {
    await assert.rejects(() => client.spoolmanSpools(), /Spoolman выключен/);
  });
  console.log('  ok   строковая ошибка больше не теряет причину');
}
{
  const client = spoolClient();
  await withRpc([{ result: { error: { code: 503 } } }], async () => {
    await assert.rejects(() => client.spoolmanSpools(), /Spoolman error/);
  });
  console.log('  ok   ошибка без message не роняет разбор');
}
{
  const client = spoolClient();
  await withRpc([{}], async () => {
    assert.deepEqual(await client.spoolmanSpools(), []);
  });
  console.log('  ok   пустой ответ даёт пустой список');
}

console.log('подсветка: вложенные ответы и ошибки');
{
  const client = makeClient();
  const getLight = async payload => {
    globalThis.__native = async () => ({ status: 200, body: Array.from(new TextEncoder().encode(JSON.stringify(payload))) });
    return client.lightGet('/machine/light/info');
  };
  // Реальный путь подсветки — /printer/objects/query, а он отвечает
  // {result:{status:{...}}}. Проверяем именно эту форму.
  const wrapped = await getLight({ result: { status: { 'output_pin LED': { value: '1' } } } });
  assert.deepEqual(moonrakerStatus(wrapped), { 'output_pin LED': { value: '1' } }, 'потребитель обязан увидеть поля');
  console.log('  ok   ответ подсветки разворачивается потребителем');
  await assert.rejects(() => getLight({ result: { error: { message: 'нет света' } } }), /нет света/);
  console.log('  ok   ошибка на уровне result находится');
  await assert.rejects(() => getLight({ error: 'лампа недоступна' }), /лампа недоступна/);
  console.log('  ok   строковая ошибка верхнего уровня');
}

console.log('порядок и каталоги: пустые и повреждённые ответы');
{
  const client = makeClient();
  await withRpc([{ result: { objects: ['extruder', 'heater_bed', 'filament_switch_sensor runout'] } }], async () => {
    assert.deepEqual(await client.objectList(), ['extruder', 'heater_bed', 'filament_switch_sensor runout']);
  });
  console.log('  ok   каталог объектов разбирается');
}
{
  // null вместо списка: раньше это могло уронить обход, теперь пустой список.
  const client = makeClient();
  await withRpc([{ result: { objects: null } }], async () => {
    assert.deepEqual(await client.objectList(), [], 'null-каталог даёт пустой список, а не падение');
  });
  console.log('  ok   null-каталог не роняет загрузку');
}
{
  const client = makeClient();
  await withRpc([new Error('нет связи с принтером')], async () => {
    await assert.rejects(() => client.objectList(), /нет связи с принтером/);
  });
  console.log('  ok   отказ транспорта доходит до вызывающего');
}
{
  // Обёрнутый каталог Creality: объекты лежат глубже.
  const client = makeClient('creality-k1c-2025');
  await withRpc([{ result: { data: { objects: ['extruder', 'toolhead'] } } }], async () => {
    assert.deepEqual(await client.objectList(), ['extruder', 'toolhead']);
  });
  console.log('  ok   обёрнутый каталог Creality разворачивается');
}

console.log('очередь заданий');
{
  const client = makeClient();
  client.backgroundFileWorkAllowed = () => true;
  await withRpc([{ __http: { result: { queued_jobs: [{ job_id: 'a' }], queue_state: 'ready' } } }], async () => {
    const status = await client.queueStatus();
    assert.deepEqual(status.queued_jobs, [{ job_id: 'a' }]);
    assert.equal(status.queue_state, 'ready');
  });
  console.log('  ok   очередь разбирается');
}
{
  // Ответ без обёртки result: поля не должны потеряться.
  const client = makeClient();
  client.backgroundFileWorkAllowed = () => true;
  await withRpc([{ __http: { queued_jobs: [], queue_state: 'ready' } }], async () => {
    const status = await client.queueStatus();
    assert.equal(status.queue_state, 'ready', 'ответ без обёртки не должен терять поля');
  });
  console.log('  ok   ответ без обёртки не теряет поля');
}

console.log(`\nповеденческих проверок протокола пройдено, провалов: ${failures}`);
if (failures > 0) process.exit(1);
