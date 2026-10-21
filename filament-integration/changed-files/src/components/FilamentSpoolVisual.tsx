import { useId } from 'react';
import styles from './FilamentInventoryPanel.module.css';

export function FilamentSpoolVisual({ color, fraction = 1, label, decorative = false }: { color?: string; fraction?: number; label: string; decorative?: boolean }) {
  const id = useId().replace(/:/g, '');
  const amount = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const fill = color && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color) ? color : '#9299a4';
  const radius = 22 + Math.sqrt(amount) * 37;
  const width = radius * .78;
  return <svg className={styles.spoolVisual} viewBox="0 0 240 204" role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined} data-filament-color={decorative ? undefined : color || ''}>
    <defs>
      <linearGradient id={`${id}-frame`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#67717f"/><stop offset=".45" stopColor="#303946"/><stop offset="1" stopColor="#1c232e"/></linearGradient>
      <linearGradient id={`${id}-light`} x1="0" y1="0" x2="1" y2=".8"><stop stopColor="#fff" stopOpacity=".34"/><stop offset=".4" stopColor="#fff" stopOpacity="0"/><stop offset="1" stopColor="#000" stopOpacity=".25"/></linearGradient>
      <linearGradient id={`${id}-side`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fff" stopOpacity=".14"/><stop offset=".45" stopColor="#000" stopOpacity=".04"/><stop offset="1" stopColor="#000" stopOpacity=".4"/></linearGradient>
    </defs>
    <ellipse cx="122" cy="188" rx="83" ry="9" fill="#000" opacity=".12"/>
    <ellipse cx="150" cy="81" rx="57" ry="72" fill={`url(#${id}-frame)`} stroke="#8290a2" strokeOpacity=".25"/>
    <ellipse cx="150" cy="81" rx="48" ry="62" fill="#161e28"/>
    <path d="M91 84 150 57v48l-59 27Z" fill="#303946"/>
    {amount > 0 && <g data-filament-surface="true" fill={fill}>
      <path d={`M91 ${108-radius} 150 ${81-radius}a${width} ${radius} 0 0 1 0 ${radius*2}L91 ${108+radius}Z`}/>
      <path d={`M91 ${108-radius} 150 ${81-radius}a${width} ${radius} 0 0 1 0 ${radius*2}L91 ${108+radius}Z`} fill={`url(#${id}-side)`}/>
      {Array.from({length:16}, (_, index) => <ellipse key={index} cx={96+index*3.3} cy={106-index*1.5} rx={width} ry={radius} fill="none" stroke="#000" strokeOpacity=".13" strokeWidth=".7"/>)}
    </g>}
    <ellipse cx="91" cy="108" rx="58" ry="73" fill={`url(#${id}-frame)`} stroke="#92a0b2" strokeOpacity=".25"/>
    <ellipse cx="91" cy="108" rx="49" ry="63" fill="#1c2430"/>
    {amount > 0 && <g>
      <ellipse cx="91" cy="108" rx={width} ry={radius} fill={fill} data-filament-surface="true"/>
      {Array.from({length:19}, (_, index) => 24+index*2).filter(value => value < radius).map(value => <ellipse key={value} cx="91" cy="108" rx={value*.78} ry={value} fill="none" stroke="#000" strokeOpacity=".19" strokeWidth=".7"/>)}
      <ellipse cx="91" cy="108" rx={width} ry={radius} fill={`url(#${id}-light)`}/>
    </g>}
    <g transform="translate(91 108) scale(.78 1)" fill={`url(#${id}-frame)`}>
      {Array.from({ length: 8 }, (_, index) => <path key={index} transform={`rotate(${index * 45})`} d="M-9-25 -14-65Q0-73 14-65L9-25Z"/>)}
    </g>
    <ellipse cx="91" cy="108" rx="54" ry="69" fill="none" stroke="#252c35" strokeWidth="8"/>
    <ellipse cx="91" cy="108" rx="21" ry="28" fill="#eae7dd" stroke="#a7aca5"/>
    <ellipse cx="91" cy="108" rx="10" ry="14" fill="var(--ui-surface-2)" stroke="#141b24" strokeWidth="3"/>
    <path d="M61 49q26-17 50-2M47 134q3 18 16 28M119 158q15-14 20-33" fill="none" stroke="#121a24" strokeWidth="5" strokeLinecap="round"/>
    <path d="M43 91q0-27 20-44" fill="none" stroke="#c4d0e1" strokeOpacity=".25" strokeWidth="2"/>
    {amount > .05 && <path d="M179 120q24 19 22 41t19 17" fill="none" stroke={fill} strokeWidth="2.5" strokeLinecap="round"/>}
  </svg>;
}
