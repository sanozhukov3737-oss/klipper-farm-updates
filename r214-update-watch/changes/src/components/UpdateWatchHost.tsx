import { useEffect, useRef } from 'react';
import { updateCheck, updateStatus } from '../lib/native';
import { recordNotification, showAppNotification } from '../lib/appNotifications';
import {
  announcementText,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  journalText,
  shouldAnnounce,
  shouldCheck,
  emptyUpdateWatchState,
  type UpdateWatchState,
} from '../lib/updateWatcher';

/**
 * Проверяет канал обновлений сам, без нажатия кнопки.
 *
 * Живёт рядом с FarmApp, а не в панели настроек: панель монтируется только
 * когда её открыли, и проверка в ней не была бы автоматической.
 *
 * Ничего не скачивает и не устанавливает. Инсталлятор по-прежнему требует
 * явного нажатия в настройках.
 *
 * Ошибки намеренно проглатываются: ферма может работать без интернета, и
 * сообщение о недоступном GitHub при каждом запуске было бы шумом.
 */
export function UpdateWatchHost({ enabled }: { enabled: boolean }) {
  const state = useRef<UpdateWatchState>(emptyUpdateWatchState());
  const running = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: number | undefined;

    const attempt = async (): Promise<boolean> => {
      if (disposed || running.current) return false;
      running.current = true;
      try {
        const status = await updateStatus();
        if (disposed) return false;
        // На не-Windows обновление неподдерживаемо — не ходим зря.
        if (!status.supported) return false;
        const installed = status.installedSequence;
        if (!shouldCheck(state.current, installed, Date.now())) return false;

        state.current = { ...state.current, lastAttemptAt: Date.now(), installedSequence: installed };
        const info = await updateCheck();
        if (disposed) return false;
        if (!info || !shouldAnnounce(state.current, info.sequence, installed)) return false;

        state.current = { ...state.current, announcedSequence: info.sequence };
        const text = announcementText(info.sequence, info.version);
        showAppNotification(text.title, text.body, 'info', {
          dedupeKey: `update:${info.sequence}`,
          expiresAfterMs: 30_000,
        });
        try {
          await recordNotification('update.available', journalText(info.sequence, installed));
        } catch {
          // Журнал недоступен — уведомление уже показано, повторять нечего.
        }
        return true;
      } catch {
        // Нет сети, канал недоступен, нет прав — молчим и ждём следующего раза.
        return false;
      } finally {
        running.current = false;
      }
    };

    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        void attempt().finally(() => {
          if (!disposed) schedule(CHECK_INTERVAL_MS);
        });
      }, delay);
    };
    schedule(FIRST_CHECK_DELAY_MS);

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled]);

  return null;
}
