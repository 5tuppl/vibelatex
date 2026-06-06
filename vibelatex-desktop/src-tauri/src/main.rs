mod commands;
mod watcher;

use commands::{
    compile, export_pdf, get_initial_state, get_pdf_path, init_project, initial_latexmk_status,
    open_project, save_file, AppState,
};

fn main() {
    let latexmk_status = initial_latexmk_status();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::new(latexmk_status))
        .invoke_handler(tauri::generate_handler![
            get_initial_state,
            open_project,
            init_project,
            save_file,
            compile,
            export_pdf,
            get_pdf_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running VibeLaTeX Desktop");
}
