/**
 * Убирает следы удалённых принтеров из локального хранилища.
 *
 * При удалении принтера его кеш файлов остаётся навсегда: ключи вида
 * `production.printerFiles.<id>` никто не удаляет. На реальной ферме накопилось
 * десять сиротских кешей из семнадцати — это сотни килобайт, которые читаются
 * при каждом открытии панели файлов и никогда не используются. Туда же попадают
 * настройки контроля камеры для принтеров, которых больше нет.
 *
 * Чистим при запуске, а не в момент удаления: принтер могут удалить из другого
 * места, а конфигурацию — восстановить из резервной копии, и тогда сироты
 * вернутся. Запуск закрывает все случаи.
 *
 * Главная осторожность: пустой список принтеров означает сбой чтения, а не
 * «все принтеры удалены». В этом случае не трогаем ничего, иначе один неудачный
 * старт унёс бы весь кеш.
 */

const FILE_CACHE_PREFIX = 'production.printerFiles.';
const CAMERA_GUARD_KEY = 'production.cameraGuard.v1';

export type JanitorReport = {
  /** Ключи кешей файлов удалённых принтеров. */
  fileCaches: string[];
  /** Идентификаторы принтеров, убранных из настроек контроля камеры. */
  cameraGuardPrinters: string[];
  /** Почему чистка не выполнялась. */
  skipped?: 'no-printers' | 'unavailable';
};

const emptyReport = (skipped?: JanitorReport['skipped']): JanitorReport =>
  ({ fileCaches: [], cameraGuardPrinters: [], ...(skipped ? { skipped } : {}) });

/** Идентификаторы из ключей кеша файлов: `production.printerFiles.<id>`. */
const cachedPrinterIds = (keys: string[]): string[] =>
  keys
    .filter(key => key.startsWith(FILE_CACHE_PREFIX))
    .map(key => key.slice(FILE_CACHE_PREFIX.length))
    .filter(id => id.length > 0);

/**
 * Возвращает отчёт о том, что удалено. Принимает список ключей и известных
 * принтеров явно, чтобы это можно было проверить без браузера.
 *
 * `remove` вызывается только для сирот. Функции передаются снаружи по той же
 * причине: тест подставляет свои, а приложение — localStorage и dbSet.
 */
export function storageJanitorPlan(
  keys: readonly string[],
  knownPrinterIds: readonly string[],
  cameraGuard: unknown,
): JanitorReport {
  // Пустой список принтеров — это сбой чтения конфигурации. Считать его за
  // «всё удалено» значит стереть рабочий кеш.
  if (knownPrinterIds.length === 0) return emptyReport('no-printers');

  const known = new Set(knownPrinterIds);
  const fileCaches = cachedPrinterIds([...keys]).filter(id => !known.has(id));

  const cameraGuardPrinters: string[] = [];
  if (cameraGuard && typeof cameraGuard === 'object') {
    const printers = (cameraGuard as { printers?: unknown }).printers;
    if (printers && typeof printers === 'object') {
      for (const id of Object.keys(printers as Record<string, unknown>)) {
        if (!known.has(id)) cameraGuardPrinters.push(id);
      }
    }
  }
  return { fileCaches, cameraGuardPrinters };
}

/** Ключи хранилища, которые нужно удалить по плану. */
export function storageJanitorKeys(report: JanitorReport): string[] {
  return report.fileCaches.map(id => FILE_CACHE_PREFIX + id);
}

/**
 * Применяет план к хранилищу. Возвращает отчёт только о фактически удалённом:
 * если хранилище недоступно, ничего не выдаём за сделанное.
 */
export async function runStorageJanitor(dependencies: {
  keys: () => Promise<string[]>;
  remove: (key: string) => Promise<void>;
  readCameraGuard: () => Promise<unknown>;
  writeCameraGuard: (value: unknown) => Promise<void>;
  knownPrinterIds: string[];
}): Promise<JanitorReport> {
  let keys: string[];
  let cameraGuard: unknown;
  try {
    keys = await dependencies.keys();
    cameraGuard = await dependencies.readCameraGuard();
  } catch {
    return emptyReport('unavailable');
  }

  const report = storageJanitorPlan(keys, dependencies.knownPrinterIds, cameraGuard);
  if (report.skipped) return report;

  const removed: string[] = [];
  for (const key of storageJanitorKeys(report)) {
    try {
      await dependencies.remove(key);
      removed.push(key);
    } catch {
      // Один неудачный ключ не должен мешать остальным.
    }
  }

  let removedCameraPrinters: string[] = [];
  if (report.cameraGuardPrinters.length > 0) {
    try {
      // Перечитываем перед записью: между чтением и записью настройки камеры
      // мог изменить работающий контроль, и его правка важнее нашей чистки.
      const current = (await dependencies.readCameraGuard()) as {
        version?: unknown;
        printers?: Record<string, unknown>;
      } | null;
      if (current && typeof current === 'object' && current.printers) {
        const printers = { ...current.printers };
        for (const id of report.cameraGuardPrinters) delete printers[id];
        await dependencies.writeCameraGuard({ ...current, printers });
        removedCameraPrinters = report.cameraGuardPrinters;
      }
    } catch {
      // Настройки камеры остались как были; ключи файлов уже удалены.
    }
  }
  return {
    fileCaches: removed.map(key => key.slice(FILE_CACHE_PREFIX.length)),
    cameraGuardPrinters: removedCameraPrinters,
  };
}

/** Сообщение для журнала: коротко и только когда что-то удалено. */
export function storageJanitorSummary(report: JanitorReport): string | undefined {
  if (report.skipped || (!report.fileCaches.length && !report.cameraGuardPrinters.length)) return undefined;
  const parts: string[] = [];
  if (report.fileCaches.length) parts.push(`кешей файлов: ${report.fileCaches.length}`);
  if (report.cameraGuardPrinters.length) parts.push(`настроек камеры: ${report.cameraGuardPrinters.length}`);
  return `Убраны следы удалённых принтеров (${parts.join(', ')}).`;
}
