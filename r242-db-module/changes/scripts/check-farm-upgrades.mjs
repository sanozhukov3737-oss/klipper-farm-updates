import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const section=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));

const app=read('src/App.tsx');
const notification=read('src/components/NotificationCenter.tsx');
const files=read('src/components/PrinterFilesPanel.tsx');
const compatibility=read('src/lib/gcodeCompatibility.ts');
const validation=read('src/lib/gcodeValidation.ts');
const analysis=read('src/lib/gcodeAnalysis.ts');
const queue=read('src/components/QueuePanel.tsx');
const dashboard=read('src/components/FleetDashboard.tsx');
const farmReports=read('src/lib/farmReports.ts');
const moonraker=read('src/lib/moonraker.ts');
const printerHealth=read('src/lib/printerHealth.ts');
const analytics=read('src/components/AnalyticsPanel.tsx');
const crypto=read('src/lib/backupCrypto.ts');
const system=read('src/components/SystemPanel.tsx');
const login=read('src/components/LoginPanel.tsx');
const rust=`${read('src-tauri/src/lib.rs')}\n${read('src-tauri/src/moonraker_protocol.rs')}\n${read('src-tauri/src/system_commands.rs')}`;
const installer=read('FIX_AND_INSTALL.bat');
const manifestVerifier=read('scripts/verify-release-manifest.ps1');
const offlineConfig=read('src-tauri/tauri.offline.conf.json');
const offlineManifest=read('OFFLINE-PAYLOAD-SHA256.txt');
const cargoConfig=read('.cargo/config.toml');
const cargo=read('src-tauri/Cargo.toml');
const styles=read('src/styles.css');

// Лента уведомлений переехала в db_commands: границей служит следующая
// функция того же модуля, а не users_list из другого файла.
const db_commands=read('src-tauri/src/db_commands.rs');
const notifications=section(db_commands,'fn notification_list(','#[tauri::command]');
assert(notifications.includes('Role::Viewer')&&notifications.includes("'printer.error'")&&notifications.includes("'queue.auto_blocked'"),'safe viewer notification feed is missing');
assert(db_commands.includes('notification_action_allowed(&action)')&&db_commands.includes('наблюдатель может записывать только безопасные события'),'viewer notification events are not restricted by an allowlist');
const notificationAllowlist=section(rust,'fn notification_action_allowed','#[tauri::command]\nfn audit_list'),allowedActions=[...notificationAllowlist.matchAll(/"([a-z][a-z0-9_.]+)"/g)].map(match=>match[1]).sort(),feedActions=[...notifications.matchAll(/'([a-z][a-z0-9_.]+)'/g)].map(match=>match[1]).sort();
// Запись обязана быть подмножеством чтения: всё, что разрешено писать через
// notification, должно появляться в ленте. Обратное неверно намеренно:
// расход пластика пишет атомарная команда инвентаря
// (filament_inventory.rs), и эти действия обязаны читаться, хотя в
// notification allowlist их нет. Равенство здесь было неверным допущением.
const missingFromFeed=allowedActions.filter(action=>!feedActions.includes(action));
assert(missingFromFeed.length===0,'notification actions missing from the feed: '+missingFromFeed.join(', '));
assert(notification.includes('notificationList(120)')&&notification.includes('klipper-notifications-read-id-v2-')&&notification.includes('entry.id>lastReadId')// Проверка системных уведомлений вынесена в отдельный компонент: сам центр её
// больше не вызывает, поэтому ищем либо прямой вызов, либо этот компонент и
// требуем, чтобы он действительно вызывал nativeNotify.
&&(notification.includes('nativeNotify(')||(notification.includes('NotificationTest')&&read('src/components/NotificationTest.tsx').includes('nativeNotify('))),'notification center is incomplete');
assert(notification.includes("unread>9?'9+':unread")&&notification.includes('aria-controls="notification-drawer"'),'notification badge or accessible drawer toggle is not bounded');
assert(styles.includes('.notificationBell:before,\n:root[data-theme] .notificationBell:after{content:none!important;display:none!important}'),'legacy neon notification corners still leak into the productivity UI');

assert(files.includes('onDrop={drop}')&&files.includes("crypto.subtle.digest('SHA-256'")&&/folders\??:\s*string\[\]/.test(files),'drag/drop, duplicate hashing or file projects are missing');
assert(files.includes('setUploadProgress')&&/metadataCompatibility\(printer,\s*metadata\)/.test(files),'upload progress or compatibility badges are missing');
assert(files.includes('printerFilesOverview')&&files.includes('printerFileControls'),'live storage overview or responsive file controls are missing');
assert(compatibility.includes('sourcePrinterPreset')&&compatibility.includes('maxNozzleTemp')&&compatibility.includes('maxBedTemp'),'model/profile compatibility checks are incomplete');
assert(validation.includes('analyzeGCodeText(text)')&&validation.includes("code:'printer_model'"),'bounded G-code analysis or printer-model preflight is missing');
assert(analysis.includes('FIRMWARE_RESTART')&&analysis.includes('RUN_SHELL_COMMAND')&&analysis.includes('CX_'),'dangerous command or firmware-family preflight is missing');
assert(analysis.includes('while(offset<text.length)')&&analysis.includes('MAX_SCANNED_GCODE_LINE_LENGTH'),'large-file G-code scan is not bounded');
assert(!validation.includes('Math.max(...values')&&!validation.includes('Math.min(...values'),'G-code validation can still overflow the WebView call stack');

