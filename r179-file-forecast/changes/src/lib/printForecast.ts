/**
 * Прогноз длительности печати по прошлым запускам того же файла.
 *
 * Слайсер даёт оценку времени, но она бывает неточной: на реальной ферме разница
 * достигает десятков процентов из-за ускорений и настроек принтера. Собственная
 * история точнее отвечает на вопрос «сколько это займёт у меня».
 *
 * Считаем только завершённые успешные печати: упавшая или отменённая печать
 * не характеризует длительность. Значения усредняем, потому что одна случайная
 * долгая печать не должна портить прогноз.
 */

export type PrintDurationSample = {
  filename: string;
  status?: string;
  print_duration?: number;
  total_duration?: number;
  /** Локальная запись о печати хранит длительность в поле duration. */
  duration?: number;
};

export type PrintForecast = {
  /** Сколько успешных печатей вошло в прогноз. */
  runs: number;
  /** Средняя длительность в минутах. */
  averageMinutes: number;
  /** Самая короткая и самая длинная из учтённых печатей. */
  minMinutes: number;
  maxMinutes: number;
};

/** Минимум печатей, чтобы прогноз считался значимым. */
export const PRINT_FORECAST_MIN_RUNS = 2;

const successful = (sample: PrintDurationSample) =>
  /^completed$|^success$/i.test(String(sample.status ?? '').trim());

export const printDurationMinutes = (sample: PrintDurationSample): number => {
  for (const candidate of [sample.print_duration, sample.total_duration, sample.duration]) {
    const seconds = Number(candidate ?? 0);
    if (Number.isFinite(seconds) && seconds > 0) return seconds / 60;
  }
  return 0;
};

/** Имя файла сравниваем без пути и без учёта регистра: одна деталь, разные папки. */
const baseName = (value: string) => {
  const parts = String(value ?? '').split(/[\\/]/u);
  return (parts[parts.length - 1] ?? '').trim().toLowerCase();
};

/** Ключ прогноза. Экспортируется, чтобы библиотека и отчёт сравнивали имена
 * одинаково: два разных правила разошлись бы молча. */
export const forecastKey = (filename: string): string => baseName(filename);

/**
 * Возвращает прогноз для файла или undefined, если данных недостаточно.
 * Намеренно не подставляет оценку слайсера: это разные величины, и смешивать их
 * значит скрывать от оператора, что печать идёт не по плану.
 */
export function printForecast(
  samples: readonly PrintDurationSample[],
  filename: string,
): PrintForecast | undefined {
  const wanted = baseName(filename);
  if (!wanted) return undefined;
  const durations = samples
    .filter(sample => successful(sample) && baseName(sample.filename) === wanted)
    .map(printDurationMinutes)
    .filter(minutes => minutes > 0);
  if (durations.length < PRINT_FORECAST_MIN_RUNS) return undefined;
  const total = durations.reduce((sum, minutes) => sum + minutes, 0);
  return {
    runs: durations.length,
    averageMinutes: total / durations.length,
    minMinutes: Math.min(...durations),
    maxMinutes: Math.max(...durations),
  };
}

/** Все прогнозы по истории: имя файла в нижнем регистре → прогноз. */
export function printForecasts(
  samples: readonly PrintDurationSample[],
): Map<string, PrintForecast> {
  const names = new Set(samples.map(sample => baseName(sample.filename)).filter(Boolean));
  const result = new Map<string, PrintForecast>();
  for (const name of names) {
    const forecast = printForecast(samples, name);
    if (forecast) result.set(name, forecast);
  }
  return result;
}

/** Человеческая форма: «4 ч 20 мин». */
export function formatForecastMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours && rest) return `${hours} ч ${rest} мин`;
  if (hours) return `${hours} ч`;
  return `${rest} мин`;
}
