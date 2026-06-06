import { closeBrackets, closeBracketsKeymap, completionKeymap } from 'https://esm.sh/@codemirror/autocomplete@6.18.6?deps=@codemirror/state@6.4.1,@codemirror/view@6.28.6';
import { defaultKeymap, history, historyKeymap, indentWithTab } from 'https://esm.sh/@codemirror/commands@6.6.0?deps=@codemirror/state@6.4.1,@codemirror/view@6.28.6';
import { bracketMatching, defaultHighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from 'https://esm.sh/@codemirror/language@6.10.2?deps=@codemirror/state@6.4.1,@codemirror/view@6.28.6';
import { forceLinting, linter, lintGutter, lintKeymap } from 'https://esm.sh/@codemirror/lint@6.8.1?deps=@codemirror/state@6.4.1,@codemirror/view@6.28.6';
import { stex } from 'https://esm.sh/@codemirror/legacy-modes@6.4.0/mode/stex?deps=@codemirror/state@6.4.1,@codemirror/language@6.10.2';
import { searchKeymap, highlightSelectionMatches } from 'https://esm.sh/@codemirror/search@6.5.6?deps=@codemirror/state@6.4.1,@codemirror/view@6.28.6';
import { Compartment, EditorState, Prec } from 'https://esm.sh/@codemirror/state@6.4.1';
import { vim, Vim } from 'https://esm.sh/@replit/codemirror-vim@6.3.0?deps=@codemirror/commands@6.6.0,@codemirror/language@6.10.2,@codemirror/search@6.5.6,@codemirror/state@6.4.1,@codemirror/view@6.28.6';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from 'https://esm.sh/@codemirror/view@6.28.6?deps=@codemirror/state@6.4.1';
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';

const tauriApi = window.__TAURI__ || {};
const invoke = tauriApi.core?.invoke || tauriApi.tauri?.invoke;
const listen = tauriApi.event?.listen;
const convertFileSrc = tauriApi.core?.convertFileSrc || tauriApi.tauri?.convertFileSrc;
const openDialog = tauriApi.dialog?.open;
const saveDialog = tauriApi.dialog?.save;

const SAVE_DELAY_MS = 1000;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.25;
const themeCompartment = new Compartment();

const els = {
  body: document.body,
  openProject: document.getElementById('openProject'),
  saveFile: document.getElementById('saveFile'),
  compileFile: document.getElementById('compileFile'),
  downloadPdf: document.getElementById('downloadPdf'),
  themeToggle: document.getElementById('themeToggle'),
  status: document.getElementById('status'),
  projectPath: document.getElementById('projectPath'),
  editor: document.getElementById('editor'),
  cliForm: document.getElementById('cliForm'),
  cliInput: document.getElementById('cliInput'),
  consoleOutput: document.getElementById('consoleOutput'),
  clearConsole: document.getElementById('clearConsole'),
  pdfCanvas: document.getElementById('pdfCanvas'),
  previewEmpty: document.getElementById('previewEmpty'),
  previewBusy: document.getElementById('previewBusy'),
  prevPage: document.getElementById('prevPage'),
  nextPage: document.getElementById('nextPage'),
  pageInfo: document.getElementById('pageInfo'),
  zoomOut: document.getElementById('zoomOut'),
  zoomIn: document.getElementById('zoomIn'),
  zoomInfo: document.getElementById('zoomInfo'),
};

let editorView;
let activeProjectPath = null;
let saveTimer = null;
let isLoadingDocument = false;
let latestIssues = [];
let pdfDocument = null;
let pageNumber = 1;
let zoom = 1;
let renderToken = 0;
let latestPdfPath = null;
let lastCompileLog = [];
let cliHistory = [];
let cliHistoryIndex = 0;

init().catch((error) => {
  setStatus(error.message, 'error');
  renderConsole([{ kind: 'error', message: error.message, line: null }], []);
});

async function init() {
  if (!invoke || !listen || !convertFileSrc || !openDialog || !saveDialog) {
    throw new Error('Tauri APIs are unavailable. Run this app with cargo tauri dev.');
  }

  applyStoredTheme();
  configureVimCommands();
  createEditor('');
  bindUiEvents();
  await bindTauriEvents();

  renderConsole([], [], 'Ready.');
  const initialState = await invoke('get_initial_state');
  handleLatexmkStatus(initialState.latexmk);

  if (initialState.project) {
    loadProject(initialState.project);
  } else {
    setStatus('Open a folder containing main.tex');
    setTimeout(() => {
      void chooseProject();
    }, 350);
  }
}

function createEditor(content) {
  editorView = new EditorView({
    parent: els.editor,
    state: EditorState.create({
      doc: content,
      extensions: [
        vim(),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        lintGutter(),
        StreamLanguage.define(stex),
        latexIssueLinter(),
        EditorView.lineWrapping,
        themeCompartment.of(editorTheme(isDarkTheme())),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isLoadingDocument) {
            scheduleSave();
          }
        }),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                void saveNow();
                return true;
              },
            },
          ])
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),
      ],
    }),
  });
}

