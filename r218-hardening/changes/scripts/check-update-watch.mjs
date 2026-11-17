// Проверка правил автоматической проверки обновлений. Сеть здесь не нужна:
// проверяется только решение — идти ли за манифестом и сообщать ли о находке.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  announcementText,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  emptyUpdateWatchState,
  journalText,
  shouldAnnounce,
  shouldCheck,
} from '../src/lib/updateWatcher.ts';

let failures = 0;
const check = (name, condition, extra = '') => {
  if (condition) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
};

const NOW = 1_800_000_000_000;

console.log('когда идти в сеть');
check('первый запуск — сразу', shouldCheck(emptyUpdateWatchState(), 166, NOW));
check('через минуту после попытки — не идём', !shouldCheck(
  { announcedSequence: null, installedSequence: 166, lastAttemptAt: NOW - 60_000 }, 166, NOW));
check('сутки не прошли — не идём', !shouldCheck(
  { announcedSequence: null, installedSequence: 166, lastAttemptAt: NOW - CHECK_INTERVAL_MS + 1 }, 166, NOW));
check('сутки прошли — идём', shouldCheck(
  { announcedSequence: null, installedSequence: 166, lastAttemptAt: NOW - CHECK_INTERVAL_MS }, 166, NOW));
check('версия сменилась — идём не дожидаясь суток', shouldCheck(
  { announcedSequence: null, installedSequence: 166, lastAttemptAt: NOW - 60_000 }, 167, NOW));

console.log('о чём сообщать');
const fresh = emptyUpdateWatchState();
check('новый выпуск — сообщаем', shouldAnnounce(fresh, 168, 167));
check('тот же номер — молчим', !shouldAnnounce(fresh, 167, 167));
check('старее установленного — молчим', !shouldAnnounce(fresh, 166, 167));
check('уже сообщали об этом номере — молчим', !shouldAnnounce(
  { announcedSequence: 168, installedSequence: 167, lastAttemptAt: NOW }, 168, 167));
check('после установки 168 и выхода 169 — снова сообщаем', shouldAnnounce(
  { announcedSequence: 168, installedSequence: 168, lastAttemptAt: NOW }, 169, 168));
check('мусор в номере — молчим', !shouldAnnounce(fresh, Number.NaN, 167));

console.log('тексты');
const text = announcementText(168, '1.15.18-r168');
check('в заголовке обновление', text.title.includes('обновление'), text.title);
check('в теле номер выпуска', text.body.includes('R168'), text.body);
check('в теле версия', text.body.includes('1.15.18-r168'), text.body);
check('ведёт в настройки', text.body.includes('Настройки'), text.body);
const noVersion = announcementText(168, '');
check('без версии не рисует пустые скобки', !noVersion.body.includes('()'), noVersion.body);
const journal = journalText(168, 167);
check('в журнале оба номера', journal.includes('R168') && journal.includes('R167'), journal);
check('в журнале нет ссылок', !/https?:/.test(journal), journal);

console.log('источник правды для таймингов');
check('интервал ровно сутки', CHECK_INTERVAL_MS === 86_400_000, String(CHECK_INTERVAL_MS));
// Первая проверка ждёт намеренно: иначе она совпадёт с уже открытой панелью
// настроек, и ручная проверка получит «операция уже выполняется».
check('первая проверка с задержкой', FIRST_CHECK_DELAY_MS >= 10_000, String(FIRST_CHECK_DELAY_MS));
check('задержка меньше интервала', FIRST_CHECK_DELAY_MS < CHECK_INTERVAL_MS, String(FIRST_CHECK_DELAY_MS));

console.log('уведомление доступно не только администратору');
{
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rust = readFileSync(resolve(root, 'src-tauri/src/online_updates.rs'), 'utf8');
  const section = (start, end) => {
    const from = rust.indexOf(start);
    const to = rust.indexOf(end, from);
    return from >= 0 && to > from ? rust.slice(from, to) : '';
  };
  // Границы — следующий атрибут команды: порядок функций в файле не важен.
  const available = section('async fn update_available(', '#[tauri::command]');
  const status = section('fn update_status(', '#[tauri::command]');
  const check = section('async fn update_check(', '#[tauri::command]');
  check !== '' && available !== ''
    ? console.log('  ok   обе команды найдены')
    : (failures += 1, console.log('  FAIL команды обновления не найдены'));
  // Оператор и наблюдатель должны узнавать о выпуске, но не готовить установку.
  available.includes('Role::Viewer')
    ? console.log('  ok   update_available доступен наблюдателю')
    : (failures += 1, console.log('  FAIL update_available требует больше, чем Viewer'));
  status.includes('Role::Viewer')
    ? console.log('  ok   update_status доступен наблюдателю')
    : (failures += 1, console.log('  FAIL update_status требует больше, чем Viewer'));
  // Установка остаётся административной.
  check.includes('Role::Admin')
    ? console.log('  ok   update_check по-прежнему требует Admin')
    : (failures += 1, console.log('  FAIL update_check потерял ограничение Admin'));
  // Лёгкая команда не должна отдавать то, чем готовится установка.
  !/manifest_sha256|size_bytes/.test(available)
    ? console.log('  ok   update_available не отдаёт хеш и размер')
    : (failures += 1, console.log('  FAIL update_available отдаёт данные для установки'));
}

if (failures > 0) {
  console.log(`\nпровалено: ${failures}`);
  process.exit(1);
}
console.log('\nвсё прошло');
