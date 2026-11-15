// Проверка чистки следов удалённых принтеров. Ключевые требования:
// пустой конфиг не должен ничего удалять, чужие ключи — тоже.
import { storageJanitorPlan, storageJanitorKeys, runStorageJanitor, storageJanitorSummary } from '../src/lib/storageJanitor.ts';

let failures = 0;
const check = (name, condition, extra = '') => {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
};

const FILE = 'production.printerFiles.';
const known = ['alpha', 'beta'];
const keys = [
  FILE + 'alpha',
  FILE + 'beta',
  FILE + 'ghost-1',
  FILE + 'ghost-2',
  'printers.config',
  'production.cameraGuard.v1',
  'production.printerFilesIndex',
];

console.log('план');
const plan = storageJanitorPlan(keys, known, { version: 1, printers: { alpha: { mode: 'notify' }, ghost: { mode: 'pause' } } });
check('сироты найдены', plan.fileCaches.join(',') === 'ghost-1,ghost-2', plan.fileCaches.join(','));
check('живые принтеры не тронуты', !plan.fileCaches.includes('alpha') && !plan.fileCaches.includes('beta'));
check('посторонние ключи не тронуты', !plan.fileCaches.includes('printers.config') && !plan.fileCaches.includes('production.printerFilesIndex'));
check('настройка камеры сироты найдена', plan.cameraGuardPrinters.join(',') === 'ghost', plan.cameraGuardPrinters.join(','));
check('ключи к удалению — только кеши', storageJanitorKeys(plan).join(',') === FILE + 'ghost-1,' + FILE + 'ghost-2');
check('итог без сирот пуст', storageJanitorSummary({ fileCaches: [], cameraGuardPrinters: [] }) === undefined);
check('итог считает оба вида', storageJanitorSummary(plan)?.includes('кешей файлов: 2') === true, storageJanitorSummary(plan));

console.log('пустая конфигурация');
const empty = storageJanitorPlan(keys, [], { version: 1, printers: { ghost: { mode: 'pause' } } });
check('пустой конфиг ничего не удаляет', empty.fileCaches.length === 0 && empty.cameraGuardPrinters.length === 0);
check('пустой конфиг помечен как пропуск', empty.skipped === 'no-printers');

console.log('применение');
const removed = [];
const written = [];
const applied = await runStorageJanitor({
  keys: async () => keys,
  remove: async key => { removed.push(key); },
  readCameraGuard: async () => ({ version: 1, printers: { alpha: { mode: 'notify' }, ghost: { mode: 'pause' } } }),
  writeCameraGuard: async value => { written.push(value); },
  knownPrinterIds: known,
});
check('удалены только сироты', removed.join(',') === FILE + 'ghost-1,' + FILE + 'ghost-2', removed.join(','));
check('отчёт о удалённом', applied.fileCaches.join(',') === 'ghost-1,ghost-2');
check('настройка камеры переписана', written.length === 1);
check('живая настройка камеры сохранена', 'alpha' in (written[0].printers ?? {}), JSON.stringify(written[0]?.printers));
check('сирота камеры убрана', !('ghost' in (written[0].printers ?? {})), JSON.stringify(written[0]?.printers));
check('версия настроек сохранена', written[0].version === 1);

console.log('сбой хранилища');
const unavailable = await runStorageJanitor({
  keys: async () => { throw new Error('нет доступа'); },
  remove: async () => { throw new Error('не должен вызываться'); },
  readCameraGuard: async () => null,
  writeCameraGuard: async () => { throw new Error('не должен вызываться'); },
  knownPrinterIds: known,
});
check('недоступное хранилище не выдаётся за успех', unavailable.skipped === 'unavailable');
check('при сбое ничего не заявлено удалённым', unavailable.fileCaches.length === 0 && unavailable.cameraGuardPrinters.length === 0);

console.log('сбой одного ключа');
const partial = await runStorageJanitor({
  keys: async () => keys,
  remove: async key => { if (key.endsWith('ghost-1')) throw new Error('заблокирован'); },
  readCameraGuard: async () => null,
  writeCameraGuard: async () => {},
  knownPrinterIds: known,
});
check('остальные ключи удалены несмотря на сбой', partial.fileCaches.join(',') === 'ghost-2', partial.fileCaches.join(','));

if (failures > 0) {
  console.log(`\nпровалено: ${failures}`);
  process.exit(1);
}
console.log('\nвсё прошло');
