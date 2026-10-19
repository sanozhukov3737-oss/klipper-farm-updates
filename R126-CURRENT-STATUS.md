# R126: пакет передан, Windows-сборка выполняется

Точка продолжения обновлена 19 октября 2026 года. Этот файл заменяет прежнюю отметку о блокировке передачи в R126-RELEASE-CONTINUE.md. Содержимое KF-R126-release-checkpoint.zip остаётся неизменным историческим снимком.

- Репозиторий: sanozhukov3737-oss/klipper-farm-updates.
- Удалённая ветка r126-flashforge-files создана через GitHub UI от R125-коммита 3e34be13ab07294af888b202d721d6d04e7f7426.
- Загружены r126-patch.json, три отчёта этапов, .gitattributes, архив KF-R126-release-checkpoint.zip с CI, подробными доказательствами и git bundle. Размеры и Git blob SHA всех загруженных файлов совпали с локальными.
- Пакет: 30 файлов, SHA-256 20d20017dfa46ccbb53ffca6b243aeb4691a88e4f4c8c670f3fda83512ddfeae.
- Архив передачи: SHA-256 c0ab6e573aaa4ae0bcb0854c2ccf4412f692d7ab2ff1ad8ec0ccc1d5895447a0. Workflow проверяет его и восстанавливает исходные CI-скрипты/фрагменты перед проверкой пакета.
- Первая Windows-попытка 39289752620 остановилась на Python cp1252 при чтении UTF-8 JSON. Применена конкретная правка: PYTHONUTF8=1 в workflow. Производственные исходники не менялись.
- Исходная компиляция: https://github.com/sanozhukov3737-oss/klipper-farm-updates/actions/runs/39290258346. Job build 118188773609 завершён успешно: профиль/файлы/пластик, Windows Edge UI, переносимость, Rust, Clippy, release-бинарники и NSIS. Общий run завершён failure только из-за сравнения установленного desktop EXE с неупакованным бинарником.
- Build head: 7a734159c835fa5ee2a2a395a66895e572a48e9e. SHA-256 workflow: d5babaf92963ffa192f15a7d2076bd8ed917382f095cf904ae253108b8e617af.
- Готовый кандидат: artifact 12207022304, digest sha256:2fcd3d287648bc3c4329ec960a836b68791c267454840f5f3e984e9a3bc62b0e, размер 1051974621 байт. Исходники и установщик после компиляции не менялись.
- Повторная приёмка: https://github.com/sanozhukov3737-oss/klipper-farm-updates/actions/runs/39295706051; head 65c0003211b392cd3d0669fea681fdd740050789; workflow .github/workflows/validate-r126-exact.yml; SHA-256 6e4aacd60b7e2daf53beb610350f048c7cd56f39edc7693992370397553c0131.
- Проверка r126-check-installed-payload.mjs допускает только штатную замену первого __TAURI_BUNDLE_TYPE_VAR_UNK на __TAURI_BUNDLE_TYPE_VAR_NSS в desktop EXE, как в Tauri bundler. Все остальные байты и daemon должны совпадать; полный ожидаемый SHA-256 сверяется. Дополнительное изменение блокируется. Пока проверить результат на настоящем кандидате по новому run; не объявлять причину подтверждённой до получения отчёта installed-payload.json.
- Неудачный промежуточный run 39295490260 не запускал jobs: в выделенном workflow была лишняя needs: build. Зависимость удалена. Нативная компиляция не повторялась.

## Далее

Дождаться validate и publish повторной приёмки 39295706051. При конкретной ошибке исправлять только причину, сохраняя пакет и остальные проверки. Установка R126 поверх R125, сохранность семи синтетических конфигураций и пластика в настоящей SQLite, два запуска установленного WebView и нативная телеметрия с эмулятором должны пройти на неизменённых байтах кандидата из job build 118188773609. Компиляция и повторная приёмка относятся к разным run; связывать их по immutable artifact, provenance, точным хешам, head и отчётам. Не заявлять один успешный run компиляции и установки. Физического принтера нет.

Успешная сборка публикует только prerelease r126. Перед stable скачать именно его установщик, проверить хеш/размер, подписать штатным scripts/sign-v20-update.mjs manifest sequence 126 существующим локальным ключом. Затем подготовить r126-promotion-contract.json по конкретным build run/head/release/assets, загрузить r126-signed-update.json и .github/workflows/promote-r126.yml. Подготовленные r126-inspect-promotion.py и r126-verify-promotion.mjs проверяют исходники, Windows-доказательства и Ed25519-подпись без закрытого ключа в CI.

Закрытый ключ остаётся только в /workspace/scratch/db49ddc1b758/release-private/KF-PUBLISHER-PRIVATE.pem; не выводить, не коммитить и не загружать на GitHub. Авторизация браузерного обхода дана пользователем после HTTP 403 текущего GitHub connector. Чтение metadata и logs через connector работает.

Релиз готов только после фактической stable/latest-публикации и проверки публичных EXE, SHA-256 и releases/latest/download/update-v20.json.
