# Release version stamping

Проблема, которую закрывает этот каталог: до R151 версия приложения жила в 15 местах
исходников и нигде не переписывалась при сборке. В результате R145…R151 рапортовали
`1.14.5` в PE-ресурсах, в `APP_VERSION` (диагностика, IPC-хендшейк, `currentVersion`
апдейтера), в имени мьютекса одиночного запуска, в UI и в деинсталляторе.

## Что здесь

| Файл | Назначение |
|---|---|
| `version.json` | единственный источник истины: версия, которая попадёт в сборку |
| `stamp-version.py` | проставляет версию в проверенном дереве `work/app` и убирает версию из имени мьютекса |
| `check-version-stamp.mjs` | гейт после сборки: PE-версия exe/установщика, имя мьютекса, `appVersion` в диагностике |

## Где запускается

`.github/workflows/preview10-natural-understanding.yml`:

1. **после** всех проверенных оверлеев (`r145`…`r154/apply.py`) и **до** сборки —
   `stamp-version.py`. Раньше нельзя: каждый оверлей сверяет `beforeSha256`/`source-manifest.json`
   своего файла и упадёт на изменённом содержимом. Позже нельзя: `generate-release-manifests.mjs`
   пересчитывает `MANIFEST-SHA256.txt`, `npm run build` впекает версию в `dist`, а
   `build-and-install-windows.mjs` сверяет манифест.
2. **после** сборки NSIS — `check-version-stamp.mjs`.

## Что проставляется

| Место | Значение |
|---|---|
| `src-tauri/tauri.conf.json` | `version` → версия установщика (PE `ProductVersion`) |
| `src-tauri/Cargo.toml`, `src-tauri/crates/*/Cargo.toml` | версии крейтов → PE-версия `klipper-farm-client.exe`, `klipper-farmd.exe`, `klipper-farm-ipc-probe.exe` |
| `src-tauri/Cargo.lock` | записи `kf-*` и `klipper-farm-client` |
| `src-tauri/src/lib.rs` | `const APP_VERSION` (диагностика, IPC, `currentVersion`) |
| `package.json`, `package-lock.json`, `e2e/package.json` | npm-версия |
| `src/components/{SystemPanel,SetupWizard,LoginPanel}.tsx` | видимая пользователю версия |
| `scripts/build-and-install-windows.mjs`, `FIX_AND_INSTALL.bat` | баннеры локальной сборки |
| `SBOM-V20.cdx.json` | записи собственных пакетов |
| `src-tauri/src/transactional_core/instance_lease.rs` | `MUTEX_NAME` → `Local\KlipperFarmClient` (без версии) |
| `scripts/check-security.mjs` | жёсткий `assert(pkg.version==='<версия>')` заменяется на проверку SemVer |

## Почему мьютекс без версии

Версия в имени мьютекса не защищала от несовместимости (её закрывают `schema_migrations`,
`protocolVersion` в `klipper-farmd.endpoint.json` и engine lease), но позволяла старому
зависшему процессу предыдущей сборки работать параллельно с новым на одной
`farm.sqlite3`. Именно этот класс ошибок виден в журналах (`DATABASE_WRITER_TIMEOUT`,
`STALE_SESSION`, `ADDRESS_IDENTITY_CONFLICT`). Движок уже использует неверсионированное имя
`Local\KlipperFarmEngine-v18`.

## Использование

```powershell
# проставить версию из version.json и упасть на любом неожиданном остатке
python version-stamp/stamp-version.py --app work/app --audit --audit-strict --report proof/version-stamp.json

# явная версия
python version-stamp/stamp-version.py --app work/app --version 1.15.2

# проверить собранные артефакты
node version-stamp/check-version-stamp.mjs --app work/app
```

Инструмент строгий: если файл есть, но правило не нашлось, сборка падает — «тихо ничего
не проставить» невозможно. Аудит (`--audit-strict`) падает, если после простановки в дереве
остались упоминания предыдущей версии.

## Проверенные исключения аудита

Не все упоминания старой версии в дереве — дефект. Ниже перечислены места, где литерал
обязан остаться, с причиной; всё, что не попало в список, роняет `--audit-strict`.

| Путь | Причина |
|---|---|
| `SBOM-V19.cdx.json` | инвентарь предыдущей платформы V19; поставляется и сканируется OSV только `SBOM-V20.cdx.json`, он проставляется |
| `scripts/check-r119-scope.mjs` | ревизионная проверка R119 сверяет точный исторический текст правки, включая версию той ревизии |
| `scripts/check-update-signing.mjs` | входные данные фикстуры теста подписи обновлений; значение версии — произвольные тестовые данные |
| `ui-tests/*-fixture.tsx` | мок IPC-ответа для UI-фикстуры; версия — тестовые данные, а не версия продукта |

Список живёт в `AUDIT_EXCEPTIONS` в `stamp-version.py`. Если исключение больше не
срабатывает (файл удалён или вычищен), в отчёте появляется запись `skipped` с причиной
`reviewed audit exception matched nothing` — это сигнал убрать лишнюю строку из списка.

