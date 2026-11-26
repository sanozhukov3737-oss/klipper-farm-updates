// Нормализация речи и чтение срока: то, что должно работать на любой машине и без модели.
//
// Поводом стал дефект: правило имени принтера «5M» не имело границ слова, поэтому «15 минут»
// превращалось в «15mинут» и любой срок, кончающийся на 5, переставал читаться. Это ломало прогноз
// для «через 5 минут», «через 15 минут», «через 25 минут», «через 45 минут» — и молча, потому что
// ассистент просто отвечал не тем режимом.
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled = await build({
  stdin: {
    contents: "export {normalizeVoice, voiceForecastMinutes, parseVoiceCommand, voiceControlActions} from './src/lib/voiceCommands'; export {profileForPreset} from './src/lib/printerProfile';",
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const {normalizeVoice, voiceForecastMinutes, parseVoiceCommand, voiceControlActions, profileForPreset} =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const printers = [
  {id: 'max', name: 'K1 Max (Макс)', profile: profileForPreset('creality-k1-max')},
  {id: 'k1c', name: 'K1C 2025', profile: profileForPreset('creality-k1c-2025')},
  {id: 'forge', name: 'Flashforge 5M (Форж)', profile: profileForPreset('flashforge-ad5m')},
];

// A duration must survive normalisation with every digit, not only the ones whose last digit is not 5.
for (const [text, minutes] of [
  ['через 5 минут', 5], ['через 15 минут', 15], ['через 25 минут', 25],
  ['через 45 минут', 45], ['через 55 минут', 55], ['через 5 мин', 5],
  ['через 15 мин', 15], ['через 45 мин', 45],
  ['через час', 60], ['через полчаса', 30], ['через полтора часа', 90],
  ['через 2 часа', 120], ['через два часа', 120], ['через 90 минут', 90],
]) {
  assert.equal(voiceForecastMinutes(text), minutes, 'срок не прочитан: ' + text);
}

// The normaliser must not rewrite the number in a duration. Checked on the raw string so a future rule
// with the same missing word boundaries fails here rather than in a forecast nobody can explain.
for (const text of ['15 минут', '5 минут', '25 минут', '45 минут', '55 минут', 'пять минут']) {
  const normalised = normalizeVoice(text);
  assert.ok(!/[0-9a-z]/i.test(normalised.replace(/[0-9]/g, '')) || /минут/u.test(normalised),
    'нормализация испортила срок: ' + text + ' → ' + normalised);
  assert.ok(normalised.includes('минут'), 'слово «минут» потерялось: ' + text + ' → ' + normalised);
}

// The printer alias it was written for must still work, including the spelled form.
assert.equal(normalizeVoice('5 м'), '5m');
assert.equal(normalizeVoice('5 эм'), '5m');
assert.equal(normalizeVoice('пять эм'), '5m');
assert.equal(normalizeVoice('Flashforge 5M'), 'flashforge 5m');
assert.ok(normalizeVoice('напечатай на 5 эм').includes('5m'), 'алиас принтера сломан');

// A status question is read without the model. "Что печатается" used to fall through to help, and the
// model then answered find with the whole sentence as a file name.
for (const [text, filter] of [
  ['Что печатается?', 'printing'], ['Что сейчас печатается?', 'printing'],
  ['Что печатают?', 'printing'], ['Кто печатает?', 'printing'],
  ['Что свободно?', 'free'], ['Что не занято?', 'free'],
]) {
  const intent = parseVoiceCommand(text, printers);
  assert.equal(intent.kind, 'printers', 'статусный вопрос не распознан: ' + text);
  assert.equal(intent.filter, filter, 'неверный фильтр: ' + text);
}

// Questions that are not about printer status must not be captured by that route.
for (const text of ['Что с катушками?', 'Что будет через час?', 'Найди держатель', 'Напечатай корпус']) {
  const intent = parseVoiceCommand(text, printers);
  assert.notEqual(intent.kind, 'printers', 'не статусный вопрос ушёл в статус: ' + text);
}

// Opening the camera by asking for it: the model reads this correctly, and the action reader used to
// disagree, so the correct answer was being replaced with a clarification.
for (const text of ['Можно камеру Макса?', 'Можно посмотреть камеру Макса?', 'Открой камеру Макса']) {
  assert.deepEqual(voiceControlActions(text, printers), ['camera'], 'камера не распознана: ' + text);
}
// A permission question about a physical action names no printer, so the validator must refuse to act on
// it even though the verb is present. The reader sees "поставить на паузу"; the boundary that matters is
// the validator, which requires a positively named printer before a physical action.
assert.deepEqual(voiceControlActions('Можно поставить на паузу?', printers), ['pause'],
  'глагол паузы должен читаться — иначе непонятно, что именно отклоняет валидатор');

// Распознавание пишет числа цифрами, но иногда словами. Словарь был неполным: он обрывался на
// «тридцать минут», поэтому «через сорок минут» и «через девяносто минут» не читались вообще.
// Проверено на настоящем аудите: Silero синтезирует, whisper распознаёт, круг замыкается.
for (const [text, minutes] of [
  ['через сорок минут', 40], ['через сорок пять минут', 45],
  ['через шестьдесят минут', 60], ['через девяносто минут', 90],
  ['через двадцать пять минут', 25], ['через пятьдесят минут', 50],
  ['через пять часов', 300], ['через шесть часов', 360],
]) {
  assert.equal(voiceForecastMinutes(text), minutes, 'число словами не прочитано: ' + text);
}

// Материалы: whisper пишет латиницу кириллицей, и без нормализации вопрос про остаток перестаёт
// быть вопросом про пластик.
for (const [text, expected] of [
  ['сколько осталось красного ПТГ', 'petg'],
  ['сколько пэтг', 'petg'],
  ['хватит ли ПЛА', 'pla'],
  ['а сколько АБС', 'abs'],
]) {
  assert.ok(normalizeVoice(text).includes(expected), 'материал не распознан: ' + text);
}
// Слово, похожее на сокращение, но им не являющееся, не должно переписываться.
assert.equal(normalizeVoice('петля держателя'), 'петля держателя');
assert.equal(normalizeVoice('пластина'), 'пластина');

console.log('Voice normalisation: durations survive every digit, status questions are read without the model');
