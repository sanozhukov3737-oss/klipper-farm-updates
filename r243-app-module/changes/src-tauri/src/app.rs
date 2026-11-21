//! Сборка приложения Tauri и жизненный цикл окна.
//!
//! Здесь только проводка: состояния, плагины, обработчики событий и список
//! команд. Логика живёт в модулях, которые этот файл подключает.

use tauri::Manager;

// generate_handler! требует и саму команду, и сгенерированный рядом с ней
// макрос __cmd__*, поэтому команды подключаются из модулей-определений, а не
// через реэкспорт в корне.
use std::thread;
use std::time::Duration;

use crate::transactional_core::instance_lease::InstanceLease;
use crate::{
    database, desktop_background, desktop_startup, engine_client, offline_semantic, online_updates,
    storage_paths,
    AuthState, DiscoveryState, LocalTransferState,
    TransactionalCore, TransactionalUploadState, UploadState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let smoke_requested = desktop_startup::smoke_requested();
    desktop_startup::set_smoke_mode(smoke_requested);
    desktop_startup::install_panic_hook();
    desktop_startup::record(
        "DESKTOP_PROCESS_STARTED",
        &desktop_startup::process_identity(),
    );
    let smoke = match desktop_startup::DesktopSmoke::from_process_args() {
        Ok(smoke) => smoke,
        Err(error) => {
            desktop_startup::report_failure("DESKTOP_ARGUMENT_VALIDATION_FAILED", &error);
            return;
        }
    };
    // Профиль WebView2 (кэш Chromium) уводим в выбранный корень данных до того,
    // как Tauri создаст окно и WebView2 создаст своё окружение.
    storage_paths::configure_webview_root();
    // Decide ownership before Tauri creates a second visible login window.
    // Waiting here cannot block the primary process's WebView event loop.
    let lease = if smoke.is_none() {
        match InstanceLease::acquire() {
            Ok(lease) => Some(lease),
            Err(error) if error == "INSTANCE_ALREADY_RUNNING" => {
                desktop_startup::record(
                    "SECONDARY_INSTANCE_FOCUS_REQUESTED",
                    "existing desktop acknowledged the focus request",
                );
                return;
            }
            Err(error) => {
                desktop_startup::report_failure("DESKTOP_INSTANCE_LEASE_FAILED", &error);
                return;
            }
        }
    } else {
        None
    };
    if let Err(error) = run_desktop(smoke, lease) {
        desktop_startup::report_failure("TAURI_DESKTOP_RUN_FAILED", &error);
    }
}

pub(crate) fn run_desktop(
    smoke: Option<desktop_startup::DesktopSmoke>,
    lease: Option<InstanceLease>,
) -> Result<(), String> {
    let smoke_for_setup = smoke.clone();
    let smoke_for_page_load = smoke;
    let result = tauri::Builder::default()
        .manage(AuthState::default())
        .manage(online_updates::UpdateState::default())
        .manage(DiscoveryState::default())
        .manage(UploadState::default())
        .manage(LocalTransferState::default())
        .manage(TransactionalCore::default())
        .manage(engine_client::EngineClient::default())
        .manage(desktop_background::BackgroundState::default())
        .manage(TransactionalUploadState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .on_window_event(desktop_background::on_window_event)
        .on_page_load(move |webview, payload| {
            if webview.label() != "main"
                || !matches!(
                    payload.event(),
                    tauri::webview::PageLoadEvent::Finished
                )
            {
                return;
            }
            desktop_startup::mark_window_ready(payload.url().as_str());
            if let Some(smoke) = smoke_for_page_load.as_ref() {
                let exit_code = match desktop_startup::write_smoke_marker(
                    smoke,
                    webview.label(),
                    payload.url().as_str(),
                ) {
                    Ok(()) => 0,
                    Err(error) => {
                        desktop_startup::record("DESKTOP_SMOKE_MARKER_FAILED", &error);
                        72
                    }
                };
                webview.app_handle().exit(exit_code);
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("MAIN_TAURI_WINDOW_NOT_CREATED"))?;
            window.show()?;
            window.unminimize()?;
            if let Err(error) = window.set_focus() {
                desktop_startup::record("MAIN_WINDOW_FOCUS_FAILED", &error.to_string());
            }
            if !window.is_visible()? {
                return Err(std::io::Error::other("MAIN_TAURI_WINDOW_NOT_VISIBLE").into());
            }
            desktop_startup::record("MAIN_TAURI_WINDOW_SHOWN", "window=main visible=true");

            if smoke_for_setup.is_none() {
                let lease = lease.ok_or_else(|| {
                    std::io::Error::other("DESKTOP_INSTANCE_LEASE_MISSING")
                })?;
                if let Err(error) = lease.start_focus_listener(
                    handle.clone(),
                    app.state::<AuthState>().hello_busy.clone(),
                ) {
                    desktop_startup::report_failure("FOCUS_LISTENER_START_FAILED", &error);
                    handle.exit(73);
                    return Ok(());
                }
                if !app.manage(lease) {
                    desktop_startup::report_failure(
                        "DESKTOP_INSTANCE_LEASE_DUPLICATED",
                        "Tauri state already contains InstanceLease",
                    );
                    handle.exit(73);
                    return Ok(());
                }
                if let Err(error) = database::initialize_app_database(&handle) {
                    desktop_startup::report_failure("DESKTOP_DATABASE_INIT_FAILED", &error);
                    handle.exit(73);
                    return Ok(());
                }
                if let Err(error) = desktop_background::initialize(&handle) {
                    // A missing system tray must preserve ordinary close/exit.
                    desktop_startup::record("BACKGROUND_TRAY_UNAVAILABLE", &error);
                }
                engine_client::EngineClient::initialize_background(handle.clone());
                online_updates::cleanup_background(handle.clone());
            }

            let watchdog_handle = handle;
            if let Err(error) = thread::Builder::new()
                .name("klipper-farm-desktop-startup-watchdog".into())
                .spawn(move || {
                    thread::sleep(Duration::from_secs(30));
                    if !desktop_startup::window_ready() {
                        desktop_startup::report_failure(
                            "DESKTOP_WINDOW_READY_TIMEOUT",
                            "Tauri created the process but the main WebView did not finish loading in 30 seconds",
                        );
                        watchdog_handle.exit(74);
                    }
                })
            {
                desktop_startup::report_failure(
                    "DESKTOP_STARTUP_WATCHDOG_FAILED",
                    &error.to_string(),
                );
                app.handle().exit(73);
            }
            Ok(())
        })
        .invoke_handler(crate::invoke_handler())
        .build(tauri::generate_context!());
    let app = result.map_err(|error| error.to_string())?;
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            offline_semantic::shutdown();
            // AppHandle clones can outlive the window; do not rely on managed
            // state Drop to stop the desktop-owned engine.
            handle.state::<engine_client::EngineClient>().shutdown();
        }
    });
    desktop_startup::record(
        "DESKTOP_EVENT_LOOP_EXITED",
        "Tauri event loop returned with managed-state cleanup",
    );
    Ok(())
}
