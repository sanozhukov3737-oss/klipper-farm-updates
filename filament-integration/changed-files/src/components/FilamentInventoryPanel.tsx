import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Bell, Check, Layers3, PackagePlus, Pencil, Plus, Printer, RefreshCw, Settings2, X } from 'lucide-react';
import type { FilamentFinish, PrinterModel } from '../types';
import { materialSummary, normalizeFilamentMaterial, type FilamentCommand, type FilamentInventory } from '../lib/filamentInventory';
import { readFilamentInventory, subscribeFilamentInventory, updateFilamentInventory } from '../lib/filamentInventoryStore';
import { requestFilamentAccountingRefresh } from '../lib/filamentHistory';
import { appConfirm } from '../lib/appDialogs';
import { FilamentWarehouse } from './FilamentWarehouse';
import { FilamentReplaceDialog } from './FilamentReplaceDialog';
import { FILAMENT_FINISH_LABELS, spoolOwner } from '../lib/filamentSpool';
import { FilamentSpoolThumbnail } from './FilamentSpoolThumbnail';
import { FilamentUsageOverview } from './FilamentUsageOverview';
import styles from './FilamentInventoryPanel.module.css';

const DEFAULT_MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU'];
const kg = (grams: number) => `${(grams / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 3 })} кг`;
const kgInput = (grams: number) => String(Math.round(grams * 1000) / 1_000_000).replace('.', ',');
const spoolCount = (count: number) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'катушка' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'катушки' : 'катушек'}`;
const nativeColor = (color: string) => /^#[\da-f]{6}$/i.test(color) ? color : /^#[\da-f]{3}$/i.test(color) ? `#${[...color.slice(1)].map(value => value + value).join('')}` : '#9299a4';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function decimal(value: string, name: string, allowZero = false) {
  const normalized = value.trim().replace(',', '.');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) throw new Error(`${name}: введите число, например 1,5.`);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw new Error(`${name}: значение должно быть ${allowZero ? 'не меньше нуля' : 'больше нуля'}.`);
  return parsed;
}
const gramsInput = (value: string, name: string, allowZero = false) => {
  const kilograms = decimal(value, name, allowZero);
  if (kilograms > 0 && kilograms < 0.001) throw new Error(`${name}: минимальное количество — 0,001 кг.`);
  const grams = Math.round(kilograms * 1000);
  if (grams > 1_000_000_000) throw new Error(`${name}: слишком большое количество.`);
  return grams;
};

type FormKind = 'stock' | 'spools' | 'reserve' | 'binding' | 'writeoff' | 'edit' | 'settings' | 'pending';
type InventoryForm = { kind: FormKind; material: string; customMaterial: string; quantity: string; reserve: string; count: string; name: string; color: string; finish: FilamentFinish; source: 'existing-stock' | 'purchase'; printerId: string; spoolId: string; note: string; density: string; diameter: string; price: string; currency: string; pendingId?: string };
const formDefaults = (kind: FormKind, material = 'PLA'): InventoryForm => ({ kind, material: DEFAULT_MATERIALS.includes(material) ? material : 'custom', customMaterial: DEFAULT_MATERIALS.includes(material) ? '' : material, quantity: kind === 'stock' ? '' : '1', reserve: '', count: '1', name: '', color: '', finish: 'normal', source: 'existing-stock', printerId: '', spoolId: '', note: '', density: '1,24', diameter: '1,75', price: '', currency: '₽' });
const formTitle: Record<FormKind, string> = { stock: 'Добавить пластик', spools: 'Добавить катушки', reserve: 'Резерв материала', binding: 'Пластик для принтера', writeoff: 'Записать расход вручную', edit: 'Остаток на катушке', settings: 'Параметры материала', pending: 'Подтвердить расход' };
const trackingLabels = { unbound: 'Выберите пластик', 'baseline-pending': 'Подготовка учёта', tracking: 'Учёт включён', pending: 'Нужно подтверждение', 'no-history': 'История недоступна', error: 'Ошибка учёта' };

