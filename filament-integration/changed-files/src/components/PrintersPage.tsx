import { useEffect, useState } from 'react';
import type { PrinterModel } from '../types';
import type { FilamentInventory } from '../lib/filamentInventory';
import { readFilamentInventory, subscribeFilamentInventory } from '../lib/filamentInventoryStore';
import { printerHasActiveJob } from '../lib/printerJob';
import { FilamentReplaceDialog } from './FilamentReplaceDialog';
import { PrinterCard } from './PrinterCard';
import styles from './FleetLive.module.css';

const needsAttention = (p: PrinterModel) => !p.status.remoteControlSuspended && (p.status.connectionState === 'offline' || p.status.connectionState === 'degraded' || p.status.state === 'error');

export function PrintersPage({ printers, canOperate, onAction, onOpen, onCamera, onFiles, onSettings, onRemove, onWarehouse }: {
  printers: PrinterModel[]; canOperate: boolean;
  onAction: (id: string, action: string) => void; onOpen: (id: string) => void;
  onCamera: (id: string) => void; onFiles: (id: string) => void;
  onSettings?: (id: string) => void; onRemove?: (id: string) => void; onWarehouse?: () => void;
}) {
  const [inventory, setInventory] = useState<FilamentInventory>();
  const [filamentPrinterId, setFilamentPrinterId] = useState<string>();
  const [filter, setFilter] = useState<'all' | 'active' | 'attention'>('all');
  const filamentPrinter = printers.find(p => p.id === filamentPrinterId);
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeFilamentInventory(state => { if (active) setInventory(state); });
    void readFilamentInventory().then(state => { if (active) setInventory(state); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  if (!printers.length) return null;
  const visible = (p: PrinterModel) => filter === 'all' || (filter === 'active' ? printerHasActiveJob(p.status) : needsAttention(p));
  return <section className={`${styles.dashboard} ${styles.manager}`} aria-label="Управление принтерами">
    <section aria-label="Карточки принтеров">
      <div className={styles.filters} role="group" aria-label="Показать принтеры">
        <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Все <b>{printers.length}</b></button>
        <button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>С заданиями <b>{printers.filter(p => printerHasActiveJob(p.status)).length}</b></button>
        <button aria-pressed={filter === 'attention'} onClick={() => setFilter('attention')}>Требуют внимания <b>{printers.filter(needsAttention).length}</b></button>
      </div>
      <div className={styles.grid}>
        {printers.map((p, index) => {
          if (!visible(p)) return null;
          const binding = inventory?.printers[p.id]?.binding;
          const spool = binding?.spoolId ? inventory?.spools.find(item => item.id === binding.spoolId) : undefined;
          return <PrinterCard key={p.id} p={p} index={index + 1} canOperate={canOperate} spool={spool} spoolDiameter={inventory?.materials[binding?.material ?? '']?.diameter} material={binding?.material}
            onAction={onAction} onOpen={onOpen} onCamera={onCamera} onFiles={onFiles} onSettings={onSettings} onRemove={onRemove} onReplaceFilament={setFilamentPrinterId}/>;
        })}
        {!printers.some(visible) && <div className={styles.emptyFilter}>В этой группе сейчас нет принтеров.</div>}
      </div>
    </section>
    {canOperate && filamentPrinter && <FilamentReplaceDialog key={filamentPrinter.id} printer={filamentPrinter} printers={printers} canOperate={canOperate}
      onClose={() => setFilamentPrinterId(undefined)} onWarehouse={onWarehouse ? () => { setFilamentPrinterId(undefined); onWarehouse(); } : undefined}/>}
  </section>;
}
