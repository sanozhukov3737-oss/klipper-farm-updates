/**
 * Решает, когда проверять канал обновлений и когда о находке сообщать.
 *
 * Раньше проверка запускалась только кнопкой в настройках, поэтому программа
 * могла годами стоять на старой версии: ни уведомления, ни значка. Здесь
 * только правила — без сети, таймеров и React, чтобы их можно было проверить
 * тестом.
 *
 * Проверка тянет один манифест ограниченного размера. Инсталлятор качается
 * отдельно и только по нажатию, поэтому частая проверка ничего не стоит.
 */

/** Первая проверка после запуска: человек не успевает дойти до кнопки. */
export const FIRST_CHECK_DELAY_MS = 20_000;
/** Дальше раз в сутки, пока программа открыта. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type UpdateWatchState = {
  /** Номер выпуска, о котором уже сообщили. */
  announcedSequence: number | null;
  /** Номер установленного выпуска на момент последней попытки. */
  installedSequence: number | null;
  lastAttemptAt: number | null;
};

export const emptyUpdateWatchState = (): UpdateWatchState =>
  ({ announcedSequence: null, installedSequence: null, lastAttemptAt: null });

/**
 * Пора ли идти в сеть. `now` и `lastAttemptAt` в миллисекундах.
 *
 * Установленный выпуск входит в условие намеренно: после обновления номер
 * меняется, и проверка должна пройти сразу, а не ждать сутки.
 */
export function shouldCheck(
  state: UpdateWatchState,
  installedSequence: number,
  now: number,
): boolean {
  if (state.lastAttemptAt === null) return true;
  if (state.installedSequence !== installedSequence) return true;
  return now - state.lastAttemptAt >= CHECK_INTERVAL_MS;
}

/**
 * Нужно ли сообщать о найденном выпуске.
 *
 * Молчим, если выпуск не новее установленного, если о нём уже сообщали и если
 * это тот же выпуск, что установлен. Повторное сообщение об одном и том же
 * номере превращает уведомление в помеху.
 */
export function shouldAnnounce(
  state: UpdateWatchState,
  availableSequence: number,
  installedSequence: number,
): boolean {
  if (!Number.isFinite(availableSequence) || !Number.isFinite(installedSequence)) return false;
  if (availableSequence <= installedSequence) return false;
  return state.announcedSequence !== availableSequence;
}

/** Текст уведомления и записи в журнал. */
export function announcementText(availableSequence: number, version: string): { title: string; body: string } {
  return {
    title: 'Доступно обновление Klipper Farm',
    body: `Вышел выпуск R${availableSequence}${version ? ` (${version})` : ''}. Открыть: Настройки → Обновления.`,
  };
}

/** Короткая запись в журнал: без путей и без ссылок. */
export function journalText(availableSequence: number, installedSequence: number): string {
  return `Доступен выпуск R${availableSequence}, установлен R${installedSequence}.`;
}
