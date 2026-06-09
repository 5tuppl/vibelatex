use std::{
    collections::HashSet,
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::watcher::{self, ProjectWatcher};

pub struct AppState {
    active_project: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<ProjectWatcher>>,
    latexmk_status: LatexmkStatus,
    compile_generation: AtomicU64,
    compiling: AtomicBool,
    compile_pending: AtomicBool,
}

impl AppState {
    pub fn new(latexmk_status: LatexmkStatus) -> Self {
        Self {
            active_project: Mutex::new(None),
            watcher: Mutex::new(None),
            latexmk_status,
            compile_generation: AtomicU64::new(0),
            compiling: AtomicBool::new(false),
            compile_pending: AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LatexmkStatus {
    pub available: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectPayload {
    pub project_path: String,
    pub project_name: String,
    pub content: String,
    pub pdf_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct InitialStatePayload {
    pub latexmk: LatexmkStatus,
    pub project: Option<ProjectPayload>,
}

#[derive(Clone, Debug, Serialize)]
pub struct LatexIssue {
    pub kind: String,
    pub message: String,
    pub line: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompileStartedPayload {
    pub project_path: String,
    pub timestamp: u128,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompileLogPayload {
    pub line: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CompileDonePayload {
    pub success: bool,
    pub pdf_path: Option<String>,
    pub errors: Vec<LatexIssue>,
    pub log: Vec<String>,
    pub exit_code: Option<i32>,
    pub message: Option<String>,
}

struct LatexmkRun {
    exit_code: Option<i32>,
    success: bool,
    log: Vec<String>,
    message: Option<String>,
}

pub fn initial_latexmk_status() -> LatexmkStatus {
    match Command::new("latexmk").arg("-version").output() {
        Ok(output) if output.status.success() => LatexmkStatus {
            available: true,
            message: "latexmk found.".to_string(),
        },
        Ok(output) => LatexmkStatus {
            available: false,
            message: format!(
                "latexmk exists but returned exit code {:?}. Check your TeX installation.",
                output.status.code()
            ),
        },
        Err(error) => LatexmkStatus {
            available: false,
            message: format!(
                "latexmk was not found: {error}. Install TeX Live, MacTeX, or MiKTeX with latexmk."
            ),
        },
    }
}

#[tauri::command]
pub async fn get_initial_state(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InitialStatePayload, String> {
    let project = match read_last_project(&app) {
        Ok(Some(path)) => open_project_path(&app, &state, path).ok(),
        Ok(None) => None,
        Err(_) => None,
    };

    Ok(InitialStatePayload {
        latexmk: state.latexmk_status.clone(),
        project,
    })
}

#[tauri::command]
pub async fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ProjectPayload, String> {
    open_project_path(&app, &state, PathBuf::from(path))
}

#[tauri::command]
pub async fn init_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<ProjectPayload, String> {
    let project_path = expand_user_path(path.trim())?;
    init_project_files(&project_path)?;
    open_project_path(&app, &state, project_path)
}

#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    state: State<'_, AppState>,
    content: String,
) -> Result<(), String> {
    let project_path = active_project_path(&state)?;
    let main_tex = project_path.join("main.tex");

    tokio::fs::write(&main_tex, content)
        .await
        .map_err(|error| format!("Could not save {}: {error}", main_tex.display()))?;

    schedule_compile(app, project_path);
    Ok(())
}

#[tauri::command]
pub async fn compile(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let project_path = active_project_path(&state)?;
    schedule_compile(app, project_path);
    Ok(())
}

#[tauri::command]
pub async fn export_pdf(state: State<'_, AppState>, destination: String) -> Result<String, String> {
    let project_path = active_project_path(&state)?;
    let source = project_path.join("build").join("main.pdf");

    if !source.is_file() {
        return Err("No compiled PDF found. Compile the project first.".to_string());
    }

    let mut destination_path = expand_user_path(destination.trim())?;
    if destination_path.is_dir() {
        destination_path = destination_path.join(default_pdf_file_name(&project_path));
    }

    if destination_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("pdf")
    {
        destination_path.set_extension("pdf");
    }

    if let Some(parent) = destination_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }

    fs::copy(&source, &destination_path).map_err(|error| {
        format!(
            "Could not copy {} to {}: {error}",
            source.display(),
            destination_path.display()
        )
    })?;

    Ok(path_to_string(destination_path))
}

#[tauri::command]
pub async fn get_pdf_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let project_path = active_project_path(&state)?;
    Ok(existing_pdf_path(&project_path).map(path_to_string))
}

fn open_project_path(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: PathBuf,
) -> Result<ProjectPayload, String> {
    let project_path = fs::canonicalize(&path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;

    if !project_path.is_dir() {
        return Err(format!("{} is not a folder.", project_path.display()));
    }

    let main_tex = project_path.join("main.tex");
    if !main_tex.is_file() {
        return Err(format!(
            "{} does not contain a main.tex file.",
            project_path.display()
        ));
    }

    let content = fs::read_to_string(&main_tex)
        .map_err(|error| format!("Could not read {}: {error}", main_tex.display()))?;

    let project_watcher = watcher::watch_project(app.clone(), project_path.clone())?;

    {
        let mut active = state
            .active_project
            .lock()
            .map_err(|_| "Project state is poisoned.".to_string())?;
        *active = Some(project_path.clone());
    }

    {
        let mut watcher_slot = state
            .watcher
            .lock()
            .map_err(|_| "Watcher state is poisoned.".to_string())?;
        *watcher_slot = Some(project_watcher);
    }

    save_last_project(app, &project_path)?;

    let payload = ProjectPayload {
        project_name: project_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| project_path.display().to_string()),
        project_path: path_to_string(project_path.clone()),
        content,
        pdf_path: existing_pdf_path(&project_path).map(path_to_string),
    };

    schedule_compile(app.clone(), project_path);
    Ok(payload)
}

fn init_project_files(project_path: &Path) -> Result<(), String> {
    if project_path.exists() && !project_path.is_dir() {
        return Err(format!("{} is not a folder.", project_path.display()));
    }

    fs::create_dir_all(project_path)
        .map_err(|error| format!("Could not create {}: {error}", project_path.display()))?;

    let main_tex = project_path.join("main.tex");
    if !main_tex.exists() {
        fs::write(&main_tex, DEFAULT_MAIN_TEX)
            .map_err(|error| format!("Could not write {}: {error}", main_tex.display()))?;
    }

    let references_bib = project_path.join("references.bib");
    if !references_bib.exists() {
        fs::write(&references_bib, DEFAULT_REFERENCES_BIB)
            .map_err(|error| format!("Could not write {}: {error}", references_bib.display()))?;
    }

    Ok(())
}

pub fn schedule_compile(app: AppHandle, project_path: PathBuf) {
    let generation = {
        let state = app.state::<AppState>();
        state.compile_generation.fetch_add(1, Ordering::SeqCst) + 1
    };

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;

        let is_latest = {
            let state = app.state::<AppState>();
            state.compile_generation.load(Ordering::SeqCst) == generation
        };

        if is_latest {
            run_compile_queue(app, project_path).await;
        }
    });
}

async fn run_compile_queue(app: AppHandle, project_path: PathBuf) {
    let already_compiling = {
        let state = app.state::<AppState>();
        state.compiling.swap(true, Ordering::SeqCst)
    };

    if already_compiling {
        let state = app.state::<AppState>();
        state.compile_pending.store(true, Ordering::SeqCst);
        return;
    }

    let mut current_project = project_path;

    loop {
        {
            let state = app.state::<AppState>();
            state.compile_pending.store(false, Ordering::SeqCst);
        }

        if active_project_path_opt(&app).as_ref() != Some(&current_project) {
            break;
        }

        compile_project(app.clone(), current_project.clone()).await;

        let pending = {
            let state = app.state::<AppState>();
            state.compile_pending.load(Ordering::SeqCst)
        };

        if !pending {
            break;
        }

        match active_project_path_opt(&app) {
            Some(active) => current_project = active,
            None => break,
        }
    }

    let should_reschedule = {
        let state = app.state::<AppState>();
        state.compiling.store(false, Ordering::SeqCst);
        state.compile_pending.swap(false, Ordering::SeqCst)
    };

    if should_reschedule {
        if let Some(active) = active_project_path_opt(&app) {
            schedule_compile(app, active);
        }
    }
}

async fn compile_project(app: AppHandle, project_path: PathBuf) {
    let project_path_string = path_to_string(project_path.clone());
    let _ = app.emit(
        "compile-started",
        CompileStartedPayload {
            project_path: project_path_string,
            timestamp: timestamp_ms(),
        },
    );

    if let Err(error) = fs::create_dir_all(project_path.join("build")) {
        emit_compile_failure(
            &app,
            format!("Could not create build directory: {error}"),
            Vec::new(),
        );
        return;
    }

    let app_for_process = app.clone();
    let project_for_process = project_path.clone();

    let run_result = tauri::async_runtime::spawn_blocking(move || {
        run_latexmk_blocking(app_for_process, project_for_process)
    })
    .await;

    let run = match run_result {
        Ok(Ok(run)) => run,
        Ok(Err(error)) => {
            emit_compile_failure(&app, error, Vec::new());
            return;
        }
        Err(error) => {
            emit_compile_failure(&app, format!("latexmk task failed: {error}"), Vec::new());
            return;
        }
    };

    let log_text = run.log.join("\n");
    let errors = parse_latex_log(&log_text);
    let pdf_path = project_path.join("build").join("main.pdf");
    let pdf_exists = pdf_path.is_file();
    let has_latex_error = errors.iter().any(|issue| issue.kind == "error");
    let success = run.success && pdf_exists && !has_latex_error;
    let message = if success {
        None
    } else {
        run.message
            .or_else(|| Some("latexmk failed. See the compiler log for details.".to_string()))
    };

    let payload = CompileDonePayload {
        success,
        pdf_path: if success {
            Some(path_to_string(pdf_path))
        } else {
            None
        },
        errors,
        log: tail_lines(&run.log, 220),
        exit_code: run.exit_code,
        message,
    };

    let _ = app.emit("compile-done", payload);
}

fn run_latexmk_blocking(app: AppHandle, project_path: PathBuf) -> Result<LatexmkRun, String> {
    let run = run_latexmk_once(app.clone(), &project_path, false)?;
    if !should_force_latexmk_rerun(&run) {
        return Ok(run);
    }

    let retry_notice =
        "VibeLaTeX: latexmk reported a previous failed invocation; retrying once with -g."
            .to_string();
    let _ = app.emit(
        "compile-log",
        CompileLogPayload {
            line: retry_notice.clone(),
        },
    );

    let retry = run_latexmk_once(app, &project_path, true)?;
    let mut log = run.log;
    log.push(retry_notice);
    log.extend(retry.log);

    Ok(LatexmkRun {
        exit_code: retry.exit_code,
        success: retry.success,
        log,
        message: retry.message,
    })
}

fn run_latexmk_once(
    app: AppHandle,
    project_path: &Path,
    force: bool,
) -> Result<LatexmkRun, String> {
    let mut command = Command::new("latexmk");
    command.current_dir(project_path);
    if force {
        command.arg("-g");
    }

    let mut child = command
        .args([
            "-pdf",
            "-outdir=build",
            "-interaction=nonstopmode",
            "main.tex",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "latexmk was not found. Install a TeX distribution with latexmk.".to_string()
            } else {
                format!("Could not start latexmk: {error}")
            }
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture latexmk stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture latexmk stderr.".to_string())?;

    let (tx, rx) = mpsc::channel::<String>();
    let stdout_thread = spawn_log_reader(stdout, tx.clone());
    let stderr_thread = spawn_log_reader(stderr, tx);
    let mut log = Vec::new();

    let status = loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                let _ = app.emit("compile-log", CompileLogPayload { line: line.clone() });
                log.push(line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|error| format!("Could not wait for latexmk: {error}"))?
                {
                    break status;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break child
                    .wait()
                    .map_err(|error| format!("Could not wait for latexmk: {error}"))?;
            }
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    while let Ok(line) = rx.try_recv() {
        let _ = app.emit("compile-log", CompileLogPayload { line: line.clone() });
        log.push(line);
    }

    let exit_code = status.code();
    let success = status.success();
    let message = if success {
        None
    } else {
        Some(format!("latexmk exited with code {exit_code:?}."))
    };

    Ok(LatexmkRun {
        exit_code,
        success,
        log,
        message,
    })
}

fn should_force_latexmk_rerun(run: &LatexmkRun) -> bool {
    !run.success
        && run.log.iter().any(|line| {
            line.to_ascii_lowercase()
                .contains("gave an error in previous invocation of latexmk")
        })
}

fn spawn_log_reader<R>(reader: R, tx: mpsc::Sender<String>) -> thread::JoinHandle<()>
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => {
                    let _ = tx.send(line);
                }
                Err(error) => {
                    let _ = tx.send(format!("Could not read latexmk output: {error}"));
                    break;
                }
            }
        }
    })
}

fn emit_compile_failure(app: &AppHandle, message: String, log: Vec<String>) {
    let payload = CompileDonePayload {
        success: false,
        pdf_path: None,
        errors: vec![LatexIssue {
            kind: "error".to_string(),
            message: message.clone(),
            line: None,
        }],
        log,
        exit_code: None,
        message: Some(message),
    };
    let _ = app.emit("compile-done", payload);
}

fn parse_latex_log(log_text: &str) -> Vec<LatexIssue> {
    let lines: Vec<&str> = log_text.lines().collect();
    let mut issues = Vec::new();
    let mut seen = HashSet::new();

    for index in 0..lines.len() {
        let message = lines[index].trim();
        if message.is_empty() {
            continue;
        }

        let is_error = message.starts_with("! ");
        let is_warning = !is_error && message.to_ascii_lowercase().contains("warning");

        if !is_error && !is_warning {
            continue;
        }

        let kind = if is_error { "error" } else { "warning" };
        let line = find_nearby_line_number(&lines, index);
        let key = format!("{kind}:{}:{message}", line.unwrap_or_default());

        if seen.insert(key) {
            issues.push(LatexIssue {
                kind: kind.to_string(),
                message: message.to_string(),
                line,
            });
        }
    }

    issues
}

fn find_nearby_line_number(lines: &[&str], start: usize) -> Option<usize> {
    let end = usize::min(start + 6, lines.len());

    for line in &lines[start..end] {
        if let Some(value) = parse_after_marker(line, "l.") {
            return Some(value);
        }

        let lower = line.to_ascii_lowercase();
        if let Some(position) = lower.find("input line ") {
            if let Some(value) = parse_digits_at(&lower[position + "input line ".len()..]) {
                return Some(value);
            }
        }

        if let Some(position) = lower.find("line ") {
            if let Some(value) = parse_digits_at(&lower[position + "line ".len()..]) {
                return Some(value);
            }
        }
    }

    None
}

fn parse_after_marker(line: &str, marker: &str) -> Option<usize> {
    let position = line.find(marker)?;
    parse_digits_at(&line[position + marker.len()..])
}

fn parse_digits_at(input: &str) -> Option<usize> {
    let digits: String = input
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

fn active_project_path(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    state
        .active_project
        .lock()
        .map_err(|_| "Project state is poisoned.".to_string())?
        .clone()
        .ok_or_else(|| "Open a project folder first.".to_string())
}

fn active_project_path_opt(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<AppState>();
    state
        .active_project
        .lock()
        .ok()
        .and_then(|path| path.clone())
}

fn existing_pdf_path(project_path: &Path) -> Option<PathBuf> {
    let pdf_path = project_path.join("build").join("main.pdf");
    pdf_path.is_file().then_some(pdf_path)
}

fn default_pdf_file_name(project_path: &Path) -> String {
    let stem = project_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("main");

    format!("{stem}.pdf")
}

fn last_project_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not resolve app config directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    Ok(dir.join("last_project.txt"))
}

fn save_last_project(app: &AppHandle, project_path: &Path) -> Result<(), String> {
    let file = last_project_file(app)?;
    fs::write(&file, path_to_string(project_path))
        .map_err(|error| format!("Could not save last project: {error}"))
}

fn read_last_project(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let file = last_project_file(app)?;
    match fs::read_to_string(&file) {
        Ok(content) => {
            let trimmed = content.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(PathBuf::from(trimmed)))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read last project: {error}")),
    }
}

fn path_to_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().to_string()
}

