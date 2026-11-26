// Отчётность фермы: арифметика поверх истории, без принтеров и без сети.
//
// Проверки раньше убеждались только в том, что calculateFarmReportStats существует — grep по имени
// функции. Что она считает, не проверял никто, и в ней было два дефекта: отменённая оператором печать
// попадала в провалы и занижала процент успеха, а часы наработки считались только по завершённым, хотя
// принтер работал и на отменённых. Тест фиксирует обе границы.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  stdin: {
    contents: "export { calculateFarmReportStats, filterFarmHistory, farmHistoryStatusLabel, farmHistoryStatusTone } from './src/lib/farmReports';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { calculateFarmReportStats, filterFarmHistory, farmHistoryStatusLabel, farmHistoryStatusTone } =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const job = (status, hours = 0, filament) => ({
  status,
  print_duration: hours * 3600,
  ...(filament === undefined ? {} : { filament_used: filament }),
});

// A print the operator stopped on purpose is not a defect. Counting it as one answered a question nobody
// asked and made a careful operator's farm look unreliable.
{
  const stats = calculateFarmReportStats([
    job('completed', 1, 100),
    job('cancelled', 0.5, 50),
    job('failed', 0.2),
  ]);
  assert.equal(stats.completed, 1, 'completed count');
  assert.equal(stats.cancelled, 1, 'cancelled counted apart from failures');
  assert.equal(stats.failed, 1, 'a real failure stays a failure');
  assert.equal(stats.success, 50, 'success is measured over decided prints: 1 of 2, not 1 of 3');
  // 1h + 0.5h + 0.2h of machine time, rounded to whole hours.
  assert.equal(stats.hours, 2, 'hours include cancelled and failed prints, because the machine ran');
}

// Only cancellations: there is no failure rate to report, and success must not read as 0% — nothing failed.
{
  const stats = calculateFarmReportStats([job('completed', 1), job('cancelled', 1)]);
  assert.equal(stats.success, 100, 'cancellations alone do not lower the success rate');
  assert.equal(stats.failed, 0);
  assert.equal(stats.cancelled, 1);
}

// Nothing decided yet: an empty or still-running history reports 0 rather than dividing by zero.
{
  const stats = calculateFarmReportStats([job('printing', 3), job('in_progress', 1)]);
  assert.equal(stats.success, 0, 'no decided prints means no success rate');
  assert.equal(stats.hours, 0, 'a print still running has not added to the total yet');
  assert.equal(stats.completed, 0);
  assert.equal(stats.failed, 0);
  assert.equal(stats.cancelled, 0);
}

// The status spelling varies between Moonraker versions and the farm's own records. Every known shape must
// land on the right side of the boundary, and an unrecognised one must not be counted as success.
for (const status of ['completed', 'COMPLETED', 'Complete', 'completed_successfully']) {
  const stats = calculateFarmReportStats([job(status, 1)]);
  assert.equal(stats.completed, 1, 'completed variant: ' + status);
  assert.equal(stats.failed, 0, 'completed variant is not a failure: ' + status);
}
for (const status of ['cancelled', 'CANCELLED', 'Cancel', 'cancelled_by_user']) {
  const stats = calculateFarmReportStats([job(status, 1)]);
  assert.equal(stats.cancelled, 1, 'cancelled variant: ' + status);
  assert.equal(stats.failed, 0, 'cancelled variant is not a failure: ' + status);
}
for (const status of ['error', 'failed', 'klippy_shutdown', 'unknown_state']) {
  const stats = calculateFarmReportStats([job(status, 1)]);
  assert.equal(stats.failed, 1, 'failure variant: ' + status);
  assert.equal(stats.cancelled, 0, 'failure is not a cancellation: ' + status);
}

// Filament is only reported when at least one print carried a number; otherwise the UI must say "unknown"
// rather than show a confident zero.
{
  const unknown = calculateFarmReportStats([job('completed', 1)]);
  assert.equal(unknown.filamentKnown, false, 'no filament data means unknown');
  const known = calculateFarmReportStats([job('completed', 1, 2500)]);
  assert.equal(known.filamentKnown, true);
  assert.equal(known.filament, 2.5, 'grams convert to kilograms');
  // Cancelled prints did not consume the reported filament of the farm's completed output.
  const mixed = calculateFarmReportStats([job('completed', 1, 1000), job('cancelled', 1, 500)]);
  assert.equal(mixed.filament, 1, 'filament totals stay over completed prints');
}

// An unrecognised status is shown as-is instead of being silently labelled completed.
assert.equal(farmHistoryStatusLabel('completed'), 'Завершено');
assert.equal(farmHistoryStatusLabel('cancelled'), 'Отменено');
assert.equal(farmHistoryStatusLabel('klippy_shutdown'), 'klippy_shutdown');
assert.equal(farmHistoryStatusLabel(undefined), '—');
assert.equal(farmHistoryStatusTone('completed'), 'completed');
assert.equal(farmHistoryStatusTone('cancelled'), 'cancelled');
assert.equal(farmHistoryStatusTone('klippy_shutdown'), 'unknown');


// A filter and the statistics beneath it must count the same way. They used to disagree: the option
// labelled "Ошибки и отмены" listed cancellations while the statistics beside it reported them separately,
// so the number a user filtered for never matched the number they were shown.
{
  const history = [
    { ...job('completed', 2, 100), timestamp: 3, printerId: 'a' },
    { ...job('cancelled', 1, 50), timestamp: 2, printerId: 'a' },
    { ...job('failed', 1), timestamp: 1, printerId: 'a' },
  ];
  const only = (status) => filterFarmHistory(history, { period: 'all', status });

  assert.equal(only('all').length, 3, 'no filter keeps every job');
  assert.equal(only('success').length, 1, 'success filter selects completions');
  assert.equal(only('cancelled').length, 1, 'cancelled filter selects cancellations');
  assert.equal(only('failed').length, 1, 'failed filter no longer absorbs cancellations');

  // The numbers a user sees must agree whichever way they slice the same history.
  const all = calculateFarmReportStats(only('all'));
  assert.equal(only('success').length, all.completed, 'completed filter matches the completed count');
  assert.equal(only('cancelled').length, all.cancelled, 'cancelled filter matches the cancelled count');
  assert.equal(only('failed').length, all.failed, 'failed filter matches the failed count');
}

console.log('Farm report statistics: cancellations, machine hours and status boundaries');
