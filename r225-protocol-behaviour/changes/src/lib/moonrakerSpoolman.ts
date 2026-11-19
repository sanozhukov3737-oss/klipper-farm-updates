/**
 * Разбор ответа Spoolman о списке катушек.
 *
 * Вынесено из MoonrakerClient: это чистая проверка формы ответа, без
 * транспорта. Разные версии Moonraker и Spoolman отвечают по-разному —
 * массив под `response`, под `result` или как весь ответ, — и раньше любой
 * из этих вариантов, кроме одного, молча давал пустой список. Оператор видел
 * «катушек нет» вместо своих катушек.
 */
import { moonrakerRecord, payloadRecords } from './moonrakerPayload';

/** Сообщение об ошибке из ответа, если оно есть. */
export function spoolmanFailure(payload: unknown): string | undefined {
  for (const level of payloadRecords(payload)) {
    const failure = level.error;
    if (failure === undefined || failure === null) continue;
    const message = moonrakerRecord(failure)?.message;
    // Строковая ошибка раньше давала «Spoolman error» без причины.
    return String(message ?? (typeof failure === 'string' ? failure : 'Spoolman error'));
  }
  return undefined;
}

/** Список катушек из ответа: массив ищется под response, result или в самом ответе. */
export function spoolmanSpoolsFrom(payload: unknown): unknown[] {
  const levels = payloadRecords(payload);
  const fromResponse = levels.map(level => level.response).find(value => Array.isArray(value));
  if (fromResponse) return fromResponse;
  if (Array.isArray(payload)) return payload;
  const nested = levels.find(level => Array.isArray(level.result))?.result;
  return Array.isArray(nested) ? nested : [];
}
