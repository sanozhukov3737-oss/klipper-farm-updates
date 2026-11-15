import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { AppDialogHost } from './lib/appDialogs';

// Заставка из index.html закрывает белое полотно, которое иначе видно всё время
// запуска: разбор файла приложения на 278 МБ и старт WebView2 занимают около
// двух секунд. Убираем её не по таймеру, а когда React действительно нарисовал
// интерфейс — render() в React 18 возвращает управление до отрисовки, поэтому
// фиксированная задержка могла бы открыть пустой экран раньше времени.
const root = document.getElementById('root')!;
const splash = document.getElementById('kfBoot');
const dismissBootSplash = () => {
  if (!splash || !splash.isConnected) return;
  requestAnimationFrame(() => requestAnimationFrame(() => splash.remove()));
};
if (splash) {
  // Появился первый узел в #root — значит React отрисовал приложение.
  const observer = new MutationObserver(() => {
    if (!root.childElementCount) return;
    observer.disconnect();
    dismissBootSplash();
  });
  observer.observe(root, { childList: true });
  // Если сборка не загрузилась вовсе, молчаливая заставка выглядит как зависание.
  // Через пятнадцать секунд честно говорим, что загрузка затянулась.
  window.setTimeout(() => {
    const state = splash.querySelector('.kfBootState');
    if (splash.isConnected && state) state.textContent = 'Интерфейс загружается дольше обычного…';
  }, 15_000);
}

ReactDOM.createRoot(root).render(
  <React.StrictMode><AppErrorBoundary><I18nProvider><AppDialogHost><App/></AppDialogHost></I18nProvider></AppErrorBoundary></React.StrictMode>
);
