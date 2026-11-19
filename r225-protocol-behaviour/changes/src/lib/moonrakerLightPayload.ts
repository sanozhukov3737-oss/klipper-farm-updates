/**
 * Разбор ответов подсветки.
 *
 * Вынесено из MoonrakerClient, потому что это чистый разбор формы ответа:
 * никакого транспорта, только проверка структуры. Так его можно проверить
 * поведенчески без сети и клиента, и он не тянет за собой остальной протокол.
 */
import { moonrakerRecord, payloadRecords } from './moonrakerPayload';

/**
 * Проверяет ответ на ошибку и возвращает его как есть.
 *
 * Ответ приходит вложенным: `{result:{...}}`, `{data:{...}}` или с ошибкой на
 * любом уровне. Ошибка может быть строкой или объектом с `message`. Раньше это
 * место было покрыто `any`, и объект без `message` ронял разбор.
 */
export function lightPayloadOf(value: unknown): unknown {
  for (const row of payloadRecords(value)) {
    const failure = row.error;
    if (failure === undefined || failure === null) continue;
    const message = moonrakerRecord(failure)?.message;
    throw new Error('Подсветка: ' + String(typeof failure === 'string' ? failure : message ?? JSON.stringify(failure)).slice(0, 200));
  }
  return value;
}
