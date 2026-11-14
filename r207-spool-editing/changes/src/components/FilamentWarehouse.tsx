import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowLeftRight, PackagePlus, Pencil, QrCode, Search, Trash2, X } from 'lucide-react';
import type { FilamentFinish, PrinterModel, Spool } from '../types';
import type { FilamentInventory } from '../lib/filamentInventory';
import { normalizeFilamentMaterial } from '../lib/filamentInventory';
import { FILAMENT_FINISH_LABELS, filamentColor, spoolOwner } from '../lib/filamentSpool';
import { FilamentSpoolViewer } from './FilamentSpoolViewer';
import { SpoolQr } from './SpoolQr';
import styles from './FilamentWarehouse.module.css';

const weight = (grams: number) => grams >= 1000 ? `${(grams / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кг` : `${grams.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} г`;
const fraction = (spool: Spool) => Math.min(1, spool.remainingWeight / spool.initialWeight);
const colorStyle = (color?: string) => ({ '--filament-color': filamentColor(color) } as CSSProperties);
const PALETTE = ['#f47b24', '#ed415d', '#2799ef', '#20b784', '#aa6bea', '#33363b'];
type Props = {
  inventory: FilamentInventory; printers: PrinterModel[]; canOperate: boolean; busy: boolean;
  revealSpoolId?: string;
  onAdd: () => void; onEdit: (spool: Spool) => void; onAssign: (spool: Spool) => void; onRemove: (spool: Spool) => void;
  onAppearance: (spool: Spool, patch: { color?: string; finish?: FilamentFinish }) => Promise<boolean>;
  // Быстрая правка остатка прямо из списка: без открытия панели и формы.
  onRemaining?: (spool: Spool, grams: number) => Promise<boolean>;
  // Схлопывание мелких остатков одного материала, цвета и поверхности.
  onMergeRemnants?: (material: string, spoolIds: string[]) => Promise<boolean>;
};

