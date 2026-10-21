import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftRight, Check, Layers3, Package, RefreshCw, X } from 'lucide-react';
import type { PrinterModel } from '../types';
import { materialSummary, normalizeFilamentMaterial, type FilamentInventory } from '../lib/filamentInventory';
import { readFilamentInventory, subscribeFilamentInventory, updateFilamentInventory } from '../lib/filamentInventoryStore';
import { showAppNotification } from '../lib/appNotifications';
import { printerDisplayName } from '../lib/printerName';
import { FilamentSpoolThumbnail } from './FilamentSpoolThumbnail';
import styles from './FilamentReplaceDialog.module.css';

const weight = (grams: number) => `${Math.round(grams).toLocaleString('ru-RU')} г`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function FilamentReplaceDialog({ printer, printers, canOperate, onClose, onWarehouse, onReplaced }: {
  printer: PrinterModel; printers: PrinterModel[]; canOperate: boolean; onClose: () => void; onWarehouse?: () => void; onReplaced?: (spoolId?: string) => void;
}) {
  const expectedBinding = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), saving = useRef(false), initialized = useRef(false);
  const [inventory, setInventory] = useState<FilamentInventory>();
  const [selection, setSelection] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const id = useId(), name = printerDisplayName(printer, printers.findIndex(item => item.id === printer.id));
  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (returnFocus?.isConnected) returnFocus.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeFilamentInventory(state => { if (active) setInventory(state); });
    void readFilamentInventory().then(state => { if (active) setInventory(state); })
      .catch(reason => { if (active) setError(message(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!inventory || initialized.current) return;
    initialized.current = true;
    const binding = inventory.printers[printer.id]?.binding;
    expectedBinding.current = binding?.id ?? null;
    setSelection(binding ? binding.spoolId ? `spool:${binding.spoolId}` : `stock:${binding.material}` : '');
  }, [inventory, printer.id]);
  const reload = async () => {
    setLoading(true); setError('');
    try { setInventory(await readFilamentInventory()); } catch (reason) { setError(message(reason)); }
    finally { setLoading(false); }
  };
  const binding = inventory?.printers[printer.id]?.binding;
  const current = binding ? binding.spoolId ? `spool:${binding.spoolId}` : `stock:${binding.material}` : '';
  const stock = inventory ? materialSummary(inventory).filter(row => row.looseGrams > 0 || current === `stock:${row.material}`) : [];
  const owner = (spoolId: string) => Object.entries(inventory?.printers ?? {}).find(([, row]) => row.binding?.spoolId === spoolId)?.[0]
    ?? inventory?.spools.find(spool => spool.id === spoolId)?.printerId;
  const selectedSpool = inventory?.spools.find(spool => selection === `spool:${spool.id}`);
  const selectedStock = stock.find(row => selection === `stock:${row.material}`);
  const available = selectedSpool ? selectedSpool.remainingWeight > 0 && (!owner(selectedSpool.id) || owner(selectedSpool.id) === printer.id) : !!selectedStock && selectedStock.looseGrams > 0;
  const submit = async () => {
    if (!canOperate || saving.current || !available || selection === current) return;
    if (!printers.some(item => item.id === printer.id)) { setError('Принтер больше недоступен.'); return; }
    saving.current = true; setBusy(true); setError('');
    try {
      await updateFilamentInventory({ type: 'bind-printer', printerId: printer.id, expectedBindingId: expectedBinding.current,
        material: selectedSpool?.material ?? selectedStock!.material, ...(selectedSpool ? { spoolId: selectedSpool.id } : {}) });
      showAppNotification('Пластик заменён', `${name} · ${selectedSpool?.name ?? selectedStock!.material}`, 'success');
      onReplaced?.(selectedSpool?.id);
      onClose();
    } catch (reason) { setError(message(reason)); }
    finally { saving.current = false; setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`}
    onCancel={event => { event.preventDefault(); if (!saving.current) onClose(); }}>
    <header className={styles.header}><span className={styles.headingIcon}><ArrowLeftRight aria-hidden="true"/></span><div><h2 id={`${id}-title`}>Заменить пластик</h2><p>{name}</p></div><button type="button" aria-label="Закрыть выбор пластика" onClick={onClose} disabled={busy}><X aria-hidden="true"/></button></header>
    <div className={styles.body}>
      <p className={styles.hint} id={`${id}-hint`}>Выберите катушку, которую установили на принтер. Учёт нового пластика начнётся с момента замены.</p>
      {loading && <p role="status">Загрузка катушек…</p>}
      {inventory && <fieldset className={styles.choices} disabled={!canOperate || busy}>
        <legend>Катушки на складе</legend>
        <div className={styles.spools}>{inventory.spools.map(spool => {
          const value = `spool:${spool.id}`, ownerId = owner(spool.id), occupied = !!ownerId && ownerId !== printer.id;
          const disabled = occupied || spool.remainingWeight <= 0, installed = value === current;
          return <label className={styles.choice} key={value} data-disabled={disabled} data-selected={selection === value}>
            <input type="radio" name={`${id}-spool`} value={value} checked={selection === value} disabled={disabled} onChange={() => { setSelection(value); setError(''); }}/>
            <FilamentSpoolThumbnail spool={spool} diameter={inventory.materials[normalizeFilamentMaterial(spool.material)]?.diameter} label={`${spool.material}, ${spool.color || 'цвет не указан'}`}/>
            <strong>{spool.name}</strong><span>{spool.material} · {weight(spool.remainingWeight)}</span>
            <small>{occupied ? `На ${printers.find(item => item.id === ownerId)?.name || 'другом принтере'}` : installed ? 'Установлена сейчас' : spool.remainingWeight <= 0 ? 'Пустая катушка' : 'Свободна'}</small>
            {selection === value && <Check className={styles.selectedIcon} aria-hidden="true"/>}
          </label>;
        })}</div>
        {!inventory.spools.length && <div className={styles.empty}><Package aria-hidden="true"/><span>На складе пока нет катушек.</span></div>}
        {stock.length > 0 && <><h3>Общий запас без катушек</h3><div className={styles.stock}>{stock.map(row => {
          const value = `stock:${row.material}`;
          return <label className={styles.looseChoice} key={value} data-selected={selection === value}>
            <input type="radio" name={`${id}-spool`} value={value} checked={selection === value} disabled={row.looseGrams <= 0} onChange={() => { setSelection(value); setError(''); }}/>
            <Layers3 aria-hidden="true"/><span><strong>{row.material}</strong><small>{weight(row.looseGrams)} без катушки</small></span>
          </label>;
        })}</div></>}
      </fieldset>}
      {error && <div className={styles.error} role="alert">{error}{!inventory && <button type="button" disabled={loading} onClick={() => void reload()}><RefreshCw aria-hidden="true"/>Повторить</button>}</div>}
      {selection && !available && !loading && inventory && <p className={styles.hint}>Выбранная катушка недоступна. Выберите другую.</p>}
    </div>
    <footer className={styles.footer}>{onWarehouse && <button type="button" className={styles.warehouse} disabled={busy} onClick={onWarehouse}><Package aria-hidden="true"/>Открыть склад</button>}<button type="button" onClick={onClose} disabled={busy}>Отмена</button><button type="button" className={styles.save} disabled={!canOperate || busy || !available || selection === current} onClick={() => void submit()}><Check aria-hidden="true"/>{busy ? 'Сохранение…' : 'Установить катушку'}</button></footer>
  </dialog>, document.body);
}
