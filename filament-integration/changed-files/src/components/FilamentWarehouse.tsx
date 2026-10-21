import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowLeftRight, Check, Layers3, PackagePlus, Pencil, Printer, QrCode, Search, Trash2, X } from 'lucide-react';
import type { FilamentFinish, PrinterModel, Spool } from '../types';
import type { FilamentInventory } from '../lib/filamentInventory';
import { normalizeFilamentMaterial } from '../lib/filamentInventory';
import { FILAMENT_FINISH_LABELS, filamentColor, filamentStockOverview, spoolOwner } from '../lib/filamentSpool';
import { FilamentSpoolThumbnail } from './FilamentSpoolThumbnail';
import { FilamentSpoolViewer } from './FilamentSpoolViewer';
import { SpoolQr } from './SpoolQr';
import styles from './FilamentWarehouse.module.css';

const weight = (grams: number) => grams >= 1000 ? `${(grams / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кг` : `${grams.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} г`;
const kilograms = (grams: number) => (grams / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
const fraction = (spool: Spool) => Math.min(1, spool.remainingWeight / spool.initialWeight);
const colorStyle = (color?: string) => ({ '--filament-color': filamentColor(color) } as CSSProperties);
const PALETTE = ['#f47b24', '#ed415d', '#2799ef', '#20b784', '#aa6bea', '#33363b'];
type Props = {
  inventory: FilamentInventory; printers: PrinterModel[]; canOperate: boolean; busy: boolean;
  revealSpoolId?: string;
  onAdd: () => void; onEdit: (spool: Spool) => void; onAssign: (spool: Spool) => void; onRemove: (spool: Spool) => void;
  onAppearance: (spool: Spool, patch: { color?: string; finish?: FilamentFinish }) => Promise<boolean>;
};

export function FilamentWarehouse({ inventory, printers, canOperate, busy, onAdd, onEdit, onAssign, onRemove, onAppearance, revealSpoolId }: Props) {
  const [query, setQuery] = useState(''), [material, setMaterial] = useState(''), [location, setLocation] = useState('active');
  const [selectedId, setSelectedId] = useState(''), [qrId, setQrId] = useState('');
  useEffect(() => {
    if (!revealSpoolId) return;
    setSelectedId(revealSpoolId); setQuery(''); setMaterial(''); setLocation('active');
  }, [revealSpoolId]);
  const materials = [...new Set(inventory.spools.map(spool => normalizeFilamentMaterial(spool.material)))];
  const overview = useMemo(() => filamentStockOverview(inventory), [inventory]);
  const visible = useMemo(() => inventory.spools.filter(spool => {
    const term = query.trim().toLocaleLowerCase('ru-RU'), owner = spoolOwner(inventory, spool);
    const name = printers.find(printer => printer.id === owner)?.name ?? '';
    return (!material || normalizeFilamentMaterial(spool.material) === material)
      && (!term || `${spool.name} ${spool.material} ${spool.color ?? ''} ${name}`.toLocaleLowerCase('ru-RU').includes(term))
      && (location === 'all' || location === 'active' && spool.remainingWeight > 0 || location === 'shelf' && !owner && spool.remainingWeight > 0 || location === 'printer' && !!owner && spool.remainingWeight > 0 || location === 'low' && spool.remainingWeight > 0 && fraction(spool) <= .2 || location === 'empty' && spool.remainingWeight === 0);
  }), [inventory, material, location, query, printers]);
  const selected = visible.find(spool => spool.id === selectedId) ?? visible[0];
  const owner = selected ? spoolOwner(inventory, selected) : undefined;
  const reset = () => { setQuery(''); setMaterial(''); setLocation('active'); };
  const diameter = (spool: Spool) => inventory.materials[normalizeFilamentMaterial(spool.material)]?.diameter;
  return <section className={styles.warehouse} aria-label="Визуальный склад катушек">
    <div className={styles.product}>
      <header className={styles.productHeader}><span>KLIPPER FARM</span><span>Пластик</span></header>
      <div className={styles.overview} aria-label="Общий запас пластика">
        <div className={styles.overviewHead}>
          <div><span className={styles.eyebrow}>ОБЩИЙ ЗАПАС ПЛАСТИКА</span><div className={styles.total}><output data-testid="filament-total-kg">{kilograms(overview.totalGrams)}</output><span>кг</span></div><span className={styles.overviewCaption}>Включая катушки на принтерах{overview.looseGrams > 0 && <> · {weight(overview.looseGrams)} без катушек</>}</span></div>
          <div className={styles.counts}><div><strong data-testid="filament-nonempty-count">{overview.count}</strong><span>непустых катушек</span></div><div><strong data-testid="filament-mounted-count">{overview.mounted}</strong><span>на принтерах</span></div><div><strong data-testid="filament-warehouse-count">{overview.warehouse}</strong><span>на складе</span></div></div>
        </div>
        <div className={styles.materialOverview} role="group" aria-label="Запас по материалам">{overview.materials.map(row => <button type="button" key={row.material} aria-pressed={material === row.material} onClick={() => { setMaterial(current => current === row.material ? '' : row.material); setQuery(''); setLocation('active'); }}>
          {row.spool ? <FilamentSpoolThumbnail spool={row.spool} diameter={row.diameter} label={`Запас ${row.material}`}/> : <Layers3 aria-hidden="true"/>}<span>{row.material}</span><strong>{kilograms(row.totalGrams)} кг</strong><small>{row.count} катушек{row.looseGrams > 0 && <> · {weight(row.looseGrams)} без катушек</>}</small>
        </button>)}</div>
      </div>
      {selected && <section id="filament-selected-spool" className={styles.selectedCard} style={colorStyle(selected.color)} aria-label="Выбранная катушка">
        <FilamentSpoolViewer spool={selected} diameter={diameter(selected)}/>
        <div className={styles.selectedDetails}>
          <div><div className={styles.selectedHeading}><span>{owner ? `УСТАНОВЛЕНА · ${printers.find(printer => printer.id === owner)?.name ?? 'Принтер недоступен'}` : 'НА СКЛАДЕ'}</span><button type="button" disabled={!canOperate || busy || !owner && selected.remainingWeight <= 0} onClick={() => onAssign(selected)}><ArrowLeftRight aria-hidden="true"/>{owner ? 'Сменить пластик' : 'Назначить принтеру'}</button></div><h4>{selected.material} <span>{selected.finish === 'silk' ? 'Silk' : selected.finish === 'matte' ? 'Матовый' : ''}</span></h4><p>{selected.name}</p><small>{selected.color ? selected.color.toUpperCase() : 'Цвет не указан'}</small></div>
          <label className={styles.spoolChoice}>Катушка<select aria-label="Выбрать отдельную катушку" value={selected.id} onChange={event => setSelectedId(event.target.value)}>{visible.map(spool => <option key={spool.id} value={spool.id}>{spool.name} · {weight(spool.remainingWeight)}</option>)}</select></label>
          <fieldset className={styles.appearance} disabled={!canOperate || busy}><legend className={styles.srOnly}>Вид пластика</legend>
            <div className={styles.palette} role="group" aria-label="Цвет пластика">{PALETTE.map(color => <button type="button" key={color} style={{ '--swatch': color } as CSSProperties} aria-label={`Цвет ${color}`} aria-pressed={selected.color?.toLowerCase() === color} onClick={() => void onAppearance(selected, { color })}/>)}</div>
            <label className={styles.customColor}>Свой цвет<input type="color" aria-label="Выбрать свой цвет пластика" value={filamentColor(selected.color)} onChange={event => void onAppearance(selected, { color: event.target.value })}/></label>
            <label className={styles.spoolChoice}>Поверхность<select aria-label="Поверхность пластика" value={selected.finish ?? 'normal'} onChange={event => void onAppearance(selected, { finish: event.target.value as FilamentFinish })}>{Object.entries(FILAMENT_FINISH_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          </fieldset>
          <div className={styles.selectedWeight}><span>В выбранной катушке</span><div><output data-testid="filament-selected-grams">{selected.remainingWeight.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}</output> г <small>/ {selected.initialWeight.toLocaleString('ru-RU')} г</small></div></div>
          <div className={styles.inspectorMeter}><span style={{ width: `${fraction(selected) * 100}%` }}/></div>
          {selected.remainingWeight === 0 && <p className={styles.emptyWarning}>Катушка закончилась</p>}
          <div className={styles.selectedActions}><button type="button" disabled={!canOperate || busy} onClick={() => onEdit(selected)}><Pencil aria-hidden="true"/>Остаток и цвет</button><button type="button" aria-expanded={qrId === selected.id} onClick={() => setQrId(qrId === selected.id ? '' : selected.id)}><QrCode aria-hidden="true"/>QR</button><button type="button" className={styles.deleteButton} aria-label={`Удалить катушку ${selected.name}`} disabled={!canOperate || busy} onClick={() => onRemove(selected)}><Trash2 aria-hidden="true"/></button></div>
          {qrId === selected.id && <div className={styles.qr}><SpoolQr value={`klipper-spool://${selected.id}`} size={150}/><small>QR этой катушки</small></div>}
          {selected.price > 0 && <small className={styles.price}>Цена катушки · {selected.price.toLocaleString('ru-RU')} {selected.currency}</small>}
        </div>
      </section>}
    </div>
    <div className={styles.boardHeading}><div><span className={styles.eyebrow}>ВАШ ПЛАСТИК</span><h4>Катушки <span>{overview.count}</span></h4></div><div className={styles.boardLegend}><span/><span>На принтере</span><i/>Нажмите на катушку</div></div>
    <div className={styles.filters}>
      <label className={styles.search}><Search aria-hidden="true"/><input aria-label="Найти катушку" placeholder="Название, цвет или принтер" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" aria-label="Очистить поиск" onClick={() => setQuery('')}><X aria-hidden="true"/></button>}</label>
      <div className={styles.materialFilters} role="group" aria-label="Материал катушек">{['', ...materials].map(value => <button type="button" key={value} aria-pressed={material === value} onClick={() => setMaterial(value)}>{value || 'Все'}</button>)}</div>
      <select aria-label="Расположение катушек" value={location} onChange={event => setLocation(event.target.value)}><option value="active">С пластиком</option><option value="shelf">На складе</option><option value="printer">На принтерах</option><option value="low">Осталось ≤ 20%</option><option value="empty">Пустые</option><option value="all">Все катушки</option></select>
    </div>
    <div className={styles.shelf}>
      <div className={styles.spoolGrid} aria-label="Катушки на складе">{visible.map(spool => {
        const ownerId = spoolOwner(inventory, spool);
        return <button type="button" key={spool.id} className={styles.spoolCard} style={colorStyle(spool.color)} aria-pressed={selected?.id === spool.id} aria-controls="filament-selected-spool" aria-label={`Выбрать катушку ${spool.name}, ${spool.color || 'цвет не указан'}, ${weight(spool.remainingWeight)}`} data-testid={`filament-spool-${spool.id}`} onClick={() => setSelectedId(spool.id)}>
          <span className={styles.cardTop}><span className={ownerId ? styles.onPrinter : styles.onShelf}>{ownerId ? <><Printer aria-hidden="true"/>{printers.find(printer => printer.id === ownerId)?.name ?? 'На принтере'}</> : spool.material}</span><span className={styles.percentage}>{Math.round(fraction(spool) * 100)}%</span></span>
          <div className={styles.spoolStage}><FilamentSpoolThumbnail spool={spool} diameter={diameter(spool)} label={`Катушка ${spool.name}`}/></div>
          <span className={styles.cardName}><i title={spool.color || 'Цвет не указан'}/><b>{spool.name}</b>{selected?.id === spool.id && <Check aria-hidden="true"/>}</span>
          <span className={styles.cardBottom}><strong>{weight(spool.remainingWeight)}</strong><span>из {weight(spool.initialWeight)}</span></span><span className={styles.fillTrack}><span style={{ width: `${fraction(spool) * 100}%` }}/></span>
        </button>;
      })}{!query && !material && location === 'active' && <button type="button" className={styles.addCard} onClick={onAdd} disabled={!canOperate || busy} aria-label="Новая катушка"><PackagePlus aria-hidden="true"/><b>Новая катушка</b><span>Цвет, вес и материал</span></button>}</div>
      {!visible.length && inventory.spools.length > 0 && <div className={styles.noResults}><Search aria-hidden="true"/><b>Катушки не найдены</b><p>Попробуйте другой цвет, материал или расположение.</p><button type="button" onClick={reset}>Сбросить фильтры</button></div>}
      {!inventory.spools.length && <p className={styles.emptyHint}>Добавьте катушки из уже учтённого запаса или оформите новую покупку.</p>}
      <div className={styles.shelfFooter}><span>Показано {visible.length} из {inventory.spools.length}</span><span>{weight(visible.reduce((sum, spool) => sum + spool.remainingWeight, 0))} на катушках</span></div>
    </div>
  </section>;
}
