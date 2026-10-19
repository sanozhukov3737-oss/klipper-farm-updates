# R126: пакет передан, Windows-сборка выполняется

Точка продолжения обновлена 19 октября 2026 года. Этот файл заменяет прежнюю отметку о блокировке передачи в R126-RELEASE-CONTINUE.md. Содержимое KF-R126-release-checkpoint.zip остаётся неизменным историческим снимком.

- Репозиторий: sanozhukov3737-oss/klipper-farm-updates.
- Удалённая ветка r126-flashforge-files создана через GitHub UI от R125-коммита 3e34be13ab07294af888b202d721d6d04e7f7426.
- Загружены r126-patch.json, три отчёта этапов, .gitattributes, архив KF-R126-release-checkpoint.zip с CI, подробными доказательствами и git bundle. Размеры и Git blob SHA всех загруженных файлов совпали с локальными.
- Пакет: 30 файлов, SHA-256 20d20017dfa46ccbb53ffca6b243aeb4691a88e4f4c8c670f3fda83512ddfeae.
- Архив передачи: SHA-256 c0ab6e573aaa4ae0bcb0854c2ccf4412f692d7ab2ff1ad8ec0ccc1d5895447a0. Workflow проверяет его и восстанавливает исходные CI-скрипты/фрагменты перед проверкой пакета.
- Первая Windows-попытка 39289752620 остановилась на Python cp1252 при чтении UTF-8 JSON. Применена конкретная правка: PYTHONUTF8=1 в workflow. Производственные исходники не менялись.
- Текущий Windows run: https://github.com/sanozhukov3737-oss/klipper-farm-updates/actions/runs/39290258346.
- Build head: 7a734159c835fa5ee2a2a395a66895e572a48e9e. SHA-256 workflow: d5babaf92963ffa192f15a7d2076bd8ed917382f095cf904ae253108b8e617af.
- Подтверждены применение к чистому R125 и сохранность остальных байтов, проверки производственных модулей и UI в Windows Edge. Остальные этапы проверить по фактическому run; не считать успешными заранее.

## Далее

Дождаться build, validate, publish текущего run. При конкретной ошибке исправлять только причину, сохраняя пакет и остальные проверки. Установка R126 поверх R125, сохранность семи синтетических конфигураций и пластика в настоящей SQLite, два запуска установленного WebView и нативная телеметрия с эмулятором должны пройти в одном успешном run. Физического принтера нет.

Успешная сборка публикует только prerelease r126. Перед stable скачать именно его установщик, проверить хеш/размер, подписать штатным scripts/sign-v20-update.mjs manifest sequence 126 существующим локальным ключом. Затем подготовить r126-promotion-contract.json по конкретным build run/head/release/assets, загрузить r126-signed-update.json и .github/workflows/promote-r126.yml. Подготовленные r126-inspect-promotion.py и r126-verify-promotion.mjs проверяют исходники, Windows-доказательства и Ed25519-подпись без закрытого ключа в CI.

Закрытый ключ остаётся только в /workspace/scratch/db49ddc1b758/release-private/KF-PUBLISHER-PRIVATE.pem; не выводить, не коммитить и не загружать на GitHub. Авторизация браузерного обхода дана пользователем после HTTP 403 текущего GitHub connector. Чтение metadata и logs через connector работает.

Релиз готов только после фактической stable/latest-публикации и проверки публичных EXE, SHA-256 и releases/latest/download/update-v20.json.
