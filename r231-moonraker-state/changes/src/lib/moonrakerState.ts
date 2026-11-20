/**
 * Преобразования состояния Moonraker, не зависящие от клиента.
 *
 * Здесь только чистые функции: на вход значение, на выход фрагмент статуса.
 * Они не читают поля клиента, не ходят в сеть и не пишут в хранилище — именно
 * поэтому их можно проверить отдельно, не поднимая ни клиента, ни IPC-мост.
 *
 * Вынесено из MoonrakerClient, чтобы класс перестал быть единственным местом,
 * где живёт вся логика протокола.
 */
import type { MoonrakerChannel } from './connectionReliability';
import type { PrinterStatus } from '../types';
import type { PrinterActorPhase, PrinterActorSnapshot } from './printerActorBridge';
import type { JsonRecord } from './moonrakerPayload';

/** Порт Moonraker по умолчанию: штатный 7125 или Creality 80. */
export type MoonrakerDefaultPort = 80 | 7125;

/** Транспорт, выбранный для конкретной попытки связи с K1C. */
export type K1CTransport = { protocol: 'websocket' | 'rest' | 'jsonrpc'; defaultPort: MoonrakerDefaultPort };

/** Состояние связи, когда актор ещё не подтвердил соединение. */
export function actorDisconnectedPatch(phase: PrinterActorPhase, lastError?: string): Partial<PrinterStatus> {
  if (phase === 'degraded' || phase === 'recovering') {
    return {
      connectionState: 'degraded',
      connectionReason: 'daemon_recovering',
      connectionMessage: lastError || 'PrinterActor восстанавливается',
    };
  }
  return {
    connectionState: 'connecting',
    connectionReason: 'connecting',
    connectionMessage: lastError || 'PrinterActor подключает WebSocket',
  };
}

/** Состояние связи из подтверждённого представления актора. */
export function actorPresentationPatch(snapshot: PrinterActorSnapshot): Partial<PrinterStatus> {
  const presentation = snapshot.presentation;
  // Поколение представления обязано совпадать с эпохой сессии: иначе это
  // снимок от прошлого подключения, и применять его нельзя.
  if (!presentation || presentation.generation !== snapshot.sessionEpoch) return {};
  const protocol = ['websocket', 'rest', 'jsonrpc'].includes(presentation.channel)
    ? presentation.channel as PrinterStatus['connectionProtocol']
    : undefined;
  return {
    connectionState: presentation.connectionState,
    connectionReason: presentation.reason,
    connectionMessage: presentation.message,
    connectionProtocol: protocol,
    connectionPort: presentation.port,
  };
}

/** Есть ли в ответе температура хотя бы одного нагревателя. */
export function hasHeaterTelemetry(status: JsonRecord): boolean {
  const numeric = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ||
    typeof value === 'string' && Number.isFinite(Number.parseFloat(value));
  return numeric(status.extruder?.temperature) || numeric(status.heater_bed?.temperature);
}

/** Есть ли в ответе сведения о задании. */
export function hasJobTelemetry(status: JsonRecord): boolean {
  return status.print_stats?.state !== undefined ||
    status.print_stats?.filename !== undefined ||
    status.virtual_sdcard?.progress !== undefined;
}

/**
 * Стоит ли пробовать другой транспорт после ошибки.
 *
 * Отказ авторизации не лечится сменой транспорта: оба канала используют тот же
 * сохранённый ключ, и повтор только повторит отказ.
 */
export function k1cAlternateTransportAllowed(error: unknown): boolean {
  return !/(?:http(?: error)?[: ]+)?(?:401|403)\b|forbidden|unauthori[sz]ed|api[ _-]?key/i
    .test(String(error instanceof Error ? error.message : error));
}

/** Короткая подпись транспорта для сообщений оператору. */
export function k1cTransportLabel(transport: K1CTransport): string {
  const protocol = transport.protocol === 'websocket' ? 'WS' : transport.protocol === 'rest' ? 'REST' : 'JSON-RPC';
  return `${protocol}:${transport.defaultPort}`;
}

export function transportFromChannel(channel: MoonrakerChannel): K1CTransport {
  return { protocol: channel.protocol, defaultPort: channel.port as MoonrakerDefaultPort };
}

export function channelFromTransport(transport: K1CTransport): MoonrakerChannel {
  return { protocol: transport.protocol, port: transport.defaultPort } as MoonrakerChannel;
}

/**
 * Ограниченный параллельный опрос: не больше `limit` запросов одновременно.
 * Возвращает результаты в порядке исходного массива, а не завершения.
 */
export async function settleRequests(
  workers: Array<() => Promise<unknown>>,
  limit = 2,
): Promise<Array<PromiseSettledResult<unknown>>> {
  const results = new Array<PromiseSettledResult<unknown>>(workers.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), workers.length) }, async () => {
    while (cursor < workers.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await workers[index]() }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}
