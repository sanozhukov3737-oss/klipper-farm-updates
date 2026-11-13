import type { PrinterStatus } from '../types';

export type PrinterFaultNotice = { message: string; controller: boolean; episode: number };

/**
 * Причина отказа по-русски вместо сырого текста Klipper.
 *
 * Klipper пишет причину по-английски: «Heater extruder not heating at expected
 * rate», «Move out of range: 220.5 0.0 10.0». Синтез речи вырезает латиницу,
 * поэтому озвучка превращалась в обрывки: «ошибка.: эм си ю» или просто
 * «ошибка». Оператор терял саму причину.
 *
 * Здесь сообщение распознаётся по ключевым словам и переводится в короткую
 * русскую фразу для слуха. Полный текст остаётся в журнале и на экране.
 */
export function printerFaultReason(message?: string): string {
  const text = String(message ?? '').toLowerCase();
  if (!text.trim()) return 'причина не передана, подробности в журнале';
  const known: [RegExp, string][] = [
    [/heater|extruder.*heat|heating/, 'не нагревается хотэнд'],
    [/thermistor|temperature.*sensor|adc out of range/, 'неисправен датчик температуры'],
    [/bed.*heat|heated bed/, 'не нагревается стол'],
    [/mcu.*shutdown|shutdown.*mcu|lost communication.*mcu/, 'сбой платы управления'],
    [/move out of range|out of range/, 'координата вне области печати'],
    [/timer too close/, 'плата не успевает отвечать'],
    [/filament.*runout|runout/, 'закончился пластик'],
    [/thermal runaway/, 'аварийный перегрев'],
    [/klippy.*shutdown|klipper.*shutdown/, 'Klipper остановлен'],
    [/homing|endstop|probe/, 'ошибка датчика положения'],
    [/sdcard|sd card|file.*read/, 'ошибка чтения файла'],
    [/usb|connection.*lost/, 'потеряна связь с принтером'],
    [/unknown command/, 'принтер не понял команду'],
  ];
  for (const [pattern, reason] of known) if (pattern.test(text)) return reason;
  return 'причина не распознана, подробности в журнале';
}

export function printerFault(status: PrinterStatus): Omit<PrinterFaultNotice, 'episode'> | undefined {
  if (status.remoteControlSuspended || status.connectionState === 'offline'
    || status.connectionReason === 'quarantine' || status.connectionReason === 'authorization') return;
  // Klipper "disconnected"/"startup" means the firmware is restarting while
  // Moonraker stays reachable — Creality controllers do this routinely right
  // after the last layer, so it must not sound like a controller fault. A
  // stale "klipper_shutdown" reason can also outlive the restart for a frame
  // once klippyState is back to "ready"; that is recovery, not a fault. A
  // genuine shutdown still reports klippyState "shutdown"/"error" and is
  // announced; the reason alone speaks only when the klippy state is unknown.
  const controller = status.klippyState === 'shutdown' || status.klippyState === 'error'
    || ((status.connectionReason === 'klipper_shutdown' || status.connectionReason === 'klipper_error')
      && status.klippyState !== 'disconnected' && status.klippyState !== 'ready'
      && status.klippyState !== 'startup');
  const printError = status.state === 'error' && status.printStatsState === 'error'
    && (status.connectionState === 'online' || status.connectionState === 'degraded');
  if (!controller && !printError) return;
  return {
    controller,
    message: (controller ? status.connectionMessage || status.message : status.message)
      ?.trim().slice(0, 1500) || 'Принтер сообщил об ошибке. Проверьте его экран.',
  };
}

// Explicit firmware faults are confirmed events, even if the transport is
// recovering or no printing -> error transition was observed by this window.
export class PrinterFaultNoticeTracker {
  private items = new Map<string, { announced: boolean; episode: number }>();

  observe(id: string, status: PrinterStatus): PrinterFaultNotice | undefined {
    let item = this.items.get(id);
    if (!item) { item = { announced: false, episode: 0 }; this.items.set(id, item); }
    const fault = printerFault(status);
    if (!fault) {
      // An outage does not re-arm the same fault. Wait for healthy live data.
      if (status.connectionState === 'online' && status.klippyState === 'ready'
        && status.state !== 'error' && status.printStatsState !== 'error') item.announced = false;
      return;
    }
    if (item.announced) return;
    item.announced = true;
    return { ...fault, episode: ++item.episode };
  }

  retain(ids: ReadonlySet<string>) {
    for (const id of this.items.keys()) if (!ids.has(id)) this.items.delete(id);
  }
}