function configureVimCommands() {
  Vim.map('jk', '<Esc>', 'insert');
  Vim.map('jj', '<Esc>', 'insert');
  Vim.map('Y', 'y$');
  Vim.defineEx('write', 'w', () => {
    void saveNow();
  });
  Vim.defineEx('make', 'make', () => {
    void saveAndCompile();
  });
  Vim.defineEx('compile', 'compile', () => {
    void saveAndCompile();
  });
}

function bindUiEvents() {
  els.openProject.addEventListener('click', () => {
    void chooseProject();
  });

  els.saveFile.addEventListener('click', () => {
    void saveNow();
  });

  els.compileFile.addEventListener('click', async () => {
    await saveAndCompile();
  });

  els.downloadPdf.addEventListener('click', async () => {
    await downloadPdf();
  });

  els.themeToggle.addEventListener('click', () => {
    const nextTheme = isDarkTheme() ? 'light' : 'dark';
    localStorage.setItem('vibelatex.theme', nextTheme);
    setTheme(nextTheme);
  });

  els.clearConsole.addEventListener('click', () => {
    lastCompileLog = [];
    renderConsole([], [], 'Console cleared.');
  });

  els.cliForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void runCliCommand(els.cliInput.value);
  });

  els.cliInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (cliHistory.length) {
        cliHistoryIndex = Math.max(0, cliHistoryIndex - 1);
        els.cliInput.value = cliHistory[cliHistoryIndex] || '';
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (cliHistory.length) {
        cliHistoryIndex = Math.min(cliHistory.length, cliHistoryIndex + 1);
        els.cliInput.value = cliHistory[cliHistoryIndex] || '';
      }
    }
  });

  els.prevPage.addEventListener('click', () => {
    if (pageNumber > 1) {
      pageNumber -= 1;
      renderPage();
    }
  });

  els.nextPage.addEventListener('click', () => {
    if (pdfDocument && pageNumber < pdfDocument.numPages) {
      pageNumber += 1;
      renderPage();
    }
  });

  els.zoomOut.addEventListener('click', () => {
    zoom = Math.max(MIN_ZOOM, Number((zoom - 0.1).toFixed(2)));
    renderPage();
  });

  els.zoomIn.addEventListener('click', () => {
    zoom = Math.min(MAX_ZOOM, Number((zoom + 0.1).toFixed(2)));
    renderPage();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pdfDocument) renderPage();
    }, 120);
  });
}

async function bindTauriEvents() {
  await listen('compile-started', () => {
    lastCompileLog = [];
    setBusy(true);
    setStatus('Compiling...', 'busy');
    renderConsole([], [], 'Compiling...');
  });

  await listen('compile-log', (event) => {
    const line = event.payload?.line;
    if (!line) return;
    lastCompileLog.push(line);
    appendLogLine(line);
  });

  await listen('compile-done', async (event) => {
    const payload = event.payload || {};
    setBusy(false);
    latestIssues = Array.isArray(payload.errors) ? payload.errors : [];
    updateEditorDiagnostics();

    renderConsole(latestIssues, payload.log || lastCompileLog);

    if (payload.success && payload.pdf_path) {
      setStatus(latestIssues.length ? 'Compiled with warnings' : 'Compiled', latestIssues.length ? 'busy' : '');
      await loadPdf(payload.pdf_path);
    } else {
      setStatus(payload.message || 'Compile failed', 'error');
    }
  });
}

