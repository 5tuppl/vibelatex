use std::path::{Path, PathBuf};

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::commands::{schedule_compile, CompileLogPayload};

pub struct ProjectWatcher {
    _watcher: RecommendedWatcher,
}

pub fn watch_project(app: AppHandle, project_path: PathBuf) -> Result<ProjectWatcher, String> {
    let project_for_callback = project_path.clone();
    let app_for_callback = app.clone();

    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| match result {
            Ok(event) => {
                if event
                    .paths
                    .iter()
                    .any(|path| is_relevant_project_file(&project_for_callback, path))
                {
                    schedule_compile(app_for_callback.clone(), project_for_callback.clone());
                }
            }
            Err(error) => {
                let _ = app_for_callback.emit(
                    "compile-log",
                    CompileLogPayload {
                        line: format!("Watcher error: {error}"),
                    },
                );
            }
        },
        Config::default(),
    )
    .map_err(|error| format!("Could not create file watcher: {error}"))?;

    watcher
        .watch(&project_path, RecursiveMode::Recursive)
        .map_err(|error| format!("Could not watch {}: {error}", project_path.display()))?;

    Ok(ProjectWatcher { _watcher: watcher })
}

fn is_relevant_project_file(project_path: &Path, path: &Path) -> bool {
    if path
        .strip_prefix(project_path)
        .ok()
        .map(|relative| {
            relative
                .components()
                .any(|component| component.as_os_str() == "build")
        })
        .unwrap_or(false)
    {
        return false;
    }

    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("tex" | "bib" | "cls" | "sty")
    )
}
