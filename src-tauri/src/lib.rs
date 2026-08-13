//! Tauri 앱 진입 로직. main.rs는 이 `run()`만 호출한다(데스크톱/모바일 공용 구조).

mod commands;
mod secretstore;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// 창을 트레이에서 다시 복원(최소화 해제 + 표시 + 포커스).
fn restore_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 앱을 구성하고 실행한다. 모든 IPC 커맨드를 여기서 등록한다.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 중복 실행 방지: 두 번째 인스턴스가 뜨면 기존 창을 복원·포커스하고 새 창은 종료.
        // (단일 인스턴스 플러그인은 가장 먼저 등록해야 한다.)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            restore_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 시스템 트레이: 최소화하면 트레이로 숨고, 더블클릭/메뉴로 복원.
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "열기", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            let _tray = TrayIconBuilder::with_id("plume-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Plume — API Design Studio")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => restore_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        restore_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // 최소화되면 작업표시줄에서 숨겨 트레이에만 남긴다.
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                if window.is_minimized().unwrap_or(false) {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::import_spec,
            commands::export_spec,
            commands::validate_spec,
            commands::spec_to_markdown,
            commands::render_redoc_html,
            commands::send_http_request,
            commands::open_project,
            commands::new_project,
            commands::split_into_project,
            commands::export_project,
            commands::load_client_config,
            commands::save_client_config,
            commands::import_bru,
            commands::export_bru,
            commands::export_bru_collection,
            commands::import_bru_collection,
            commands::import_bruno_environment,
            commands::import_postman_collection,
            commands::import_postman_environment,
            commands::export_postman_collection,
            commands::code_snippets,
            commands::run_load,
            commands::run_load_group,
            commands::write_pages_docs,
            commands::export_standalone_html,
            commands::publish_github_pages,
            commands::deploy_cloudfront,
            commands::deploy_config_load,
            commands::deploy_config_save,
            commands::app_meta_save,
            commands::app_meta_load,
            commands::app_version,
            commands::git_status,
            commands::git_log,
            commands::git_init,
            commands::git_stage_all,
            commands::git_commit,
            commands::git_push,
            commands::git_pull,
            commands::git_stash_save,
            commands::git_stash_list,
            commands::git_stash_pop,
            commands::git_stash_apply,
            commands::git_stash_drop,
            commands::git_branches,
            commands::git_checkout,
            commands::git_stage,
            commands::git_unstage,
            commands::git_discard,
            commands::git_fetch,
            commands::git_delete_branch,
            commands::git_diff_file,
            commands::write_text_file,
            commands::write_bytes_file,
            commands::read_text_file,
            commands::list_workspaces,
            commands::rename_workspace,
            commands::delete_workspace,
            commands::save_workspace_collections,
            commands::load_workspace_collections,
            commands::git_graph,
            commands::git_graph_data,
            commands::git_remotes,
            commands::git_add_remote,
            commands::git_remove_remote,
            commands::git_set_remote_url,
            commands::git_push_upstream,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 앱 실행 중 오류");
}