fn expand_user_path(input: &str) -> Result<PathBuf, String> {
    if input.is_empty() {
        return Err("Project path is required.".to_string());
    }

    if input == "~" {
        return env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Could not resolve HOME for ~.".to_string());
    }

    if let Some(rest) = input.strip_prefix("~/") {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Could not resolve HOME for ~/ path.".to_string())?;
        return Ok(home.join(rest));
    }

    Ok(PathBuf::from(input))
}

fn tail_lines(lines: &[String], max_lines: usize) -> Vec<String> {
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].to_vec()
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

const DEFAULT_MAIN_TEX: &str = r#"\documentclass{article}

\usepackage{amsmath}
\usepackage[hidelinks]{hyperref}

\title{New VibeLaTeX Project}
\author{Your Name}
\date{\today}

\begin{document}

\maketitle

\section{Introduction}

Start writing here. Equation~\ref{eq:sample} and Knuth~\cite{knuth1984texbook}
show that references and bibliography are handled by \texttt{latexmk}.

\begin{equation}
  \label{eq:sample}
  a^2 + b^2 = c^2
\end{equation}

\bibliographystyle{plain}
\bibliography{references}

\end{document}
"#;

const DEFAULT_REFERENCES_BIB: &str = r#"@book{knuth1984texbook,
  author    = {Donald E. Knuth},
  title     = {The TeXbook},
  year      = {1984},
  publisher = {Addison-Wesley}
}
"#;
