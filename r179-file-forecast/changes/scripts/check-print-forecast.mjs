// Прогноз длительности по истории: чистые функции, без принтеров и сети.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  stdin: {
    contents: "export { printForecast, printForecasts, formatForecastMinutes, PRINT_FORECAST_MIN_RUNS, printDurationMinutes, forecastKey } from './src/lib/printForecast';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { printForecast, printForecasts, formatForecastMinutes, PRINT_FORECAST_MIN_RUNS, printDurationMinutes, forecastKey } =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const completed = (filename, minutes, status = 'completed') => ({ filename, status, print_duration: minutes * 60 });

// Одна печать — мало данных: прогноз не выдаётся, иначе оператор получит случайное число.
assert.equal(printForecast([completed('case.gcode', 120)], 'case.gcode'), undefined);

// Две успешные — среднее, минимум и максимум считаются.
const two = printForecast([completed('case.gcode', 100), completed('case.gcode', 140)], 'case.gcode');
assert.equal(two.runs, 2);
assert.equal(two.averageMinutes, 120);
assert.equal(two.minMinutes, 100);
assert.equal(two.maxMinutes, 140);

// Упавшая и отменённая печати не участвуют: они не про длительность.
const mixed = printForecast([
  completed('case.gcode', 60),
  completed('case.gcode', 60),
  completed('case.gcode', 600, 'cancelled'),
  completed('case.gcode', 600, 'error'),
], 'case.gcode');
assert.equal(mixed.runs, 2);
assert.equal(mixed.averageMinutes, 60);

// Путь и регистр не важны: одна деталь может лежать в разных папках.
const same = printForecast([
  completed('parts/Case.gcode', 90),
  completed('CASE.GCODE', 90),
], 'parts/case.gcode');
assert.equal(same.runs, 2);
assert.equal(same.averageMinutes, 90);

// total_duration используется, когда print_duration отсутствует.
const fallback = printForecast([
  { filename: 'x.gcode', status: 'completed', total_duration: 1800 },
  { filename: 'x.gcode', status: 'completed', total_duration: 1800 },
], 'x.gcode');
assert.equal(fallback.averageMinutes, 30);

// Нулевые длительности отбрасываются.
assert.equal(printForecast([completed('z.gcode', 0), completed('z.gcode', 0)], 'z.gcode'), undefined);
assert.equal(printDurationMinutes({ filename: 'z.gcode' }), 0);

// Карта прогнозов строится по всем файлам сразу.
const map = printForecasts([
  completed('a.gcode', 10), completed('a.gcode', 20),
  completed('b.gcode', 30),
]);
assert.equal(map.size, 1);
assert.equal(map.get('a.gcode').averageMinutes, 15);

// Человеческий формат.
assert.equal(formatForecastMinutes(260), '4 ч 20 мин');
assert.equal(formatForecastMinutes(120), '2 ч');
assert.equal(formatForecastMinutes(45), '45 мин');
assert.equal(PRINT_FORECAST_MIN_RUNS, 2);


// Локальная запись о печати хранит секунды в поле duration: прогноз должен её понимать,
// иначе в библиотеке файлов он не заработает никогда.
const record = (filename, minutes, status = 'completed') => ({ filename, status, duration: minutes * 60 });
const fromRecords = printForecast([record('box.gcode', 200), record('box.gcode', 280)], 'box.gcode');
assert.equal(fromRecords.averageMinutes, 240);
assert.equal(formatForecastMinutes(fromRecords.averageMinutes), '4 ч');

// Отменённая местная запись не участвует.
assert.equal(printForecast([record('box.gcode', 200), record('box.gcode', 900, 'cancelled')], 'box.gcode'), undefined);

// Ноль в print_duration не должен скрывать реальную длительность из duration.
assert.equal(printDurationMinutes({ filename: 'n.gcode', print_duration: 0, duration: 600 }), 10);

// Ключ прогноза один для библиотеки и отчёта: путь и регистр не важны.
assert.equal(forecastKey('parts/Case.gcode'), 'case.gcode');
assert.equal(forecastKey('CASE.GCODE'), 'case.gcode');
assert.equal(forecastKey(''), '');

// Библиотечный путь и строка истории дают один и тот же ключ.
const libraryForecast = printForecasts([record('parts/case.gcode', 120), record('parts/case.gcode', 120)]);
assert.equal(libraryForecast.get(forecastKey('case.gcode')).averageMinutes, 120);

console.log('Print forecast: history average from history rows and local records, cancellations excluded, shared file key');
