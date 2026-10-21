import type { Spool } from '../types';
import { materialSummary, normalizeFilamentMaterial, type FilamentInventory } from './filamentInventory';
import type { FilamentSpoolDescriptor } from './spool-viewer.mjs';

export const FILAMENT_FINISH_LABELS = { normal: 'Обычный пластик', silk: 'Шёлк · Silk', matte: 'Матовый' };
export function filamentColor(value?: string) {
  if (/^#[\da-f]{6}$/i.test(value ?? '')) return value!;
  if (/^#[\da-f]{3}$/i.test(value ?? '')) return `#${[...value!.slice(1)].map(c => c + c).join('')}`;
  return '#9299a4';
}
export function spoolDescriptor(spool: Spool, diameterMM = 1.75): FilamentSpoolDescriptor {
  return { id: spool.id, material: spool.material, color: filamentColor(spool.color), grams: spool.remainingWeight,
    capacityGrams: spool.initialWeight, diameterMM, finish: spool.finish ?? 'normal',
    ...(typeof spool.serial === 'string' && spool.serial ? { serial: spool.serial } : {}), ...(typeof spool.lot === 'string' && spool.lot ? { lot: spool.lot } : {}),
    ...(validEAN8(spool.barcode) ? { barcode: spool.barcode } : {}),
    ...(Number.isInteger(spool.ordinal) && spool.ordinal! > 0 && spool.ordinal! <= 9999 ? { ordinal: spool.ordinal } : {}) };
}
function validEAN8(value: unknown): value is string {
  return typeof value === 'string' && /^\d{8}$/.test(value) && (10 - [...value.slice(0, 7)].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 1 : 3), 0) % 10) % 10 === Number(value[7]);
}
export function spoolOwner(inventory: FilamentInventory, spool: Spool) {
  return Object.entries(inventory.printers).find(([, printer]) => printer.binding?.spoolId === spool.id)?.[0] ?? spool.printerId;
}
export function filamentStockOverview(inventory: FilamentInventory) {
  // Restoration rejects duplicate IDs. Deduplication also makes display robust
  // to a provisional legacy snapshot; assigning never creates another spool.
  const spools = [...new Map(inventory.spools.map(spool => [spool.id, spool])).values()];
  const active = spools.filter(spool => spool.remainingWeight > 0);
  const mounted = active.filter(spool => !!spoolOwner(inventory, spool)).length;
  const rows = materialSummary({ ...inventory, spools });
  return { totalGrams: rows.reduce((sum, row) => sum + row.totalGrams, 0),
    looseGrams: rows.reduce((sum, row) => sum + row.looseGrams, 0), count: active.length, mounted,
    warehouse: active.length - mounted,
    materials: rows.filter(row => row.totalGrams > 0 || spools.some(spool => normalizeFilamentMaterial(spool.material) === row.material))
      .map(row => ({ ...row, count: active.filter(spool => normalizeFilamentMaterial(spool.material) === row.material).length,
        spool: active.find(spool => normalizeFilamentMaterial(spool.material) === row.material) })) };
}
