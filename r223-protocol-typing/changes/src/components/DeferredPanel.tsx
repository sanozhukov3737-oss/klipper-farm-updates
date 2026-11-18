import { Component, Suspense, lazy, useEffect, useState, type ComponentProps, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { diagnosticWarning } from '../lib/diagnosticLog';
import { useModalAccessibility } from '../lib/modalAccessibility';
import './DeferredPanel.css';

type PanelProps = { onClose: () => void };
type PanelOptions = { title: string; embedded?: boolean };
type FallbackProps = PanelOptions & { onClose: () => void; failed?: boolean };

function DeferredFallback({ title, embedded, onClose, failed }: FallbackProps) {
  const [id] = useState(() => `deferred-panel-${++fallbackId}`);
  // The wrapper owns return focus until the actual panel closes. Resolving
  // the chunk must not restore the trigger over the newly opened panel.
  useModalAccessibility(onClose, `[data-deferred-panel="${id}"]`, title, !embedded, false);
  const content = <section className="kfDeferredPanel" data-deferred-panel={id} data-deferred-state={failed ? 'error' : 'loading'}
    aria-label={title} role={embedded ? 'region' : undefined}>
    <div role={failed ? 'alert' : 'status'} aria-live="polite">
      {!failed && <LoaderCircle className="kfDeferredSpinner" aria-hidden="true" />}
      <h2>{title}</h2>
      <p>{failed ? 'Не удалось открыть раздел. Закройте его или перезагрузите интерфейс.' : 'Открываем раздел…'}</p>
    </div>
    <footer>
      {failed && <button type="button" className="primary" onClick={() => window.location.reload()}>Перезагрузить интерфейс</button>}
      <button type="button" onClick={onClose} aria-label={`Закрыть: ${title}`}>Закрыть</button>
    </footer>
  </section>;
  return embedded ? content : <div className="kfDeferredOverlay">{content}</div>;
}

let fallbackId = 0;

class PanelBoundary extends Component<FallbackProps & { children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    diagnosticWarning('ui.panel_load', error, { operation: 'panel.open' });
  }
  render() {
    return this.state.failed ? <DeferredFallback {...this.props} failed /> : this.props.children;
  }
}

/** Create the lazy object without invoking its loader until the panel is opened. */
// Компоненты панелей имеют разные наборы пропсов, поэтому здесь any — это
// требование React.lazy, а не лазейка.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deferredPanel<T extends ComponentType<any>>(loader: () => Promise<{ default: T }>, options: PanelOptions): ComponentType<ComponentProps<T> & PanelProps> {
  type Props = ComponentProps<T> & PanelProps;
  // Keep a fulfilled lazy object across closes, so reopening does not suspend.
  // Browsers can cache a failed module fetch; recovery therefore offers an
  // explicit interface reload rather than pretending to retry the same URL.
  const View = lazy(loader);
  function DeferredPanel(props: Props) {
    const [originalFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    useEffect(() => {
      if (options.embedded) return;
      return () => {
        // Existing panels may queue their own cleanup. Run after those
        // callbacks, and leave focus with any newly opened modal.
        queueMicrotask(() => queueMicrotask(() => {
          if (!originalFocus?.isConnected) return;
          if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
          originalFocus.focus();
        }));
      };
    }, [originalFocus]);
    // The wrapper forwards the exact inferred panel props and owns no ref.
    const CurrentView = View as ComponentType<Props>;
    return <PanelBoundary {...options} onClose={props.onClose}>
      <Suspense fallback={<DeferredFallback {...options} onClose={props.onClose} />}>
        <CurrentView {...props} />
      </Suspense>
    </PanelBoundary>;
  }
  DeferredPanel.displayName = `DeferredPanel(${options.title})`;
  return DeferredPanel;
}
