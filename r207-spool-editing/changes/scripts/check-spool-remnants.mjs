// Объединение мелких остатков: чистая логика модели, без интерфейса.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  stdin: {
    contents: "export { reduceFilamentInventory, emptyFilamentInventory } from './src/lib/filamentInventory';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { reduceFilamentInventory, emptyFilamentInventory } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

let clock = 1_700_000_000_000;
const step = (state, command) => { clock += 1000; return reduceFilamentInventory(state, command, clock).state; };
const addSpools = (state, material, count, grams, extra = {}) =>
  step(state, { type: 'add-spools', material, count, weightGrams: grams, source: 'purchase', ...extra });

// Три катушки по 2, 3 и 4 грамма → одна на 9.
let s = emptyFilamentInventory(clock);
s = addSpools(s, 'PETG', 1, 2); s = addSpools(s, 'PETG', 1, 3); s = addSpools(s, 'PETG', 1, 4);
assert.equal(s.spools.length, 3);
const ids = s.spools.map(spool => spool.id);
s = step(s, { type: 'merge-spool-remnants', material: 'PETG', spoolIds: ids });
assert.equal(s.spools.length, 1, 'три катушки становятся одной');
assert.equal(Math.round(s.spools[0].remainingWeight), 9, 'вес складывается');

// Разные материалы сливать нельзя.
let m = emptyFilamentInventory(clock);
m = addSpools(m, 'PETG', 1, 3); m = addSpools(m, 'PLA', 1, 3);
assert.throws(() => step(m, { type: 'merge-spool-remnants', material: 'PETG', spoolIds: m.spools.map(x => x.id) }),
  /разных материалов/);

// Крупные катушки не объединяем: иначе «сборка остатков» съест целую.
let big = emptyFilamentInventory(clock);
big = addSpools(big, 'PETG', 1, 3); big = addSpools(big, 'PETG', 1, 800);
assert.throws(() => step(big, { type: 'merge-spool-remnants', material: 'PETG', spoolIds: big.spools.map(x => x.id) }),
  /только остатки до/);

// Одной катушки недостаточно.
let one = emptyFilamentInventory(clock);
one = addSpools(one, 'PETG', 1, 3);
assert.throws(() => step(one, { type: 'merge-spool-remnants', material: 'PETG', spoolIds: [one.spools[0].id] }),
  /хотя бы две/);

console.log('Spool remnants: merge sums small same-material spools, refuses mixed material and full spools');
