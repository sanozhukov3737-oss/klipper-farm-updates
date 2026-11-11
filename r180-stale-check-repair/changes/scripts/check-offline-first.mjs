import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};

const app=read('src/App.tsx');
const offline=read('src/lib/offlineFirst.ts');
const moonraker=read('src/lib/moonraker.ts');
const files=read('src/components/PrinterFilesPanel.tsx');
const production=read('src/components/ProductionPanel.tsx');
const telegram=read('src/lib/telegram.ts');
const system=read('src-tauri/src/system_commands.rs');
const styles=read('src/styles.css');
const html=read('index.html');

assert(offline.includes("'online-lan'|'local-lan'|'cache-only'")&&offline.includes("window.addEventListener('offline',update)"),'offline-first network state machine is missing');
assert(offline.includes("label:'● ЛОКАЛЬНЫЙ РЕЖИМ'")&&offline.includes('локальная печать работает'),'local LAN mode must explicitly keep printing available');
assert(app.includes('subscribeInternetAvailability(setInternetAvailable)')&&app.includes('offlineFirstStatus(internetAvailable,online,printers.length)'),'application network mode is not wired');
assert(app.includes('mode-${networkStatus.mode}')&&styles.includes('.kfCyberEyebrow.mode-local-lan')&&styles.includes('.kfCyberEyebrow.mode-cache-only'),'compact online/local/cache indicator is missing');
assert(!/if\s*\(\s*!?internetAvailable\s*\)\s*return/.test(app),'internet availability must never gate the local application');
assert(moonraker.includes("secureInvoke<PrinterActorOperationResult>('printer_actor_rpc'")&&moonraker.includes("secureInvoke<any>('moonraker_rpc'")&&moonraker.includes("secureInvoke<NativeUploadBegin>('transactional_upload_begin'"),'Moonraker actor and resumable upload must stay on the native LAN transport');

assert(files.includes('files:CachedPrinterFile[]')&&files.includes('lastSyncedAt?:number'),'per-printer offline file cache schema is missing');
assert(files.includes('hydrateCache')&&files.includes('Показан локальный кеш файлов'),'printer file cache is not hydrated when Moonraker is unavailable');
assert(files.includes('boundedFileCache(metadataRows)')&&files.includes('MAX_FILE_CACHE_JSON_CHARS'),'file cache has no storage bound');
assert(files.includes('if (!client || !canOperate || !canSync) return')&&files.includes('Печать доступна, когда локальный Moonraker'),'cached files must remain read-only until the LAN printer is reachable');

assert(production.includes("LIBRARY_KEY='production.libraryCache'")&&production.includes('libraryFromCache(cached,printers)'),'production library is not restored from local SQLite');
assert(production.includes("usingCache?'Локальный кеш':'LAN синхронизирован'")&&production.includes("printerIsReachable(printer.status)"),'production library does not distinguish cache from live LAN data');
// Telegram отправляется нативным слоем: во фронтенде нет ни fetch, ни своих таймаутов.
// Проверяем обе половины: фронтенд не ходит в сеть сам, а Rust ставит таймауты
// и уводит запрос с основного пути, чтобы недоступный Telegram не считался
// отказом ядра.
assert(!telegram.includes('fetch(')&&telegram.includes('telegramSendNative'),'Telegram must not reach the network from the frontend');
assert(system.includes('max-time = 8')&&system.includes('connect-timeout = 5')&&system.includes('ActorIo'),'optional Telegram requests can still block or masquerade as a core failure');

const combined=`${styles}\n${html}`;
assert(!/@import\s+url\([^)]*https?:\/\//i.test(combined)&&!/src=["']https?:\/\//i.test(combined),'application shell still depends on remote assets');

console.log('offline-first OK: local auth/data, LAN printing, bounded caches and isolated online services');
