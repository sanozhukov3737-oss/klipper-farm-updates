import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { RotateCcw, RotateCw } from 'lucide-react';
import type { Spool } from '../types';
import type { FilamentSpoolViewer as Viewer } from '../lib/spool-viewer.mjs';
import { filamentColor, spoolDescriptor } from '../lib/filamentSpool';
import { diagnosticWarning } from '../lib/diagnosticLog';
import { cacheSpoolThumbnail, pauseSpoolThumbnails, retrySpoolThumbnails, thumbnailKey } from '../lib/filamentThumbnails';
import { FilamentSpoolThumbnail } from './FilamentSpoolThumbnail';
import styles from './FilamentSpoolViewer.module.css';

export function FilamentSpoolViewer({ spool, diameter }: { spool: Spool; diameter?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null), viewer = useRef<Viewer>();
  const [inspect, setInspect] = useState(false), [zoom, setZoom] = useState(1), [retry, setRetry] = useState(0);
  const [status, setStatus] = useState('Загрузка объёмной катушки…'), [ready, setReady] = useState(false);
  const descriptor = useMemo(() => spoolDescriptor(spool, diameter), [spool, diameter]);
  const descriptorKey = thumbnailKey(descriptor);
  const descriptorRef = useRef(descriptor); descriptorRef.current = descriptor;
  useEffect(() => {
    let active = true;
    setReady(false); setZoom(1); setStatus('Загрузка объёмной катушки…');
    const fail = (error: unknown) => {
      if (!active) return;
      viewer.current?.destroy(); viewer.current = undefined;
      pauseSpoolThumbnails(false); setReady(false);
      diagnosticWarning('filament.viewer', error);
      setStatus('Объёмный просмотр временно недоступен. Цвет и остаток катушки сохранены.');
    };
    void import('../lib/spool-viewer.mjs').then(({ createFilamentSpool }) => {
      if (!active || !canvas.current) return;
      try {
        const instance = createFilamentSpool(canvas.current, { spool: descriptorRef.current, pixelRatioCap: 1.5, onError: fail });
        viewer.current = instance;
        cacheSpoolThumbnail(descriptorRef.current, instance.captureThumbnail(160));
        setReady(true); setStatus('');
      } catch (error) { fail(error); }
    }).catch(fail);
    return () => { active = false; viewer.current?.destroy(); viewer.current = undefined; pauseSpoolThumbnails(false); };
  }, [retry]);
  useEffect(() => {
    const instance = viewer.current;
    if (!instance) return;
    try {
      instance.setSpool(descriptor);
      // Cache the approved default angle; changing selection must not give a
      // printer thumbnail the arbitrary angle of a previous inspection.
      const view = instance.getState().view;
      instance.setView({ yaw: -.80, pitch: .21, roll: -.075, zoom: 1 });
      cacheSpoolThumbnail(descriptor, instance.captureThumbnail(160));
      instance.setView(view);
    } catch (error) { instance.destroy(); viewer.current = undefined; setReady(false); diagnosticWarning('filament.viewer.update', error); setStatus('Объёмный просмотр прерван. Откройте его заново.'); }
  }, [descriptorKey]);
  useEffect(() => { viewer.current?.setMode(inspect ? 'inspect' : 'card'); viewer.current?.resize(); }, [inspect, ready]);
  const rotate = (direction: number) => { const instance = viewer.current; if (instance) instance.setView({ yaw: instance.getState().view.yaw + direction * .35 }); };
  const scale = (delta: number) => { const value = Math.max(.8, Math.min(1.9, Math.round((zoom + delta) * 10) / 10)); setZoom(value); viewer.current?.setView({ zoom: value }); };
  return <div className={`${styles.viewer} ${inspect ? styles.inspect : ''}`} style={{ '--plastic': filamentColor(spool.color) } as CSSProperties} data-testid="filament-3d-viewer" data-ready={ready} data-inspect={inspect}>
    <div className={styles.viewTools}>{inspect && <><button type="button" aria-label="Отдалить катушку" disabled={!ready || zoom <= .8} onClick={() => scale(-.1)}>−</button><output>{Math.round(zoom * 100)}%</output><button type="button" aria-label="Приблизить катушку" disabled={!ready || zoom >= 1.9} onClick={() => scale(.1)}>+</button></>}<button type="button" aria-pressed={inspect} onClick={() => setInspect(value => !value)}>{inspect ? 'К карточке' : 'Крупно'}</button></div>
    <canvas key={retry} ref={canvas} className={styles.canvas} data-filament-color={spool.color ?? ''} data-filament-grams={spool.remainingWeight} data-filament-finish={spool.finish ?? 'normal'} style={{ visibility: ready ? 'visible' : 'hidden' }}
      onPointerDown={() => pauseSpoolThumbnails(true)} onPointerUp={() => pauseSpoolThumbnails(false)} onPointerCancel={() => pauseSpoolThumbnails(false)} onLostPointerCapture={() => pauseSpoolThumbnails(false)}/>
    {!ready && <div className={styles.fallback}><FilamentSpoolThumbnail spool={spool} diameter={diameter} label={`Выбранная катушка ${spool.name}`}/><span role="status">{status}</span>{!status.startsWith('Загрузка') && <button type="button" onClick={() => { retrySpoolThumbnails(); setRetry(value => value + 1); }}>Повторить 3D-просмотр</button>}</div>}
    <div className={styles.turn}><button type="button" aria-label="Повернуть влево" disabled={!ready} onClick={() => rotate(-1)}><RotateCcw aria-hidden="true"/></button><span>Повернуть</span><button type="button" aria-label="Повернуть вправо" disabled={!ready} onClick={() => rotate(1)}><RotateCw aria-hidden="true"/></button></div>
  </div>;
}
