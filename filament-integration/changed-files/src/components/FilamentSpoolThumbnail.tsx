import { useEffect, useMemo, useRef, useState } from 'react';
import type { Spool } from '../types';
import { spoolDescriptor } from '../lib/filamentSpool';
import { getSpoolThumbnail, subscribeSpoolThumbnail, thumbnailKey } from '../lib/filamentThumbnails';
import { FilamentSpoolVisual } from './FilamentSpoolVisual';
import styles from './FilamentSpoolViewer.module.css';

export function FilamentSpoolThumbnail({ spool, diameter, label }: { spool: Spool; diameter?: number; label: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const descriptor = useMemo(() => spoolDescriptor(spool, diameter), [spool, diameter]);
  const key = thumbnailKey(descriptor);
  const [image, setImage] = useState<{ key: string; url: string }>();
  useEffect(() => {
    let unsubscribe = () => {}, subscribed = false;
    const load = () => { subscribed = true; unsubscribe = subscribeSpoolThumbnail(descriptor, url => setImage({ key, url })); };
    if (typeof IntersectionObserver === 'undefined') { load(); return () => unsubscribe(); }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { if (!subscribed) load(); }
      else { unsubscribe(); subscribed = false; }
    }, { rootMargin: '120px' });
    if (element.current) observer.observe(element.current);
    return () => { observer.disconnect(); unsubscribe(); };
  }, [key]);
  const source = image?.key === key ? image.url : getSpoolThumbnail(descriptor);
  return <span ref={element} className={styles.thumbnail} role="img" aria-label={label} data-spool-thumbnail="true"
    data-filament-color={spool.color ?? ''} data-filament-grams={spool.remainingWeight} data-filament-finish={spool.finish ?? 'normal'} data-thumbnail-cached={!!source}>
    {source ? <img src={source} alt="" draggable={false}/> : <FilamentSpoolVisual color={spool.color} fraction={spool.remainingWeight / spool.initialWeight} label={label} decorative/>}
  </span>;
}