export function FilamentWarehouse({ inventory, printers, canOperate, busy, onAdd, onEdit, onAssign, onRemove, onAppearance, onRemaining, onMergeRemnants, revealSpoolId }: Props) {
  const [query, setQuery] = useState(''), [material, setMaterial] = useState(''), [location, setLocation] = useState('active');
  const [selectedId, setSelectedId] = useState(''), [qrId, setQrId] = useState('');
  // Порог, ниже которого остаток считается мелким и предлагается к объединению.
  const REMNANT_GRAMS = 5;
  const [editGrams, setEditGrams] = useState<{ id: string; value: string }>();
  useEffect(() => {
    if (!revealSpoolId) return;
    setSelectedId(revealSpoolId); setQuery(''); setMaterial(''); setLocation('active');
  }, [revealSpoolId]);
  const materials = [...new Set(inventory.spools.map(spool => normalizeFilamentMaterial(spool.material)))];
  const visible = useMemo(() => inventory.spools.filter(spool => {
    const term = query.trim().toLocaleLowerCase('ru-RU'), owner = spoolOwner(inventory, spool);
    const name = printers.find(printer => printer.id === owner)?.name ?? '';
    return (!material || normalizeFilamentMaterial(spool.material) === material)
      && (!term || `${spool.name} ${spool.material} ${spool.color ?? ''} ${name}`.toLocaleLowerCase('ru-RU').includes(term))
      && (location === 'all' || location === 'active' && spool.remainingWeight > 0 || location === 'shelf' && !owner && spool.remainingWeight > 0 || location === 'printer' && !!owner && spool.remainingWeight > 0 || location === 'low' && spool.remainingWeight > 0 && fraction(spool) <= .2 || location === 'empty' && spool.remainingWeight === 0);
  }), [inventory, material, location, query, printers]);
  const remnantGroups = useMemo(() => {
    const groups = new Map<string, Spool[]>();
    for (const spool of visible) {
      if (!(spool.remainingWeight > 0) || spool.remainingWeight > REMNANT_GRAMS) continue;
      // Группируем по материалу, цвету и поверхности: только такие катушки
      // физически можно слить в одну.
      const key = [normalizeFilamentMaterial(spool.material), (spool.color ?? '').toLowerCase(), spool.finish ?? 'normal'].join('|');
      const rows = groups.get(key); if (rows) rows.push(spool); else groups.set(key, [spool]);
    }
    return [...groups.values()].filter(rows => rows.length > 1);
  }, [visible]);
  const selected = visible.find(spool => spool.id === selectedId) ?? visible[0];
  const owner = selected ? spoolOwner(inventory, selected) : undefined;
  const reset = () => { setQuery(''); setMaterial(''); setLocation('active'); };
  const diameter = (spool: Spool) => inventory.materials[normalizeFilamentMaterial(spool.material)]?.diameter;
  return <section className={styles.warehouse} aria-label="Визуальный склад катушек">
    <div className={styles.filters}>
      <label className={styles.search}><Search aria-hidden="true"/><input aria-label="Найти катушку" placeholder="Название, цвет или принтер" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" aria-label="Очистить поиск" onClick={() => setQuery('')}><X aria-hidden="true"/></button>}</label>
      <select aria-label="Материал катушек" value={material} onChange={event => setMaterial(event.target.value)}><option value="">Все материалы</option>{materials.map(value => <option value={value} key={value}>{value}</option>)}</select>
      <select aria-label="Расположение катушек" value={location} onChange={event => setLocation(event.target.value)}><option value="active">С пластиком</option><option value="shelf">На складе</option><option value="printer">На принтерах</option><option value="low">Осталось ≤ 20%</option><option value="empty">Пустые</option><option value="all">Все катушки</option></select>
      <span className={styles.resultCount}>Найдено: {visible.length}</span>
    </div>
    {(onMergeRemnants && canOperate && !busy && remnantGroups.length > 0) && <section className={styles.remnantBlock} aria-label="Мелкие остатки">
      <div className={styles.remnantHead}><b>Мелкие остатки</b><span>до {REMNANT_GRAMS} г · можно слить в одну катушку</span></div>
      {remnantGroups.map(rows => <div key={rows.map(row => row.id).join(',')} className={styles.remnantRow}>
        <span>{rows[0].material}{rows[0].color ? ' · ' + rows[0].color.toUpperCase() : ''} · {rows.length} шт · {Math.round(rows.reduce((sum, row) => sum + row.remainingWeight, 0))} г</span>
        <button type="button" onClick={() => void onMergeRemnants(rows[0].material, rows.map(row => row.id))}><ArrowLeftRight aria-hidden="true"/>Собрать в одну</button>
      </div>)}
    </section>}
    {selected && <section id="filament-selected-spool" className={styles.selectedCard} style={colorStyle(selected.color)} aria-label="Выбранная катушка">
        <FilamentSpoolViewer spool={selected} diameter={diameter(selected)}/>
        <div className={styles.selectedDetails} data-testid="filament-selected-details">
          <div className={styles.selectedHeading}><span>{owner ? `Установлена · ${printers.find(printer => printer.id === owner)?.name ?? 'Принтер недоступен'}` : 'На складе'}</span><button type="button" disabled={!canOperate || busy || !owner && selected.remainingWeight <= 0} onClick={() => onAssign(selected)}><ArrowLeftRight aria-hidden="true"/>{owner ? 'Сменить пластик' : 'Назначить принтеру'}</button></div>
          <div className={styles.identity}><h4>{selected.material} <span>{selected.finish === 'silk' ? 'Silk' : selected.finish === 'matte' ? 'Матовый' : ''}</span></h4><p>{selected.name}</p></div>
          <label className={styles.spoolChoice}>Катушка<select aria-label="Выбрать отдельную катушку" value={selected.id} onChange={event => setSelectedId(event.target.value)}>{visible.map(spool => <option key={spool.id} value={spool.id}>{spool.name} · {weight(spool.remainingWeight)}</option>)}</select></label>
          <fieldset className={styles.appearance} disabled={!canOperate || busy}><legend className={styles.srOnly}>Вид пластика</legend>
            <div className={styles.colorControls}><span className={styles.colorLabel}>Цвет <small>{selected.color ? selected.color.toUpperCase() : 'не указан'}</small></span><div className={styles.palette} role="group" aria-label="Цвет пластика">{PALETTE.map(color => <button type="button" key={color} style={{ '--swatch': color } as CSSProperties} aria-label={`Цвет ${color}`} aria-pressed={selected.color?.toLowerCase() === color} onClick={() => void onAppearance(selected, { color })}/>)}</div><label className={styles.customColor}><span className={styles.srOnly}>Свой цвет</span><input type="color" aria-label="Выбрать свой цвет пластика" value={filamentColor(selected.color)} onChange={event => void onAppearance(selected, { color: event.target.value })}/></label></div>
            <label className={styles.spoolChoice}>Поверхность<select aria-label="Поверхность пластика" value={selected.finish ?? 'normal'} onChange={event => void onAppearance(selected, { finish: event.target.value as FilamentFinish })}>{Object.entries(FILAMENT_FINISH_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          </fieldset>
          <div className={styles.weightBlock}><div className={styles.selectedWeight}><span>Остаток пластика <b>{Math.round(fraction(selected) * 100)}%</b></span><div><output data-testid="filament-selected-grams">{selected.remainingWeight.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}</output> г <small>/ {selected.initialWeight.toLocaleString('ru-RU')} г</small></div></div><div className={styles.inspectorMeter} role="meter" aria-label="Остаток выбранной катушки" aria-valuemin={0} aria-valuemax={selected.initialWeight} aria-valuenow={selected.remainingWeight} aria-valuetext={`${weight(selected.remainingWeight)} из ${weight(selected.initialWeight)}`}><span style={{ width: `${fraction(selected) * 100}%` }}/></div></div>
          {selected.remainingWeight === 0 && <p className={styles.emptyWarning}>Катушка закончилась</p>}
          <div className={styles.selectedActions}>{(onRemaining && canOperate && !busy) && <label className={styles.quickRemaining}>
  <span className={styles.srOnly}>Остаток, граммы</span>
  <input type="number" inputMode="decimal" min={0} step={1} aria-label={`Остаток катушки ${selected.name}, граммы`}
    value={editGrams?.id === selected.id ? editGrams.value : String(Math.round(selected.remainingWeight))}
    onChange={event => setEditGrams({ id: selected.id, value: event.target.value })}
    onBlur={async event => {
      const raw = Number(event.target.value.replace(',', '.'));
      // Пустое или нечисловое поле возвращает прежнее значение, чтобы случайный
      // клик по строке не обнулял учёт.
      if (!Number.isFinite(raw) || raw < 0) { setEditGrams(undefined); return; }
      if (Math.round(raw) === Math.round(selected.remainingWeight)) { setEditGrams(undefined); return; }
      await onRemaining(selected, raw);
      setEditGrams(undefined);
    }}/>
  <span>г</span>
</label>}
<button type="button" disabled={!canOperate || busy} onClick={() => onEdit(selected)}><Pencil aria-hidden="true"/>Остаток и цвет</button><button type="button" aria-expanded={qrId === selected.id} onClick={() => setQrId(qrId === selected.id ? '' : selected.id)}><QrCode aria-hidden="true"/>QR</button><button type="button" className={styles.deleteButton} aria-label={`Удалить катушку ${selected.name}`} disabled={!canOperate || busy} onClick={() => onRemove(selected)}><Trash2 aria-hidden="true"/></button></div>
          {qrId === selected.id && <div className={styles.qr}><SpoolQr value={`klipper-spool://${selected.id}`} size={150}/><small>QR этой катушки</small></div>}
          {selected.price > 0 && <small className={styles.price}>Цена катушки · {selected.price.toLocaleString('ru-RU')} {selected.currency}</small>}
        </div>
      </section>}
    {!visible.length && inventory.spools.length > 0 && <div className={styles.noResults}><Search aria-hidden="true"/><b>Катушки не найдены</b><p>Попробуйте другой цвет, материал или расположение.</p><button type="button" onClick={reset}>Сбросить фильтры</button></div>}
    {!inventory.spools.length && <div className={styles.noResults}><PackagePlus aria-hidden="true"/><b>Добавьте первую катушку</b><p>Можно выделить её из уже учтённого запаса или оформить покупку.</p><button type="button" onClick={onAdd} disabled={!canOperate || busy}>Новая катушка</button></div>}
  </section>;
}