export function FilamentInventoryPanel({ printers, canOperate }: { printers: PrinterModel[]; canOperate: boolean }) {
  const [inventory, setInventory] = useState<FilamentInventory>();
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<InventoryForm>();
  const [replacePrinterId, setReplacePrinterId] = useState('');
  const [revealSpoolId, setRevealSpoolId] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const fieldId = (name: string) => `${formId}-${name}`;
  const load = async () => {
    setLoading(true); setLoadError('');
    try { setInventory(await readFilamentInventory()); }
    catch (e) { setLoadError(errorText(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeFilamentInventory(state => { if (active) setInventory(state); });
    void readFilamentInventory().then(state => { if (active) setInventory(state); }).catch(e => { if (active) setLoadError(errorText(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    const onAccountingError = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail === 'string' && detail) setError(detail);
    };
    window.addEventListener('klipper-filament-accounting-error', onAccountingError);
    return () => window.removeEventListener('klipper-filament-accounting-error', onAccountingError);
  }, []);
  useEffect(() => {
    if (!form) return;
    formRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    formRef.current?.querySelector<HTMLElement>('input,select')?.focus();
  }, [form?.kind]);
  const rows = useMemo(() => inventory ? materialSummary(inventory) : [], [inventory]);
  const materialNames = useMemo(() => [...new Set([...DEFAULT_MATERIALS, ...rows.map(row => row.material)])], [rows]);
  const inputMaterial = form ? (form.material === 'custom' ? form.customMaterial.trim() : form.material) : 'PLA';
  const activeMaterial = inputMaterial ? normalizeFilamentMaterial(inputMaterial) : '';
  const selectedMaterial = rows.find(row => row.material === activeMaterial);
  const activeSpools = inventory?.spools.filter(spool => normalizeFilamentMaterial(spool.material) === activeMaterial) ?? [];
  const pending = inventory?.pending.filter(job => !job.resolved) ?? [];
  const replacePrinter = printers.find(printer => printer.id === replacePrinterId);
  const shelfRows = rows.filter(row => row.totalGrams > 0 || row.usedGrams > 0 || row.reserveGrams > 0 || inventory?.spools.some(spool => normalizeFilamentMaterial(spool.material) === row.material));
  const change = <K extends keyof InventoryForm>(key: K, value: InventoryForm[K]) => setForm(current => current ? { ...current, [key]: value } : current);
  const open = (next: InventoryForm) => { setError(''); setSuccess(''); setForm(next); };
  const closeForm = () => { if (!busy) { setForm(undefined); setError(''); } };
  const dispatch = async (command: FilamentCommand, message: string) => {
    if (!canOperate || busy) return false;
    setBusy(true); setError(''); setSuccess('');
    try { setInventory(await updateFilamentInventory(command)); setSuccess(message); return true; }
    catch (e) { setError(errorText(e)); return false; }
    finally { setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !inventory || !canOperate || busy) return;
    try {
      const material = activeMaterial;
      if (!material || material.length > 60) throw new Error('Укажите материал: от 1 до 60 символов.');
      let command: FilamentCommand;
      if (form.kind === 'stock') {
        command = { type: 'add-stock', material, grams: gramsInput(form.quantity, 'Количество'), ...(form.reserve.trim() ? { reserveGrams: gramsInput(form.reserve, 'Резерв', true) } : {}) };
      } else if (form.kind === 'reserve') {
        command = { type: 'set-reserve', material, reserveGrams: gramsInput(form.reserve, 'Резерв', true) };
      } else if (form.kind === 'settings') {
        command = { type: 'configure-material', material, density: decimal(form.density, 'Плотность'), diameter: decimal(form.diameter, 'Диаметр') };
      } else if (form.kind === 'spools') {
        const count = decimal(form.count, 'Число катушек');
        if (!Number.isInteger(count) || count > 1000) throw new Error('Число катушек: целое значение от 1 до 1000.');
        if (form.printerId && count !== 1) throw new Error('Принтеру можно назначить одну физическую катушку.');
        command = { type: 'add-spools', material, count, finish: form.finish, weightGrams: gramsInput(form.quantity, 'Вес одной катушки'), source: form.source, ...(form.color ? { color: form.color } : {}), ...(form.name.trim() ? { name: form.name.trim() } : {}), ...(form.printerId ? { printerId: form.printerId } : {}), ...(form.price.trim() ? { price: decimal(form.price, 'Цена', true), currency: form.currency.trim() || '₽' } : {}) };
      } else if (form.kind === 'binding') {
        if (!printers.some(printer => printer.id === form.printerId)) throw new Error('Выберите существующий принтер.');
        command = { type: 'bind-printer', printerId: form.printerId, material, ...(form.spoolId ? { spoolId: form.spoolId } : {}) };
      } else if (form.kind === 'edit') {
        command = { type: 'edit-spool', spoolId: form.spoolId, finish: form.finish, remainingGrams: gramsInput(form.quantity, 'Остаток', true), ...(/^#[\da-f]{6}$/i.test(form.color) ? { color: form.color } : {}) };
      } else if (form.kind === 'pending') {
        if (!form.pendingId) throw new Error('Печать не выбрана.');
        command = { type: 'resolve-pending', pendingId: form.pendingId, material, grams: gramsInput(form.quantity, 'Расход'), ...(form.spoolId ? { spoolId: form.spoolId } : {}), ...(form.note.trim() ? { note: form.note.trim() } : {}) };
      } else {
        if (!printers.some(printer => printer.id === form.printerId)) throw new Error('Выберите существующий принтер.');
        command = { type: 'manual-writeoff', printerId: form.printerId, printerName: printers.find(printer => printer.id === form.printerId)?.name, material, grams: gramsInput(form.quantity, 'Расход'), ...(form.spoolId ? { spoolId: form.spoolId } : {}), ...(form.note.trim() ? { note: form.note.trim() } : {}) };
      }
      if (await dispatch(command, form.kind === 'binding' ? 'Пластик назначен. Учёт начинается с этого момента.' : 'Изменения сохранены.')) setForm(undefined);
    } catch (e) { setError(errorText(e)); }
  };
  const bindForm = (printerId: string) => {
    const binding = inventory?.printers[printerId]?.binding;
    open({ ...formDefaults('binding', binding?.material), printerId, spoolId: binding?.spoolId ?? '' });
  };
  const writeoffForm = (printerId: string) => {
    const binding = inventory?.printers[printerId]?.binding;
    open({ ...formDefaults('writeoff', binding?.material), quantity: '', printerId, spoolId: binding?.spoolId ?? '' });
  };
  const draftGrams = form ? Number(form.quantity.replace(',', '.')) * 1000 : 0;
  const previewWeight = Number.isFinite(draftGrams) ? Math.max(0, draftGrams) : 0;
  const previewCapacity = form?.kind === 'edit' ? inventory?.spools.find(spool => spool.id === form.spoolId)?.initialWeight ?? 1000 : previewWeight || 1000;

  return <section className={styles.panel} aria-label="Запас и расход пластика">
    <div className={styles.heading}><div><h3>Склад пластика</h3><p>Цвет, остаток и расход — на одном экране.</p></div></div>
    {loadError && <div className={styles.error} role="alert">Не удалось загрузить учёт: {loadError}<button type="button" onClick={() => void load()} disabled={loading}><RefreshCw/>Повторить</button></div>}
    {loading && !inventory && <p className={styles.hint} role="status">Загрузка запасов…</p>}
    {!canOperate && <p className={styles.hint}>Доступен просмотр. Менять запасы может оператор или администратор.</p>}
    {inventory && <>
      <div className={styles.toolbar}><button type="button" className={styles.primary} disabled={!canOperate || busy} onClick={() => open(formDefaults('stock'))}><Plus/>Добавить пластик</button><button type="button" disabled={!canOperate || busy} onClick={() => open({ ...formDefaults('spools'), source: (inventory.materials.PLA?.looseGrams ?? 0) >= 1000 ? 'existing-stock' : 'purchase' })}><PackagePlus/>Добавить катушки</button><button type="button" disabled={!canOperate || busy} onClick={() => { requestFilamentAccountingRefresh(); setSuccess('Обновление расхода запрошено. Недоступные принтеры сохранят последние итоги.'); }}><RefreshCw/>Обновить расход</button></div>
      {rows.every(row => row.totalGrams === 0) && <div className={styles.empty}><Layers3/><div><b>Начните с общего запаса</b><p>Например: добавьте 15 кг PLA и задайте резерв 5 кг. Приложение предупредит, когда останется 5 кг или меньше. Затем выберите пластик для каждого принтера. Катушки можно добавить по желанию.</p></div></div>}

      {form && <form ref={formRef} className={styles.form} onSubmit={event => void submit(event)} aria-labelledby={fieldId('title')}>
        <div className={styles.formHead}><h4 id={fieldId('title')}>{formTitle[form.kind]}</h4><button type="button" aria-label="Закрыть форму" disabled={busy} onClick={closeForm}><X/></button></div>
        <fieldset disabled={!canOperate || busy}>
          {(form.kind === 'spools' || form.kind === 'edit') && <div className={styles.formPreview}>
            <FilamentSpoolThumbnail spool={{ id: `draft-${formId}`, name: form.name, material: activeMaterial || 'Пластик', color: form.color, finish: form.finish, initialWeight: previewCapacity, remainingWeight: previewWeight, price: 0, currency: form.currency, createdAt: 0 }} diameter={selectedMaterial?.diameter} label="Предпросмотр цвета катушки"/>
            <div><b>{form.name || activeMaterial || 'Катушка'}</b><span>{form.color ? `Цвет намотки · ${form.color.toUpperCase()}` : 'Выберите цвет вашего пластика'}</span><div className={styles.colorPalette} role="group" aria-label="Быстрый выбор цвета">{['#f3f3ef', '#242833', '#e95d5d', '#ef9e32', '#f1d252', '#51b486', '#4b98d9', '#8b75d6', '#df80b5'].map(color => <button type="button" key={color} aria-label={`Цвет ${color}`} aria-pressed={form.color.toLowerCase() === color} onClick={() => change('color', color)}><i style={{ background: color }}/></button>)}</div></div>
          </div>}
          <div className={styles.fields}>
            {form.kind !== 'edit' && <label htmlFor={fieldId('material')}>Материал<select id={fieldId('material')} value={form.material} onChange={event => { change('material', event.target.value); change('spoolId', ''); }}><option value="PLA">PLA</option><option value="PETG">PETG</option><option value="ABS">ABS</option><option value="ASA">ASA</option><option value="TPU">TPU</option>{materialNames.filter(material => !DEFAULT_MATERIALS.includes(material)).map(material => <option value={material} key={material}>{material}</option>)}<option value="custom">Другой материал…</option></select></label>}
            {form.material === 'custom' && form.kind !== 'edit' && <label htmlFor={fieldId('custom')}>Название материала<input id={fieldId('custom')} maxLength={60} placeholder="Например, PA-CF" value={form.customMaterial} onChange={event => { change('customMaterial', event.target.value); change('spoolId', ''); }} required/></label>}
            {['stock', 'spools', 'writeoff', 'edit', 'pending'].includes(form.kind) && <label htmlFor={fieldId('quantity')}>{form.kind === 'spools' ? 'Вес пластика в одной катушке, кг' : form.kind === 'edit' ? 'Остаток пластика, кг' : form.kind === 'stock' ? 'Добавить на склад, кг' : 'Расход, кг'}<input id={fieldId('quantity')} type="text" inputMode="decimal" placeholder={form.kind === 'stock' ? 'Например, 15' : 'Например, 0,25'} value={form.quantity} onChange={event => change('quantity', event.target.value)} required/></label>}
            {(form.kind === 'spools' || form.kind === 'edit') && <label htmlFor={fieldId('color')}>Цвет пластика<span className={styles.colorField}><input id={fieldId('color')} type="color" value={nativeColor(form.color)} onChange={event => change('color', event.target.value)}/><span>{form.color ? form.color.toUpperCase() : 'Не указан'}</span></span></label>}
            {(form.kind === 'spools' || form.kind === 'edit') && <label htmlFor={fieldId('finish')}>Поверхность<select id={fieldId('finish')} value={form.finish} onChange={event => change('finish', event.target.value as FilamentFinish)}>{Object.entries(FILAMENT_FINISH_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
            {(form.kind === 'stock' || form.kind === 'reserve') && <label htmlFor={fieldId('reserve')}>Резерв, кг{form.kind === 'stock' && <span className={styles.optional}>необязательно</span>}<input id={fieldId('reserve')} inputMode="decimal" placeholder={form.kind === 'stock' ? 'Например, 5' : '0 — без предупреждения'} value={form.reserve} onChange={event => change('reserve', event.target.value)} required={form.kind === 'reserve'}/></label>}
            {form.kind === 'spools' && <>
              <label htmlFor={fieldId('count')}>Число катушек<input id={fieldId('count')} inputMode="numeric" value={form.count} onChange={event => { change('count', event.target.value); if (event.target.value !== '1') change('printerId', ''); }} required/></label>
              <label htmlFor={fieldId('name')}>Название<span className={styles.optional}>необязательно</span><input id={fieldId('name')} value={form.name} maxLength={120} placeholder="Например, PLA чёрный" onChange={event => change('name', event.target.value)}/></label>
              <label htmlFor={fieldId('source')}>Откуда пластик<select id={fieldId('source')} value={form.source} onChange={event => change('source', event.target.value as InventoryForm['source'])}><option value="existing-stock">Из уже учтённого запаса</option><option value="purchase">Новая покупка — увеличить запас</option></select></label>
              <label htmlFor={fieldId('spool-printer')}>Назначить принтеру<span className={styles.optional}>для одной катушки</span><select id={fieldId('spool-printer')} value={form.printerId} disabled={form.count !== '1'} onChange={event => change('printerId', event.target.value)}><option value="">Пока не назначать</option>{printers.map(printer => <option key={printer.id} value={printer.id}>{printer.name}</option>)}</select></label>
              <label htmlFor={fieldId('price')}>Цена одной катушки<span className={styles.optional}>необязательно</span><input id={fieldId('price')} inputMode="decimal" value={form.price} onChange={event => change('price', event.target.value)} placeholder="Для себестоимости"/></label>
              {form.price && <label htmlFor={fieldId('currency')}>Валюта<input id={fieldId('currency')} maxLength={8} value={form.currency} onChange={event => change('currency', event.target.value)}/></label>}
            </>}
            {(form.kind === 'binding' || form.kind === 'writeoff') && <label htmlFor={fieldId('printer')}>Принтер<select id={fieldId('printer')} value={form.printerId} onChange={event => { change('printerId', event.target.value); const spool = activeSpools.find(item => item.id === form.spoolId); if (spool?.printerId && spool.printerId !== event.target.value) change('spoolId', ''); }} required><option value="">Выберите принтер</option>{printers.map(printer => <option key={printer.id} value={printer.id}>{printer.name}</option>)}</select></label>}
            {['binding', 'writeoff', 'pending'].includes(form.kind) && <label htmlFor={fieldId('spool')}>Откуда списывать<select id={fieldId('spool')} value={form.spoolId} onChange={event => change('spoolId', event.target.value)}><option value="">Общий запас {activeMaterial || 'материала'} без катушки</option>{activeSpools.filter(spool => !spool.printerId || spool.printerId === form.printerId).map(spool => <option key={spool.id} value={spool.id}>{spool.name} · {kg(spool.remainingWeight)}</option>)}</select></label>}
            {(form.kind === 'writeoff' || form.kind === 'pending') && <label className={styles.wide} htmlFor={fieldId('note')}>Комментарий<span className={styles.optional}>необязательно</span><input id={fieldId('note')} value={form.note} maxLength={300} onChange={event => change('note', event.target.value)} placeholder="Например, взвешено после печати"/></label>}
            {form.kind === 'settings' && <><label htmlFor={fieldId('density')}>Плотность, г/см³<input id={fieldId('density')} inputMode="decimal" value={form.density} onChange={event => change('density', event.target.value)} required/></label><label htmlFor={fieldId('diameter')}>Диаметр нити, мм<input id={fieldId('diameter')} inputMode="decimal" value={form.diameter} onChange={event => change('diameter', event.target.value)} required/></label></>}
          </div>
          {form.kind === 'spools' && <p className={styles.formHint}>{form.source === 'existing-stock' ? `Катушки выделяются из общего запаса без повторного прибавления. Сейчас без катушек: ${kg(selectedMaterial?.looseGrams ?? 0)} ${activeMaterial}.` : 'Покупка увеличит общий запас на вес всех добавленных катушек.'}</p>}
          {form.kind === 'binding' && <p className={styles.formHint}>Учёт начинается с момента назначения. Старые печати не спишутся с нового материала. Одну катушку можно назначить только одному принтеру.</p>}
          {form.kind === 'writeoff' && <p className={styles.formHint}>Расход уменьшит запас и попадёт в счётчик выбранного принтера. Указывайте только то, что ещё не было учтено автоматически.</p>}
          {form.kind === 'pending' && <p className={styles.formHint}>Автоматическое списание для этой печати не выполнено. Введите подтверждённое количество пластика.</p>}
          {form.kind === 'settings' && <p className={styles.formHint}>Вес рассчитывается по длине подачи, которую сообщает принтер, диаметру нити и плотности. Это расчёт, а не взвешивание. Уже учтённый расход не меняется.</p>}
          {form.kind === 'edit' && <p className={styles.formHint}>Корректировка изменит запас на складе. Чтобы записать расход конкретного принтера, используйте «Расход вручную».</p>}
          {form.kind === 'reserve' && <p className={styles.formHint}>Предупреждение придёт, когда общий остаток материала станет равен резерву или меньше. Значение 0 отключает предупреждение о резерве.</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.formActions}><button className={styles.primary} type="submit"><Check/>{busy ? 'Сохранение…' : form.kind === 'writeoff' || form.kind === 'pending' ? 'Записать расход' : 'Сохранить'}</button><button type="button" onClick={closeForm}>Отмена</button></div>
        </fieldset>
      </form>}
      {error && !form && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.liveStatus} role="status" aria-live="polite">{success}</div>

      <FilamentWarehouse inventory={inventory} printers={printers} canOperate={canOperate} busy={busy} revealSpoolId={revealSpoolId}
        onAdd={() => open({ ...formDefaults('spools'), source: (inventory.materials.PLA?.looseGrams ?? 0) >= 1000 ? 'existing-stock' : 'purchase' })}
        onEdit={spool => open({ ...formDefaults('edit', spool.material), spoolId: spool.id, quantity: kgInput(spool.remainingWeight), color: spool.color ?? '', finish: spool.finish ?? 'normal' })}
        onAppearance={(spool, patch) => dispatch({ type: 'spool-appearance', spoolId: spool.id, ...patch }, 'Вид пластика сохранён.')}
        onAssign={spool => { const owner = spoolOwner(inventory, spool); if (owner) { if (printers.some(printer => printer.id === owner)) setReplacePrinterId(owner); else setError('Этот принтер больше недоступен. Снимите его привязку в учёте.'); } else open({ ...formDefaults('binding', spool.material), spoolId: spool.id, printerId: '' }); }}
        onRemove={async spool => { if (await appConfirm(`Удалить катушку «${spool.name}»? Остаток ${kg(spool.remainingWeight)} будет исключён из запаса. Это не записывает расход принтера.`, { title: 'Удалить катушку', confirmLabel: 'Удалить', danger: true })) await dispatch({ type: 'remove-spool', spoolId: spool.id }, 'Катушка удалена.'); }}/>

      {replacePrinter && <FilamentReplaceDialog printer={replacePrinter} printers={printers} canOperate={canOperate} onClose={() => setReplacePrinterId('')} onReplaced={spoolId => setRevealSpoolId(spoolId ?? '')}/>}

      {shelfRows.length > 0 && <div className={styles.shelfHeading}><h4>Запас и резерв</h4><span><Bell/>Предупредим, когда запас достигнет резерва</span></div>}
      <div className={styles.materials} aria-label="Материалы на складе">{shelfRows.map(row => {
        const low = row.reserveGrams > 0 && row.totalGrams <= row.reserveGrams;
        const aboveReserve = Math.max(0, row.totalGrams - row.reserveGrams);
        const spools = inventory.spools.filter(spool => normalizeFilamentMaterial(spool.material) === row.material && spool.remainingWeight > 0);
        return <article key={row.material} data-testid={`filament-material-${row.material}`} className={`${styles.materialCard} ${low ? styles.lowStock : ''}`}>
          <div className={styles.materialHead}><b>{row.material}</b><strong>{kg(row.totalGrams)}</strong><button type="button" aria-label={`Параметры ${row.material}`} title="Диаметр нити и плотность" disabled={!canOperate || busy} onClick={() => open({ ...formDefaults('settings', row.material), density: String(row.density).replace('.', ','), diameter: String(row.diameter).replace('.', ',') })}><Settings2/></button></div>
          <div className={styles.stockSegments} aria-label={`Катушки и общий запас ${row.material}`}>{spools.map(spool => <span key={spool.id} style={{ flex: spool.remainingWeight, background: spool.color && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(spool.color) ? spool.color : '#9299a4' }} title={`${spool.name}: ${kg(spool.remainingWeight)} · ${spool.color || 'цвет не указан'}`}/>)}{row.looseGrams > 0 && <span className={styles.looseSegment} style={{ flex: row.looseGrams }} title={`Без катушек: ${kg(row.looseGrams)}`}/>}</div>
          <div className={styles.stockCounts}><span>{spoolCount(spools.length)}</span><span>{kg(row.looseGrams)} без катушек</span></div>
          <div className={styles.stockReserve}><span>Резерв <b>{kg(row.reserveGrams)}</b></span><button type="button" aria-label={`Изменить резерв ${row.material}`} disabled={!canOperate || busy} onClick={() => open({ ...formDefaults('reserve', row.material), reserve: kgInput(row.reserveGrams) })}><Pencil/></button></div>
          {low ? <span className={styles.warning}><AlertTriangle/>Достигнут резерв</span> : <span className={styles.stockAvailable}>Сверх резерва <b>{kg(aboveReserve)}</b></span>}
          <button className={styles.shelfAction} type="button" disabled={!canOperate || busy} aria-label={`Добавить катушки ${row.material}`} onClick={() => open({ ...formDefaults('spools', row.material), source: row.looseGrams >= 1000 ? 'existing-stock' : 'purchase' })}><Plus/>Катушки {row.material}</button>
        </article>;
      })}</div>

      <FilamentUsageOverview inventory={inventory} printers={printers}/>

      <section className={styles.printers} aria-labelledby={fieldId('printers-title')}><div className={styles.sectionHeading}><div><h4 id={fieldId('printers-title')}>Расход по принтерам</h4><p>Назначьте катушку — расход будет учитываться после печати.</p></div></div>
        {!printers.length && <p className={styles.hint}>Добавьте принтер в ферму, чтобы назначить ему материал и учитывать расход.</p>}
        {printers.map(printer => {
          const accounting = inventory.printers[printer.id];
          const binding = accounting?.binding;
          const spool = binding?.spoolId ? inventory.spools.find(item => item.id === binding.spoolId) : undefined;
          return <article className={styles.printerRow} data-testid={`filament-printer-${printer.id}`} key={printer.id}>
            <div className={styles.printerIdentity}><Printer/><div><b>{printer.name}</b><span>{binding ? `${binding.material} · ${spool?.name ?? 'общий запас'}` : 'Пластик не назначен'}</span><small className={accounting?.status === 'pending' || accounting?.status === 'error' ? styles.warning : ''}>{trackingLabels[accounting?.status ?? 'unbound']}{accounting?.pendingJobs ? ` · ${accounting.pendingJobs} печ.` : ''}</small>{accounting?.error && <small className={styles.warning}>{accounting.error}</small>}</div></div>
            <div className={styles.printerUsage}><strong>{kg(accounting?.usedGrams ?? 0)}</strong><span>Расчёт: {kg(accounting?.calculatedGrams ?? 0)}</span><span>Вручную: {kg(accounting?.manualGrams ?? 0)}</span>{Object.entries(accounting?.byMaterial ?? {}).filter(([, amount]) => amount > 0).map(([material, amount]) => <span key={material}>{material}: {kg(amount)}</span>)}</div>
            <div className={styles.rowActions}><button type="button" disabled={!canOperate || busy} onClick={() => bindForm(printer.id)}>{binding ? 'Сменить пластик' : 'Выбрать пластик'}</button><button type="button" disabled={!canOperate || busy} onClick={() => writeoffForm(printer.id)}>Расход вручную</button>{binding && <button type="button" className={styles.subtle} disabled={!canOperate || busy} onClick={async () => { if (await appConfirm(`Остановить учёт пластика для ${printer.name}? Накопленный расход сохранится.`, { title: 'Остановить учёт', confirmLabel: 'Остановить' })) await dispatch({ type: 'unbind-printer', printerId: printer.id }, 'Привязка пластика снята. Накопленный расход сохранён.'); }}>Снять привязку</button>}</div>
          </article>;
        })}
      </section>

      {pending.length > 0 && <details className={styles.details} open><summary><AlertTriangle/>Нужно подтвердить расход <span>{pending.length}</span></summary><div className={styles.pendingList}>{pending.map(job => <article key={job.id}><div><b>{job.printerName || printers.find(printer => printer.id === job.printerId)?.name || 'Принтер'} · {job.filename || 'Печать'}</b><p>{job.reason}</p>{job.usedMm !== undefined && <small>Принтер сообщил {(job.usedMm / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м нити; вес не списан.</small>}</div><div className={styles.rowActions}><button type="button" disabled={!canOperate || busy} onClick={() => open({ ...formDefaults('pending', job.material ?? inventory.printers[job.printerId]?.binding?.material), quantity: '', pendingId: job.id, printerId: job.printerId })}>Указать расход</button><button className={styles.subtle} type="button" disabled={!canOperate || busy} onClick={async () => { if (await appConfirm('Пропустить эту печать без списания пластика? Она будет отмечена как обработанная.', { title: 'Пропустить расход', confirmLabel: 'Пропустить' })) await dispatch({ type: 'dismiss-pending', pendingId: job.id }, 'Печать отмечена как обработанная без списания.'); }}>Не списывать</button></div></article>)}</div></details>}


    </>}
  </section>;
}