assert(queue.includes('draggable={canOperate}')&&queue.includes('enqueue(ordered.map(job=>job.filename),true)'),'queue drag reorder is missing');
assert(queue.includes("audit('queue.auto_blocked'")&&queue.includes('await validateGCode(client,printer,next.filename)')&&queue.includes('confirmed.queued_jobs[0]?.job_id!==next.job_id'),'queue auto-start is not protected by preflight and a fresh queue-state check');
// Классы собираются шаблонной строкой вместе с CSS-модулями, поэтому
// сравнивать точную запись className="..." нельзя: имя класса сохраняем, форму
// записи — нет.
assert(dashboard.includes('infoDashboard')&&dashboard.includes('infoPrinterGrid')&&app.includes('dashboardTopSummary'),'information-only dashboard structure is missing');
assert(dashboard.includes('За 30 дней')&&dashboard.includes('Успешность')&&dashboard.includes('Часы печати')&&dashboard.includes('Филамент')&&dashboard.includes('Заданий'),'farm report summary is not embedded in the dashboard');
assert(dashboard.includes('dailyLoad.map')&&dashboard.includes('onReports'),'bounded utilization trend is not linked to the full report');
assert(!dashboard.includes('fleetTimeline')&&!dashboard.includes('Пауза')&&!dashboard.includes('Стоп'),'dashboard must not expose event clutter or printer controls');
assert(!dashboard.includes('Очередь свободна')&&!dashboard.includes('БЫСТРЫЕ ДЕЙСТВИЯ')&&!dashboard.includes('queueStatus('),'duplicate queue/quick-action dashboard widgets were not removed');
assert(farmReports.includes("dbGet<PrintRecord[]>('production.printRecords'")&&farmReports.includes('calculateFarmReportStats')&&farmReports.includes('filamentKnown'),'dashboard and full reports do not share the persisted farm-history aggregation');

assert(moonraker.includes('readConnectionInfo')&&moonraker.includes('connectionReachable')&&moonraker.includes('nextPollDelay'),'resilient Moonraker heartbeat/polling is missing');
assert(!moonraker.includes('scheduleReconnect')&&!moonraker.includes('Klippy is not ready'),'polling must recover in place and must not treat non-ready Klipper as offline');
assert(printerHealth.includes('CONNECTION_INITIAL_GRACE_MS=15_000')&&printerHealth.includes('CONNECTION_OFFLINE_GRACE_MS=30_000'),'connection grace windows are missing');
assert(printerHealth.includes("failureKind==='authorization'||failureKind==='compatibility'||failureKind==='protocol'||failureKind==='service'")&&printerHealth.includes("phase:'degraded'"),'reachable API failures are still collapsed into offline');

assert(app.includes("dbSet('production.printRecords'")&&app.includes('snapshotStore('),'print records or automatic snapshots are not persisted');
assert(analytics.includes('exportCsv')&&analytics.includes('exportJson')&&analytics.includes('snapshotRead('),'history reports or snapshot viewer are missing');
assert(rust.includes('fn snapshot_extension')&&rust.includes('data.len() > 12 * 1024 * 1024')&&rust.includes('entries.len().saturating_sub(500)'),'snapshot validation, size limit or retention policy is missing');

assert(crypto.includes("name:'AES-GCM'")&&crypto.includes("name:'PBKDF2'")&&crypto.includes('ITERATIONS=310_000')&&crypto.includes('additionalData'),'authenticated backup encryption is incomplete');
assert(system.includes('.kfarm')&&system.includes('encryptBackup(await backupJson()')&&system.includes('decryptBackup(source,backupPassword)'),'encrypted backup UI is not wired');
const backup=section(rust,'fn db_backup_json(','#[tauri::command]\nfn db_restore_json');
assert(!backup.includes('password_hash')&&!backup.includes('pin_hash'),'password/PIN hashes must not be exported in backup JSON');
// Автовход по PIN проверяем по механике, а не по тексту подсказки: ввод
// шести цифр запускает authenticate() сам, без нажатия кнопки.
assert(login.includes('authMethodChoice')&&login.includes('phonePinKeys')&&login.includes('loginWithPin')&&login.includes('pin.length!==PIN_LENGTH')&&login.includes('setTimeout(()=>void authenticate()'),'automatic phone-style PIN login is missing');

