import { memo } from 'react';
import { Camera, Pause, Play, Settings2, Trash2, Usb } from 'lucide-react';
import type { PrinterModel, Spool } from '../types';
import { printerDisplayName } from '../lib/printerName';
import { printerPresentationPreset } from '../lib/printerPresentation';
import { hasPrinterCamera } from './PrinterCamera';
import { printerIsReachable, printerWorkingChannel } from '../lib/printerHealth';
import { printerHasActiveJob } from '../lib/printerJob';
import { jobFreshness } from '../lib/printerTelemetry';
import { useLiveNow } from '../lib/liveClock';
import { FleetPrinterCard } from './FleetPrinterCard';
import styles from './FleetLive.module.css';

function PrinterCardView({ p, index, spool, spoolDiameter, material, canOperate = false, onAction, onOpen, onCamera, onFiles, onSettings, onRemove, onReplaceFilament }: {
  p: PrinterModel; index: number; spool?: Spool; spoolDiameter?: number; material?: string; canOperate?: boolean;
  onAction: (id: string, action: string) => void; onOpen: (id: string) => void;
  onCamera: (id: string) => void; onFiles: (id: string) => void;
  onSettings?: (id: string) => void; onRemove?: (id: string) => void; onReplaceFilament?: (id: string) => void;
}) {
  const now = useLiveNow(), name = printerDisplayName(p, index - 1);
  const remoteSuspended = !!p.status.remoteControlSuspended;
  const online = printerIsReachable(p.status);
  const freshness = jobFreshness(p.status, now), confirmed = freshness === 'live' || freshness === 'stale';
  const activeJob = confirmed && printerHasActiveJob(p.status), paused = p.status.state === 'paused';
  const preset = printerPresentationPreset(p);
  const modelLabel = preset === 'ender3-v3-ke' ? 'KE' : preset === 'ender3-v3-se' ? 'SE' : preset === 'creality-k1c-2025' ? 'K1C' : preset === 'creality-k1-max' ? 'K1 MAX' : preset === 'flashforge-ad5m' ? '5M' : 'KLIPPER';
  return <FleetPrinterCard printer={p} index={index - 1} now={now} spool={spool} spoolDiameter={spoolDiameter} material={material} onOpen={onOpen}
    modelLabel={modelLabel} channel={printerWorkingChannel(p.status)} onReplaceFilament={canOperate ? onReplaceFilament : undefined}
    actions={<>
      <button type="button" title="Моя флешка — файлы G-code" aria-label={`Моя флешка: ${name}`} onClick={() => onFiles(p.id)}><Usb/><span>Моя флешка</span></button>
      {onSettings && <button type="button" title="Настройки" onClick={() => onSettings(p.id)}><Settings2/><span>Настройки</span></button>}
      {hasPrinterCamera(p) && <button type="button" title="Камера" onClick={() => onCamera(p.id)}><Camera/><span>Камера</span></button>}
      {canOperate && online && activeJob && !remoteSuspended && <button type="button" title={paused ? 'Продолжить' : 'Пауза'} onClick={() => onAction(p.id, paused ? 'resume' : 'pause')}>{paused ? <Play/> : <Pause/>}<span>{paused ? 'Продолжить' : 'Пауза'}</span></button>}
      {onRemove && <button type="button" className={styles.removeAction} title={`Удалить принтер «${name}»`} aria-label={`Удалить принтер «${name}»`} onClick={() => onRemove(p.id)}><Trash2/><span>Удалить</span></button>}
    </>}/>;
}

export const PrinterCard = memo(PrinterCardView);