function handleLatexmkStatus(status) {
  if (!status?.available) {
    renderConsole([{ kind: 'error', message: status?.message || 'latexmk was not found.', line: null }], []);
    setStatus('latexmk missing', 'error');
  }
}

async function chooseProject() {
  try {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: 'Open LaTeX Project',
    });

    const selectedPath = Array.isArray(selected) ? selected[0] : selected;
    if (!selectedPath) return;

    const project = await invoke('open_project', { path: selectedPath });
    loadProject(project);
  } catch (error) {
    setStatus(String(error), 'error');
    renderConsole([{ kind: 'error', message: String(error), line: null }], []);
  }
}

async function chooseProjectForInit() {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: 'Initialize LaTeX Project',
  });

  return Array.isArray(selected) ? selected[0] : selected;
}

async function runCliCommand(rawCommand) {
  const commandText = rawCommand.trim();
  if (!commandText) return;

  cliHistory.push(commandText);
  cliHistoryIndex = cliHistory.length;
  els.cliInput.value = '';
  appendCliLine(`vibe> ${commandText}`);

  const args = splitCliArgs(commandText);
  const command = (args.shift() || '').toLowerCase();

  try {
    switch (command) {
      case 'help':
      case '?':
        appendCliResult('Commands: init [path], open [path], save, compile, download [path], clear, status, help.');
        appendCliResult('init without a path opens a folder picker. Existing main.tex is never overwritten.');
        break;

      case 'init':
      case 'new': {
        const selectedPath = args.length ? args.join(' ') : await chooseProjectForInit();
        if (!selectedPath) {
          appendCliResult('Initialization cancelled.');
          break;
        }
        const project = await invoke('init_project', { path: selectedPath });
        loadProject(project);
        appendCliResult(`Initialized ${project.project_path}`);
        break;
      }

      case 'open': {
        if (!args.length) {
          await chooseProject();
          appendCliResult('Open project dialog closed.');
          break;
        }
        const project = await invoke('open_project', { path: args.join(' ') });
        loadProject(project);
        appendCliResult(`Opened ${project.project_path}`);
        break;
      }

      case 'save':
      case 'w':
        if (await saveNow()) {
          appendCliResult('Saved.');
        }
        break;

      case 'compile':
      case 'make':
        if (await saveAndCompile()) {
          appendCliResult('Compile requested.');
        }
        break;

      case 'download':
      case 'export': {
        const destination = args.length ? args.join(' ') : null;
        const exported = await downloadPdf(destination);
        if (exported) {
          appendCliResult(`Saved PDF to ${exported}`);
        }
        break;
      }

      case 'clear':
      case 'cls':
        lastCompileLog = [];
        renderConsole([], [], 'Console cleared.');
        break;

      case 'status':
        appendCliResult(activeProjectPath ? `Active project: ${activeProjectPath}` : 'No project open.');
        break;

      default:
        appendCliError(`Unknown command: ${command}. Type help.`);
        break;
    }
  } catch (error) {
    setStatus(String(error), 'error');
    appendCliError(String(error));
  }
}

function splitCliArgs(input) {
  const args = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (quote && character === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (current) args.push(current);
  return args;
}

function loadProject(project) {
  activeProjectPath = project.project_path;
  els.projectPath.textContent = activeProjectPath;
  setEditorContent(project.content || '');
  latestIssues = [];
  updateEditorDiagnostics();
  renderConsole([], [], `Opened ${project.project_name}.`);
  setStatus('Opened');

  if (project.pdf_path) {
    void loadPdf(project.pdf_path);
  } else {
    clearPdf('PDF will appear after the first successful compile.');
  }
}

function setEditorContent(content) {
  isLoadingDocument = true;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: content },
    selection: { anchor: 0 },
  });
  isLoadingDocument = false;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveNow();
  }, SAVE_DELAY_MS);
  setStatus('Unsaved changes');
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!activeProjectPath) {
    setStatus('Open a project first', 'error');
    return false;
  }

  try {
    setStatus('Saving...', 'busy');
    await invoke('save_file', { content: editorView.state.doc.toString() });
    setStatus('Saved');
    return true;
  } catch (error) {
    setStatus(String(error), 'error');
    renderConsole([{ kind: 'error', message: String(error), line: null }], []);
    return false;
  }
}

