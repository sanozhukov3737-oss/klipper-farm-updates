import { AlertCircle, ArrowLeftRight, ChevronRight, Clock3, FileCode2, Layers3, Thermometer } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PrinterModel, Spool } from '../types';
import { printerDisplayName } from '../lib/printerName';
import { fallbackPrinterArtwork, printerArtwork } from '../lib/printerArtwork';
import { printerConnectionReasonLabel, printerWorkingChannel } from '../lib/printerHealth';
import { printerHostDisplay } from '../lib/printerEndpoint';
import { compactTelemetryLabel, confirmedTemperature, jobFreshness, telemetryFreshness } from '../lib/printerTelemetry';
import { finishDuration, finishTime, printerFinish, printerLayerLabel } from '../lib/printerFinish';
import { usePrinterVisualActivity } from '../lib/usePrinterVisualActivity';
import { ModelIcon } from './ModelIcon';
import { FilamentSpoolThumbnail } from './FilamentSpoolThumbnail';
import { PrinterTemperatureSparkline } from './PrinterTemperatureSparkline';
import styles from './FleetLive.module.css';

export function FleetPrinterCard({ printer, index, now, spool, spoolDiameter, material, onOpen, onReplaceFilament, modelLabel, channel = printerWorkingChannel(printer.status), actions }: { printer: PrinterModel; index: number; now: number; spool?: Spool; spoolDiameter?: number; material?: string; onOpen: (id: string) => void; onReplaceFilament?: (id: string) => void; modelLabel?: string; channel?: string; actions?: ReactNode }) {
  const status = printer.status, finish = printerFinish(status, now);
  // Если файл фото модели не отдался (повреждённая сборка, нехватка места),
  // показываем силуэт этой модели, а не общую заглушку: иконка следует
  // за выбранной моделью с момента её выбора в карточке.
  const [photoFailed, setPhotoFailed] = useState(false);
  const modelIcon = printer.icon && printer.icon !== 'custom' ? printer.icon : undefined;
  const fresh = jobFreshness(status, now), known = fresh === 'live' || fresh === 'stale';
  const telemetry = telemetryFreshness(status, now);
  const activity = usePrinterVisualActivity(printer.id);
  const lastCompletion = useRef(activity.completedAt), [flashAt, setFlashAt] = useState(0);
  const freshOnline = telemetry === 'live' && fresh === 'live' && status.connectionState === 'online' && !status.remoteControlSuspended;
  const livePrinting = freshOnline && status.state === 'printing';
  const error = status.state === 'error';
  const errorReason = status.message?.trim() || status.connectionMessage?.trim() || 'Проверьте принтер';
  useEffect(() => {
    // Only a newly confirmed completion can start the effect. Opening a card
    // after an earlier event must not replay it or infer success from ready.
    if (activity.completedAt === lastCompletion.current) return;
    // The shared clock may still be on the preceding tick when the completion
    // publisher fires. Keep the event unseen until that clock catches up.
    if (activity.completedAt > now) return;
    lastCompletion.current = activity.completedAt;
    if (activity.completedAt > 0 && now >= activity.completedAt && now - activity.completedAt < 8000 && freshOnline && status.state === 'ready') setFlashAt(activity.completedAt);
  }, [activity.completedAt, freshOnline, now, status.state]);
  const completion = flashAt > 0 && now >= flashAt && now - flashAt < 8000 && freshOnline && status.state === 'ready';
  const paused = known && status.state === 'paused';
  const tone = status.state === 'error' || status.connectionState === 'offline' || status.state === 'offline' ? 'danger'
    : paused || status.remoteControlSuspended || status.connectionState !== 'online' || fresh !== 'live' ? 'warning' : finish.active ? 'printing' : 'ready';
  const label = status.remoteControlSuspended ? 'Автономно' : status.connectionState === 'offline' || status.state === 'offline' ? 'Нет связи'
    : status.connectionState === 'connecting' ? 'Подключение' : status.state === 'error' ? 'Ошибка'
    : status.connectionState === 'degraded' ? 'Проверяем связь' : fresh !== 'live' ? 'Нет свежих данных' : paused ? 'На паузе' : finish.active ? 'Печатает' : completion ? 'Завершено' : 'Готов';
  const progress = finish.progress === undefined ? undefined : Math.round(finish.progress * 100);
  const layer = printerLayerLabel(status, now);
  const name = printerDisplayName(printer, index);
  const Material = onReplaceFilament ? 'button' : 'span';
  return <article className={styles.printerCard} data-tone={tone} data-live-printing={livePrinting ? 'true' : undefined} data-complete={completion ? 'true' : undefined} data-printer-error={error ? 'true' : undefined} data-testid={`live-printer-${printer.id}`}>
    {completion && <span key={flashAt} className={styles.completionFlash} aria-hidden="true" data-testid="printer-completion-flash"/>}
    <button type="button" className={styles.openCard} onClick={() => onOpen(printer.id)} aria-label={`Открыть ${name}`} title={error ? `${name}: ${errorReason}` : undefined}/>
    <header className={styles.cardHeader}>
      <div className={styles.identity}><strong className={styles.name} data-testid="printer-name">{name}</strong><small className={styles.host} data-testid="printer-address">{modelLabel && `${modelLabel} · `}{printerHostDisplay(printer.host)}{channel && <em className={styles.channel}>{channel}</em>}</small></div>
      <span className={styles.state} data-tone={tone}><i/>{label}</span>
    </header>
    <div className={styles.stage}>
      <div className={styles.visual}>
        <svg className={styles.progressRing} viewBox="0 0 144 144" aria-hidden="true"><circle cx="72" cy="72" r="65"/><circle className={styles.ringValue} cx="72" cy="72" r="65" pathLength="100" strokeDasharray={`${finish.active && progress !== undefined ? progress : 0} 100`}/></svg>
        {photoFailed && modelIcon
          ? <span className={styles.artwork} data-testid="printer-artwork"><ModelIcon type={modelIcon}/></span>
          : <img className={styles.artwork} data-testid="printer-artwork" src={printerArtwork(printer)} alt="" onError={event => { if (event.currentTarget.src !== new URL(fallbackPrinterArtwork, location.href).href) { event.currentTarget.src = fallbackPrinterArtwork; if (modelIcon) setPhotoFailed(true); } }}/>}
        <span className={styles.percent}>{finish.active && progress !== undefined ? `${progress}%` : tone === 'ready' ? 'ГОТОВ' : '—'}</span>
      </div>
      <div className={styles.jobBody}>
        <div className={styles.job} data-job-error={error ? 'true' : undefined}>{error ? <AlertCircle aria-hidden="true"/> : <FileCode2 aria-hidden="true"/>}<b title={error ? errorReason : known ? status.filename : undefined}>{error ? errorReason : !known ? 'Ожидаем данные задания' : finish.active ? status.filename || 'Текущее задание' : 'Свободен для нового задания'}</b></div>
        <div className={styles.finish} data-testid="printer-finish"><small><Clock3 aria-hidden="true"/>{finish.finishAt ? 'Закончит примерно' : 'Состояние'}</small><strong>{finish.finishAt ? finishTime(finish.finishAt, now) : finish.label}</strong>{finish.remainingSeconds !== undefined && <span>ещё {finishDuration(finish.remainingSeconds)}</span>}</div>
        {layer && finish.active && <span className={styles.layer}><Layers3 aria-hidden="true"/>{layer}</span>}
      </div>
    </div>
    <div className={styles.telemetry} data-testid="printer-telemetry" data-freshness={telemetry}>
      <span className={styles.temperatureCell}><Thermometer aria-hidden="true"/><small>Сопло</small><b>{confirmedTemperature(status.nozzle, status, now).replace('C', '')}</b><PrinterTemperatureSparkline samples={activity.samples} sensor="nozzle" label="Сопло" fresh={telemetry === 'live' && status.connectionState === 'online' && !status.remoteControlSuspended}/></span>
      <span className={styles.temperatureCell}><Thermometer aria-hidden="true"/><small>Стол</small><b>{confirmedTemperature(status.bed, status, now).replace('C', '')}</b><PrinterTemperatureSparkline samples={activity.samples} sensor="bed" label="Стол" fresh={telemetry === 'live' && status.connectionState === 'online' && !status.remoteControlSuspended}/></span>
      <Material className={styles.material} title={onReplaceFilament ? 'Выбрать или заменить пластик' : spool ? `${spool.name} · ${spool.color || 'Цвет не указан'}` : material || 'Пластик не выбран'}
        {...(onReplaceFilament ? { type: 'button' as const, onClick: () => onReplaceFilament(printer.id), 'aria-label': `${material ? 'Сменить' : 'Выбрать'} пластик: ${name}`, 'aria-haspopup': 'dialog' as const } : {})}>
        {spool ? <FilamentSpoolThumbnail spool={spool} diameter={spoolDiameter} label={`${spool.material}, ${Math.round(spool.remainingWeight)} г`}/> : <Layers3 aria-hidden="true"/>}
        <small>{spool?.material || material || 'Пластик'}</small><b>{spool ? `${Math.round(spool.remainingWeight)} г` : material ? 'Из запаса' : 'Не выбран'}</b>
        {onReplaceFilament && <ArrowLeftRight className={styles.replaceIcon} aria-hidden="true"/>}
      </Material>
    </div>
    <footer className={styles.footer}><span title={printerConnectionReasonLabel(status)}><i data-live={telemetry === 'live' && status.connectionState === 'online'}/>{compactTelemetryLabel(status, now)}</span><ChevronRight aria-hidden="true"/></footer>
    {actions && <div className={styles.actions} role="group" aria-label={`Управление: ${name}`}>{actions}</div>}
  </article>;
}
