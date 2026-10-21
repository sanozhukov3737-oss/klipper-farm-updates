import type { FilamentSpoolDescriptor, FilamentSpoolViewer } from './spool-viewer.mjs';

const VERSION = 'approved-wide-spokes-0167dad3-v1';
const LIMIT = 64;
const cache = new Map<string, string>();
const waiting = new Map<string, { spool: FilamentSpoolDescriptor; listeners: Set<(image: string) => void> }>();
let worker: FilamentSpoolViewer | undefined, canvas: HTMLCanvasElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined, cleanup: ReturnType<typeof setTimeout> | undefined;
let running = false, unavailable = false, interacting = false, generated = 0;
export const thumbnailKey = (spool: FilamentSpoolDescriptor) => JSON.stringify([VERSION, spool, -.80, .21, -.075, 1, 160]);
export function getSpoolThumbnail(spool: FilamentSpoolDescriptor) { return cache.get(thumbnailKey(spool)); }
export function cacheSpoolThumbnail(spool: FilamentSpoolDescriptor, image: string) {
  const key = thumbnailKey(spool);
  cache.delete(key); cache.set(key, image);
  while (cache.size > LIMIT) cache.delete(cache.keys().next().value!);
  const job = waiting.get(key);
  waiting.delete(key);
  job?.listeners.forEach(listener => listener(image));
}
export function pauseSpoolThumbnails(value: boolean) { interacting = value; if (!value) schedule(); }
function disposeWorker() { worker?.destroy(); worker = undefined; canvas?.remove(); canvas = undefined; }
function schedule() {
  if (timer || running || interacting || unavailable || document.hidden || !waiting.size) return;
  timer = setTimeout(() => { timer = undefined; void generate(); }, 120);
}
async function generate() {
  if (running || interacting || document.hidden) { schedule(); return; }
  const entry = waiting.entries().next().value;
  if (!entry) return;
  const [key, job] = entry;
  if (!job.listeners.size) { waiting.delete(key); schedule(); return; }
  running = true;
  let completed = false;
  if (cleanup) clearTimeout(cleanup);
  try {
    const { createFilamentSpool } = await import('./spool-viewer.mjs');
    if (interacting || document.hidden) return;
    // The selected card has its own viewer. Every visible list shares this one
    // small, sequential worker; there is never a context for each row.
    if (!worker) {
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;left:-10000px;top:0;width:160px;height:160px;pointer-events:none';
      canvas.setAttribute('aria-hidden', 'true'); document.body.append(canvas);
      worker = createFilamentSpool(canvas, { spool: job.spool, pixelRatioCap: 1, interactive: false,
        onError: () => { unavailable = true; disposeWorker(); } });
    } else worker.setSpool(job.spool);
    cacheSpoolThumbnail(job.spool, worker.captureThumbnail(160)); generated++; completed = true;
  } catch {
    // A data-accurate SVG and the text remain available. Retry after reopening
    // the app or explicitly retrying the detailed viewer, not once per row.
    unavailable = true; completed = true; disposeWorker();
  } finally {
    if (completed) waiting.delete(key); running = false;
    cleanup = setTimeout(disposeWorker, 1000);
    schedule();
  }
}
export function subscribeSpoolThumbnail(spool: FilamentSpoolDescriptor, listener: (image: string) => void) {
  const cached = getSpoolThumbnail(spool);
  if (cached) { listener(cached); return () => {}; }
  const key = thumbnailKey(spool), job = waiting.get(key) ?? { spool, listeners: new Set() };
  job.listeners.add(listener); waiting.set(key, job); schedule();
  return () => { job.listeners.delete(listener); if (!job.listeners.size) waiting.delete(key); };
}
export function retrySpoolThumbnails() { unavailable = false; schedule(); }
export function spoolThumbnailStats() { return { cached: cache.size, limit: LIMIT, pending: waiting.size, workers: worker ? 1 : 0, generated, unavailable }; }
window.addEventListener('pagehide', () => { if (timer) clearTimeout(timer); if (cleanup) clearTimeout(cleanup); disposeWorker(); });
document.addEventListener('visibilitychange', schedule);