async function saveAndCompile() {
  const saved = await saveNow();
  if (!saved) return false;

  try {
    await invoke('compile');
    return true;
  } catch (error) {
    setStatus(String(error), 'error');
    renderConsole([{ kind: 'error', message: String(error), line: null }], []);
    return false;
  }
}

async function downloadPdf(destinationPath = null) {
  if (!latestPdfPath) {
    setStatus('Compile a PDF first', 'error');
    appendCliError('No compiled PDF available. Run compile first.');
    return null;
  }

  try {
    const destination =
      destinationPath ||
      (await saveDialog({
        title: 'Download PDF',
        defaultPath: suggestedPdfFileName(),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      }));

    if (!destination) return null;

    const exportedPath = await invoke('export_pdf', {
      destination: ensurePdfExtension(destination),
    });

    setStatus('PDF downloaded');
    return exportedPath;
  } catch (error) {
    setStatus(String(error), 'error');
    appendCliError(String(error));
    return null;
  }
}

async function loadPdf(pdfPath) {
  const token = ++renderToken;
  const pdfUrl = `${convertFileSrc(pdfPath)}?t=${Date.now()}`;
  setBusy(true);

  try {
    const loadingTask = pdfjsLib.getDocument({ url: pdfUrl });
    const doc = await loadingTask.promise;
    if (token !== renderToken) return;

    pdfDocument = doc;
    latestPdfPath = pdfPath;
    updateDownloadButton();
    pageNumber = Math.min(Math.max(pageNumber, 1), pdfDocument.numPages || 1);
    await renderPage(token);
    els.previewEmpty.style.display = 'none';
    els.pdfCanvas.style.display = 'block';
  } catch (error) {
    clearPdf(`Unable to render PDF: ${error.message}`);
  } finally {
    if (token === renderToken) {
      setBusy(false);
    }
  }
}

async function renderPage(existingToken = ++renderToken) {
  if (!pdfDocument) {
    updatePdfControls();
    return;
  }

  const token = existingToken;
  const page = await pdfDocument.getPage(pageNumber);
  if (token !== renderToken) return;

  const viewport = page.getViewport({ scale: zoom });
  const outputScale = window.devicePixelRatio || 1;
  const canvas = els.pdfCanvas;
  const context = canvas.getContext('2d', { alpha: false });

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
  await page.render({ canvasContext: context, viewport }).promise;
  updatePdfControls();
}

function clearPdf(message) {
  pdfDocument = null;
  latestPdfPath = null;
  renderToken += 1;
  els.pdfCanvas.style.display = 'none';
  els.previewEmpty.textContent = message;
  els.previewEmpty.style.display = 'block';
  updatePdfControls();
  updateDownloadButton();
}

function updatePdfControls() {
  const pageCount = pdfDocument ? pdfDocument.numPages : 0;
  els.pageInfo.textContent = `${pageCount ? pageNumber : 0} / ${pageCount}`;
  els.zoomInfo.textContent = `${Math.round(zoom * 100)}%`;
  els.prevPage.disabled = !pdfDocument || pageNumber <= 1;
  els.nextPage.disabled = !pdfDocument || pageNumber >= pageCount;
  els.zoomOut.disabled = !pdfDocument || zoom <= MIN_ZOOM;
  els.zoomIn.disabled = !pdfDocument || zoom >= MAX_ZOOM;
}

function updateDownloadButton() {
  els.downloadPdf.disabled = !latestPdfPath;
}

