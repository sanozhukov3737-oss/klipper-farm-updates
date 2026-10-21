import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..'), out = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-r127-warehouse-'));
const shots = process.env.KF_UI_SCREENSHOTS, report = [], errors = [];
let browser, server, currentPage;
try {
  await build({ root, logLevel: 'error', build: { outDir: out, emptyOutDir: true, rollupOptions: { input: path.join(root, 'ui-tests/filament-inventory.html') } } });
  server = http.createServer((req, res) => {
    const file = path.resolve(out, new URL(req.url, 'http://localhost').pathname.slice(1));
    if (!file.startsWith(out + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] ?? 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  if (shots) fs.mkdirSync(shots, { recursive: true });
  for (const theme of ['dark', 'light']) for (const width of [1366, 910, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1366 ? 1250 : 900 }, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    currentPage = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    await page.goto(`${origin}/ui-tests/filament-inventory.html?seed=warehouse&view=production&theme=${theme}`);
    await page.getByRole('button', { name: 'Пластик', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Запас и расход пластика', exact: true });
    await panel.getByTestId('filament-material-PLA').waitFor();
    const state = await page.evaluate(() => window.__inventory());
    const warehouse = panel.getByRole('region', { name: 'Визуальный склад катушек', exact: true });
    const inspector = warehouse.getByRole('region', { name: 'Выбранная катушка', exact: true });
    for (const spool of state.spools) {
      const graphic = warehouse.getByTestId(`filament-spool-${spool.id}`).getByRole('img');
      assert.equal(await graphic.getAttribute('data-filament-color'), spool.color);
      assert.equal(await graphic.getAttribute('data-filament-grams'), String(spool.remainingWeight), `Spool ${spool.id} substituted its saved balance`);
    }
    const alternate = state.spools[1];
    assert.notEqual(state.spools[0].color, alternate.color, 'Same-material colors must be different in this regression');
    await warehouse.getByTestId(`filament-spool-${alternate.id}`).focus();
    await page.keyboard.press('Enter');
    assert.equal(await inspector.locator('[data-filament-color]').first().getAttribute('data-filament-color'), alternate.color);
    await warehouse.getByRole('textbox', { name: 'Найти катушку', exact: true }).fill(alternate.color);
    assert.equal(await warehouse.getByTestId(/^filament-spool-/).count(), 1);
    await warehouse.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
    await warehouse.getByRole('group', { name: 'Материал катушек', exact: true }).getByRole('button', { name: 'PETG', exact: true }).click();
    assert.equal(await warehouse.getByTestId(/^filament-spool-/).count(), state.spools.filter(spool => spool.material === 'PETG').length);
    await warehouse.getByRole('group', { name: 'Материал катушек', exact: true }).getByRole('button', { name: 'Все', exact: true }).click();
    await warehouse.getByLabel('Расположение катушек', { exact: true }).selectOption('printer');
    assert.equal(await warehouse.getByTestId(/^filament-spool-/).count(), state.spools.filter(spool => spool.printerId).length);
    await warehouse.getByLabel('Расположение катушек', { exact: true }).selectOption('low');
    assert.equal(await warehouse.getByTestId(/^filament-spool-/).count(), state.spools.filter(spool => spool.remainingWeight > 0 && spool.remainingWeight / Math.max(spool.initialWeight, spool.remainingWeight, 1) <= .2).length);
    await warehouse.getByLabel('Расположение катушек', { exact: true }).selectOption('active');
    await warehouse.getByTestId(`filament-spool-${state.spools[0].id}`).click();
    assert.match(await panel.getByTestId('filament-material-PLA').innerText(), /6 катушек/);
    assert.equal(await panel.getByTestId('filament-material-ASA').count(), 0, 'Empty default materials must not fill the warehouse');
    const accounting = panel.getByRole('region', { name: 'Расход по дням', exact: true });
    const byDate = state.usageHistory.days.filter(row => row.day === new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())).reduce((sum, row) => sum + row.manualGrams + row.calculatedGrams, 0);
    assert.ok(byDate > 0);
    await accounting.getByRole('button', { name: '30 дней', exact: true }).click();
    assert.equal(await accounting.getByRole('group', { name: 'Списания за 30 дней', exact: true }).getByRole('button').count(), 30);
    const first = accounting.getByRole('group', { name: 'Списания за 30 дней', exact: true }).getByRole('button').first();
    await first.focus(); await page.keyboard.press('Enter');
    assert.equal(await first.getAttribute('aria-pressed'), 'true');
    assert.ok(await first.evaluate(element => element.matches(':focus-visible')));
    await accounting.getByRole('button', { name: '7 дней', exact: true }).click();
    const days = accounting.getByRole('group', { name: 'Списания за 7 дней', exact: true });
    assert.equal(await days.getByRole('button').count(), 7);
    await days.getByRole('button').last().click();
    // Verify the daily display from the same durable ledger, not a chart fixture.
    assert.match(await accounting.innerText(), new RegExp(String(byDate).replace('.', '[,.]')));
    const before = await page.evaluate(() => window.__database());
    assert.equal(await page.evaluate(() => window.__calls.filter(call => call.command === 'filament_inventory_commit').length), 0, 'Opening a chart must never rewrite inventory');
    const modal = page.locator('.productionPanel.panel');
    const bounds = await modal.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 1, 'Warehouse overflows horizontally: ' + JSON.stringify(bounds));
    const bars = await days.getByRole('button').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    assert.ok(bars.every(value => value >= 20), 'Seven-day bar targets are unusably small');
    await modal.evaluate(element => { element.scrollTop = 0; });
    await page.mouse.move(0, 0);
    if (shots) await page.screenshot({ path: path.join(shots, `warehouse-${theme}-${width}.png`) });
    if (shots && width === 1366) { await accounting.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(shots, `warehouse-usage-${theme}.png`) }); }
    const spool = panel.getByRole('img', { name: 'Катушка PLA 1 кг', exact: true }).first();
    await spool.waitFor();
    assert.equal(await spool.getAttribute('data-spool-thumbnail'), 'true');
    await page.reload(); await page.getByRole('button', { name: 'Пластик', exact: true }).click();
    await panel.getByTestId('filament-material-PLA').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__database()), before, 'Opening/reopening changed stock, daily history or spool colors');
    report.push({ case: 'production-warehouse', theme, width, durableDailyHistory: true, periods: [7, 30], keyboardDaySelection: true, noReadOnlyWrite: true, noHorizontalOverflow: true, everySpoolUsesOwnColor: true, keyboardSpoolSelection: true, colorSearch: true, materialAndLocationFilters: true, spoolGraphicLoaded: true });
    await page.close();
  }
  // A real edit exercises color persistence and daily-write rollback on native failure.
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  currentPage = page;
  await page.goto(`${origin}/ui-tests/filament-inventory.html?seed=warehouse`);
  const panel = page.getByRole('region', { name: 'Запас и расход пластика', exact: true });
  await panel.getByTestId('filament-material-PLA').waitFor();
  await panel.getByRole('button', { name: 'Добавить катушки', exact: true }).click();
  await panel.locator('form').getByLabel(/^Цвет пластика/).fill('#c24b75');
  assert.equal(await panel.locator('form').getByRole('img', { name: 'Предпросмотр цвета катушки', exact: true }).getAttribute('data-filament-color'), '#c24b75');
  await panel.locator('form').getByRole('button', { name: 'Сохранить', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__inventory().spools.at(-1).color), '#c24b75');
  const added = await page.evaluate(() => window.__inventory().spools.at(-1));
  await panel.getByTestId(`filament-spool-${added.id}`).click();
  const inspector = panel.getByRole('region', { name: 'Выбранная катушка', exact: true });
  await inspector.getByRole('button', { name: 'Остаток и цвет', exact: true }).click();
  const form = panel.locator('form');
  await form.getByRole('button', { name: 'Цвет #4b98d9', exact: true }).click();
  assert.equal(await form.getByRole('img', { name: 'Предпросмотр цвета катушки', exact: true }).getAttribute('data-filament-color'), '#4b98d9');
  if (shots) await page.screenshot({ path: path.join(shots, 'warehouse-live-color-preview.png') });
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  assert.equal(await inspector.locator('[data-filament-color]').first().getAttribute('data-filament-color'), '#4b98d9');
  await inspector.getByRole('button', { name: 'Назначить принтеру', exact: true }).click();
  await form.getByLabel(/^Принтер/).selectOption('printer-two');
  assert.equal(await form.getByLabel(/^Откуда списывать/).inputValue(), added.id, 'Choosing a printer lost the physical spool selected on the shelf');
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  assert.equal((await page.evaluate(() => window.__inventory())).printers['printer-two'].binding.spoolId, added.id);
  const before = await page.evaluate(() => window.__inventory());
  await panel.getByTestId('filament-printer-printer-one').getByRole('button', { name: 'Расход вручную', exact: true }).click();
  await panel.locator('form').getByLabel(/^Расход, кг/).fill('0,1');
  await page.evaluate(() => { window.__fault.commit = true; });
  await panel.locator('form').getByRole('button', { name: 'Записать расход', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Проверочный сбой сохранения' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__inventory()), before);
  await page.evaluate(() => { window.__fault.commit = false; });
  await panel.locator('form').getByRole('button', { name: 'Записать расход', exact: true }).click();
  await panel.locator('form').waitFor({ state: 'detached' });
  const after = await page.evaluate(() => window.__inventory());
  assert.equal(after.printers['printer-one'].usedGrams - before.printers['printer-one'].usedGrams, 100);
  assert.equal(after.usageHistory.days.reduce((sum, row) => sum + row.manualGrams, 0) - before.usageHistory.days.reduce((sum, row) => sum + row.manualGrams, 0), 100);
  await page.reload(); await panel.getByTestId('filament-material-PLA').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__inventory()), after, 'Color, physical spool assignment or usage changed after reopening');
  assert.equal(after.spools.find(spool => spool.id === added.id).color, '#4b98d9');
  report.push({ case: 'color-and-daily-write-rollback', passed: true, livePreview: true, paletteColorPersisted: true, physicalSpoolAssignment: true, reopenPreserved: true, retryDebitedOnce: true });
  await page.close();
  assert.deepEqual(errors, []);
  const result = { passed: report.length, report, runtimeErrors: errors, scope: 'Actual production components; native database boundary is emulated; no physical printer used.' };
  if (shots) fs.writeFileSync(path.join(shots, 'warehouse-r128-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('WAREHOUSE_FAILURE', JSON.stringify({ message: String(error), runtimeErrors: errors, url: currentPage?.url() }));
  if (currentPage && !currentPage.isClosed()) {
    console.error((await currentPage.locator('body').innerText()).slice(0, 4500));
    if (shots) await currentPage.screenshot({ path: path.join(shots, 'warehouse-failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); fs.rmSync(out, { recursive: true, force: true });
}