// Сборка переехала из .bat в scripts/build-and-install-windows.mjs: там же
// задаётся единственный запрошенный бандл.
assert(installer.includes('build --bundles nsis')||read('scripts/build-and-install-windows.mjs').includes("'--bundles','nsis'"),'Windows build must create only the requested NSIS bundle');
// Порог свободного места теперь проверяет сам сборщик, а не .bat: он сравнивает
// avail*bsize с 12 ГБ и падает отдельным этапом.
assert(read('scripts/build-and-install-windows.mjs').includes('12*1024**3'),'low-disk build guards are missing');
// Перенаправление кеша сборки переехало в сборщик: он задаёт CARGO_HOME,
// CARGO_TARGET_DIR и TEMP внутри корня кеша на диске проекта.
const builder=read('scripts/build-and-install-windows.mjs');
assert(builder.includes("CARGO_HOME:path.join(cacheRoot,'cargo')")&&builder.includes("CARGO_TARGET_DIR:targetRoot")&&builder.includes("TEMP:tempRoot"),'project-drive build cache redirection is missing');
// Офлайн-инструменты и сверка манифеста живут в сборщике.
assert(builder.includes('tauri-cli')&&builder.includes('OFFLINE-PAYLOAD-SHA256.txt')&&builder.includes('verify-release-manifest'),'packaged Tauri CLI or offline payload verification is missing');
// Оба манифеста проверяются одним и тем же верификатором, но вызовы теперь
// в сборщике: по одному на release и offline.
assert((builder.match(/await verifyManifest\('(?:release|offline)'/g)??[]).length===2&&manifestVerifier.includes('Get-FileHash')&&manifestVerifier.includes('UTF8Encoding]::new($false, $true)'),'release/offline manifests are not both verified with strict UTF-8 and SHA-256');
assert(offlineConfig.includes('"beforeBuildCommand": null')&&offlineConfig.includes('"frontendDist": "../dist"'),'offline Tauri config must use the packaged frontend without a build hook');
assert(offlineConfig.includes('"useLocalToolsDir": true')&&offlineConfig.includes('"type": "skip"'),'offline NSIS cache or network-free WebView mode is missing');
assert(cargoConfig.includes('replace-with = "vendored-sources"')&&cargoConfig.includes('directory = "rv"')&&cargoConfig.includes('offline = true'),'Cargo is not locked to the packaged vendor source');
assert(offlineManifest.includes('*dist/index.html')&&offlineManifest.includes('*offline-tools/tauri-cli/node_modules/@tauri-apps/cli-win32-x64-msvc/cli.win32-x64-msvc.node'),'offline frontend or Windows builder is absent from the checksum manifest');
assert(builder.includes('rust-vendor-v1144.tar.gz')&&builder.includes('nsis-3.11.zip')&&builder.includes('nsis_tauri_utils-0.5.3.dll'),'packaged Rust or NSIS payload is not wired');
assert(builder.includes("CARGO_NET_OFFLINE:'true'")&&builder.includes("'metadata','--offline','--locked'"),'Cargo network access is not disabled and proven before compilation');
assert(builder.includes("runNode('Rust tests','scripts/run-rust-tests.mjs')"),'Windows Rust tests bypass the PE loader compatibility preflight');
assert(!installer.includes('call npm ')&&!installer.includes('npm ci')&&!installer.includes('npm run'),'Windows installer must not depend on npm network access');
assert(!installer.includes('KF_BUILD_ATTEMPT')&&!installer.includes('Retrying once'),'offline build must fail immediately instead of repeating a long deterministic error');
// В .bat больше нет метки :failed: он тонкий запускатель, а решение,
// что сохранять при сбое, принимает сборщик.
const failedSection=builder.slice(builder.indexOf('function fail'));
assert(!failedSection.includes('rmdir /s /q "%CARGO_TARGET_DIR%"')&&!failedSection.includes('rmdir /s /q "%KF_CACHE_ROOT%"'),'failed builds must retain Cargo downloads and compiled objects');
assert(!installer.includes('$env:USERPROFILE')&&!installer.includes('not_enough_cache_space'),'Windows user-drive cache check must not block a project-drive build');
assert(builder.includes('fs.rmSync(resolved,{recursive:true,force:true'),'temporary Rust artifacts are not cleaned');
assert(cargo.includes('crate-type= ["rlib"]')&&cargo.includes('[profile.release]')&&cargo.includes('strip="symbols"'),'desktop low-disk Cargo profile is missing');

console.log('farm upgrades OK: notifications, file library, preflight, queue automation, dashboard reports, reconnect telemetry, encrypted backup and fully offline Windows build');