function renderConsole(issues, logLines, emptyMessage = 'No errors or warnings.') {
  els.consoleOutput.replaceChildren();

  if (!issues.length && !logLines.length) {
    const empty = document.createElement('div');
    empty.className = 'console-empty';
    empty.textContent = emptyMessage;
    els.consoleOutput.append(empty);
    return;
  }

  for (const issue of issues) {
    const row = document.createElement(issue.line ? 'button' : 'div');
    row.className = `issue ${issue.line ? 'has-line' : ''}`;
    if (issue.line) {
      row.type = 'button';
      row.addEventListener('click', () => jumpToLine(issue.line));
    }

    const kind = document.createElement('span');
    kind.className = `issue-kind ${issue.kind || 'warning'}`;
    kind.textContent = issue.kind === 'error' ? 'error' : 'warning';

    const message = document.createElement('span');
    message.className = 'issue-message';
    message.textContent = `${issue.line ? `line ${issue.line}: ` : ''}${issue.message}`;

    row.append(kind, message);
    els.consoleOutput.append(row);
  }

  if (logLines.length) {
    const heading = document.createElement('div');
    heading.className = 'log-line';
    heading.textContent = issues.length ? '\nlatexmk log:' : 'latexmk log:';
    els.consoleOutput.append(heading);

    for (const line of logLines.slice(-160)) {
      appendLogLine(line);
    }
  }
}

function appendLogLine(line) {
  const logLine = document.createElement('div');
  logLine.className = 'log-line';
  logLine.textContent = line;
  els.consoleOutput.append(logLine);
  els.consoleOutput.scrollTop = els.consoleOutput.scrollHeight;
}

function appendCliLine(line) {
  appendConsoleLine(line, 'cli-line');
}

function appendCliResult(line) {
  appendConsoleLine(line, 'cli-result');
}

function appendCliError(line) {
  appendConsoleLine(line, 'cli-error');
}

function appendConsoleLine(line, className) {
  const item = document.createElement('div');
  item.className = className;
  item.textContent = line;
  els.consoleOutput.append(item);
  els.consoleOutput.scrollTop = els.consoleOutput.scrollHeight;
}

function suggestedPdfFileName() {
  const projectName = activeProjectPath
    ? activeProjectPath.split(/[\\/]/).filter(Boolean).pop()
    : 'main';
  return `${projectName || 'main'}.pdf`;
}

function ensurePdfExtension(path) {
  return /\.pdf$/i.test(path) ? path : `${path}.pdf`;
}

function jumpToLine(lineNumber) {
  const doc = editorView.state.doc;
  const safeLine = Math.max(1, Math.min(Number(lineNumber), doc.lines));
  const line = doc.line(safeLine);

  editorView.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
  });
  editorView.focus();
}

function latexIssueLinter() {
  return linter((view) => {
    return latestIssues
      .filter((issue) => issue.line)
      .map((issue) => {
        const line = view.state.doc.line(Math.max(1, Math.min(issue.line, view.state.doc.lines)));
        return {
          from: line.from,
          to: Math.min(line.to, line.from + 1),
          severity: issue.kind === 'error' ? 'error' : 'warning',
          message: issue.message,
        };
      });
  });
}

function updateEditorDiagnostics() {
  if (editorView) {
    forceLinting(editorView);
  }
}

function setBusy(isBusy) {
  els.previewBusy.hidden = !isBusy;
}

function setStatus(message, tone = '') {
  els.status.textContent = message;
  els.status.className = `status ${tone}`.trim();
}

function applyStoredTheme() {
  const stored = localStorage.getItem('vibelatex.theme');
  setTheme(stored === 'light' ? 'light' : 'dark', false);
}

function setTheme(theme, reconfigureEditor = true) {
  els.body.classList.toggle('theme-light', theme === 'light');
  els.body.classList.toggle('theme-dark', theme !== 'light');
  els.themeToggle.textContent = theme === 'light' ? 'Dark' : 'Light';

  if (reconfigureEditor && editorView) {
    editorView.dispatch({
      effects: themeCompartment.reconfigure(editorTheme(theme !== 'light')),
    });
  }
}

function isDarkTheme() {
  return !els.body.classList.contains('theme-light');
}

function editorTheme(dark) {
  return EditorView.theme(
    {
      '&': {
        backgroundColor: 'var(--panel)',
        color: 'var(--text)',
      },
      '.cm-content': {
        caretColor: 'var(--accent-strong)',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--accent-strong)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: dark ? 'rgba(114, 196, 107, 0.24)' : 'rgba(36, 123, 72, 0.2)',
      },
      '.cm-panels': {
        backgroundColor: 'var(--panel-alt)',
        color: 'var(--text)',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--panel-alt)',
        color: 'var(--text)',
        borderColor: 'var(--border)',
      },
    },
    { dark }
  );
}
