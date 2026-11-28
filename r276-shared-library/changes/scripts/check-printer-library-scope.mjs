// Общая библиотека одинаковых принтеров: неудачный опрос не должен её разрывать.
//
// Оператор сообщил: два одинаковых Ender 3 V3 KE, и у одного «флешка» перестала быть общей. Причина —
// applyModelDetection при decision==='unknown' затирал подтверждённый пресет в custom, а
// localLibraryScopeId для custom возвращает printer.id вместо model:<модель>. Достаточно одного
// неотвеченного опроса при автоматическом переопределении, чтобы файлы «исчезли» из общего списка.
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled = await build({
  stdin: {
    contents: "export {applyModelDetection} from './src/lib/modelSelection';"
      + "export {localLibraryScopeId, localLibraryIsSharedByModel, localLibraryScopeLabel} from './src/lib/localLibraryScope';"
      + "export {profileForPreset} from './src/lib/printerProfile';",
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const {applyModelDetection, localLibraryScopeId, localLibraryIsSharedByModel, localLibraryScopeLabel, profileForPreset} =
  await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const PRESET = 'ender3-v3-ke';
const printer = (id, preset = PRESET) => ({
  id, name: 'Ender ' + id, host: '192.168.1.' + id,
  profile: profileForPreset(preset),
  modelSelection: {mode: 'automatic', selectedPreset: preset, source: 'detection', updatedAt: 1},
});
const detect = (decision, model, extra = {}) => ({
  decision, model, confidence: decision === 'confirmed' ? 'high' : decision === 'probable' ? 'medium' : 'unknown',
  status: decision === 'conflict' ? 'ambiguous' : decision === 'unknown' ? 'unknown' : 'matched',
  score: decision === 'confirmed' ? 100 : decision === 'conflict' ? 40 : 0,
  margin: decision === 'confirmed' ? 60 : decision === 'conflict' ? 4 : 0,
  evidence: [], groups: [], ...extra,
});

const first = printer(101);
const second = printer(102);

// Два одинаковых принтера делят одну библиотеку.
assert.equal(localLibraryScopeId(first), 'model:' + PRESET);
assert.equal(localLibraryScopeId(first), localLibraryScopeId(second), 'одинаковые принтеры делят библиотеку');
assert.equal(localLibraryIsSharedByModel(first), true);

// Опрос без данных: модель, профиль и ключ библиотеки остаются прежними.
const unanswered = applyModelDetection(second, detect('unknown', 'custom'));
assert.equal(unanswered.modelSelection.selectedPreset, PRESET, 'неотвеченный опрос не должен забывать модель');
assert.equal(unanswered.profile.preset, PRESET, 'неотвеченный опрос не должен сбрасывать профиль');
assert.equal(localLibraryScopeId(unanswered), localLibraryScopeId(first), 'библиотека не должна разрываться');
assert.equal(localLibraryIsSharedByModel(unanswered), true);
assert.equal(unanswered.modelSelection.lastDetection.decision, 'unknown', 'результат опроса всё равно записан');

// Противоречивые признаки: пресет тоже сохраняется, разбирает оператор.
const conflicting = applyModelDetection(second, detect('conflict', 'custom'));
assert.equal(conflicting.modelSelection.selectedPreset, PRESET, 'конфликт не должен забывать модель');
assert.equal(localLibraryScopeId(conflicting), localLibraryScopeId(first), 'конфликт не должен рвать библиотеку');

// Замена принтера по-прежнему определяется.
const replaced = applyModelDetection(second, detect('confirmed', 'ender3-v3-se'));
assert.equal(replaced.modelSelection.selectedPreset, 'ender3-v3-se', 'уверенное совпадение меняет модель');
assert.notEqual(localLibraryScopeId(replaced), localLibraryScopeId(first), 'другая модель — своя библиотека');
assert.equal(localLibraryIsSharedByModel(replaced), true, 'известная модель снова делит библиотеку по модели');

// Неизвестная модель остаётся отдельной: её совместимость вывести нельзя.
const custom = {id: 103, name: 'Самодельный', host: '192.168.1.103', profile: profileForPreset('custom')};
assert.equal(localLibraryScopeId(custom), 103, 'custom держит собственный ключ');
assert.equal(localLibraryIsSharedByModel(custom), false);
assert.equal(localLibraryScopeLabel(custom), 'Самодельный', 'подпись берётся из имени принтера');

console.log('Printer library scope: unanswered probes keep the shared library, confirmed matches still re-key it');
