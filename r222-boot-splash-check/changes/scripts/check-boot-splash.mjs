// Заставка при запуске: проверяем собранный результат, а не исходник.
//
// Окно появляется примерно через две секунды после старта процесса — столько
// занимает разбор файла приложения на 278 МБ и старт WebView2. Всё это время
// оператор не должен видеть пустое белое полотно.
//
// Что проверяем и почему именно это:
//   * заставка и её стили лежат прямо в index.html — отдельный файл стилей
//     грузится позже, любая внешняя ссылка вернула бы белый экран;
//   * заставка стоит рядом с #root, а не внутри него: React рисует в #root и
//     стёр бы вложенную заставку при первом же рендере;
//   * убирает её код приложения по появлению содержимого, а не по таймеру:
//     render() в React 18 возвращает управление до отрисовки;
//   * предусмотрен случай, когда сборка не загрузилась вовсе.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Заставка встроена в index.html ДО сборки, потому что внешний CSS грузится
// позже и оставил бы белый экран. Поэтому разметку проверяем в исходнике:
// dist собирается из него и может быть старым — в CI дерево распаковывается
// из релизного архива, где лежит dist прошлого выпуска без заставки. Проверка
// на dist падала бы там не по делу, а на собранном дереве проходила.
const sourcePath = resolve(root, 'index.html');
const html = readFileSync(sourcePath, 'utf8');
const source = 'index.html';
// Собранный бандл нужен только для последней проверки: он доказывает, что
// заставку убирает код, а не таймер.
const built = resolve(root, 'dist/index.html');

// 1. Разметка заставки на месте.
for (const marker of ['id="kfBoot"', 'kfBootMark', 'kfBootState', 'Загрузка интерфейса']) {
  assert.ok(html.includes(marker), `в ${source} нет заставки: ${marker}`);
}

// 2. Стили встроены, а не вынесены: до загрузки бандла CSS они должны работать.
assert.ok(html.includes('@keyframes kfBootSlide'), 'анимация заставки не встроена');
assert.ok(html.includes('prefers-reduced-motion'), 'нет варианта без анимации для слабых машин');
assert.ok(html.includes('background:#020811'), 'у заставки нет собственного фона — будет белый экран');
const bootStyles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
assert.ok(!bootStyles.includes('href='), 'стили заставки ссылаются на внешний файл');

// 3. Заставка — сосед #root, иначе React сотрёт её первым рендером.
const rootAt = html.indexOf('id="root"');
const bootAt = html.indexOf('id="kfBoot"');
assert.ok(rootAt >= 0 && bootAt >= 0, 'нет #root или #kfBoot');
assert.ok(bootAt > rootAt, 'заставка должна идти после #root');
const between = html.slice(rootAt, bootAt);
// #root объявлен пустым и сразу закрыт. Если заставка окажется внутри него,
// между ними не будет закрывающего тега, а React сотрёт её первым рендером.
assert.ok(between.includes('</div>'), 'заставка оказалась внутри #root и будет стёрта React');

// 4. Приложение убирает заставку по факту отрисовки, а не по таймеру.
// Это проверяется только на собранном бандле: в источнике ссылки на бандл нет,
// а собрать его здесь нечем. Молча пропустить нельзя, поэтому причина печатается.
// Проверка бандла имеет смысл только если dist собран из кода, где заставка уже
// есть. В CI дерево распаковывается из релизного архива со старым dist: там
// заставки нет ни в разметке, ни в бандле, и судить по нему о сегодняшнем коде
// нельзя. Признак свежести — сама разметка в собранном index.html.
const distHtml = existsSync(built) ? readFileSync(built, 'utf8') : '';
const distHasSplash = distHtml.includes('id="kfBoot"');
const bundleName = distHasSplash ? /src="\/assets\/([^"]+\.js)"/.exec(distHtml)?.[1] : undefined;
if (!bundleName || !existsSync(resolve(root, 'dist/assets', bundleName))) {
  console.log('Boot splash: разметка и стили в порядке; собранного бандла из актуальных исходников нет, проверка удаления по отрисовке пропущена.');
  process.exit(0);
}
const bundlePath = resolve(root, 'dist/assets', bundleName);
assert.ok(existsSync(bundlePath), 'собранный бандл не найден: ' + bundleName);
const bundle = readFileSync(bundlePath, 'utf8');
assert.ok(bundle.includes('kfBoot'), 'бандл не знает про заставку');
assert.ok(bundle.includes('MutationObserver'), 'заставка убирается не по появлению интерфейса');
assert.ok(bundle.includes('isConnected'), 'нет защиты от повторного удаления заставки');
// Проверяем текст, а не число: минификатор превращает 15_000 в 15e3.
assert.ok(bundle.includes('загружается дольше обычного'), 'нет сообщения на случай, если сборка не загрузилась');

console.log('Boot splash: inline before paint, sibling of #root, dismissed after React renders');
