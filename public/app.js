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

const socket = io();
const themeCompartment = new Compartment();
const SAVE_DELAY_MS = 1000;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.25;

const els = {
  body: document.body,
  projectSelect: document.getElementById('projectSelect'),
  compileButton: document.getElementById('compileButton'),
  status: document.getElementById('status'),
  themeToggle: document.getElementById('themeToggle'),
  editor: document.getElementById('editor'),
  consoleOutput: document.getElementById('consoleOutput'),
  clearConsole: document.getElementById('clearConsole'),
  pdfCanvas: document.getElementById('pdfCanvas'),
  previewBody: document.getElementById('previewBody'),
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
let saveTimer = null;
let isLoadingDocument = false;
let activeProject = null;
let pdfDocument = null;
let currentPdfUrl = null;
let pageNumber = 1;
let zoom = 1;
let renderToken = 0;
let latestIssues = [];

init();

async function init() {
  applyStoredTheme();
  configureVimCommands();
  createEditor('');
  bindUiEvents();
  bindSocketEvents();
  renderConsole([], [], 'Ready.');
  await loadProjects();
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
                saveNow();
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
  els.projectSelect.addEventListener('change', () => {
    if (els.projectSelect.value) {
      openProject(els.projectSelect.value);
    }
  });

  els.compileButton.addEventListener('click', async () => {
    await saveAndCompile();
  });

  els.themeToggle.addEventListener('click', () => {
    const nextTheme = isDarkTheme() ? 'light' : 'dark';
    localStorage.setItem('vibelatex.theme', nextTheme);
    setTheme(nextTheme);
  });

  els.clearConsole.addEventListener('click', () => {
    renderConsole([], [], 'Console cleared.');
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

function bindSocketEvents() {
  socket.on('compile:start', (payload) => {
    if (payload.project && payload.project !== activeProject) return;
    setBusy(true);
    setStatus('Compiling...', 'busy');
  });

  socket.on('compile:done', async (payload) => {
    if (payload.project && payload.project !== activeProject) return;
    setBusy(false);
    latestIssues = Array.isArray(payload.errors) ? payload.errors : [];
    setStatus(latestIssues.length ? 'Compiled with warnings' : 'Compiled', latestIssues.length ? 'busy' : '');
    renderConsole(latestIssues, payload.log || []);
    updateEditorDiagnostics();
    await loadPdf(payload.pdfUrl);
  });

  socket.on('compile:error', (payload) => {
    if (payload.project && payload.project !== activeProject) return;
    setBusy(false);
    latestIssues = Array.isArray(payload.errors) ? payload.errors : [];
    setStatus('Compile failed', 'error');
    renderConsole(latestIssues, payload.log || []);
    updateEditorDiagnostics();
  });
}

async function loadProjects() {
  try {
    const data = await requestJson('/api/project');
    const projects = data.projects || [];
    els.projectSelect.innerHTML = '';

    for (const project of projects) {
      const option = document.createElement('option');
      option.value = project.path;
      option.textContent = project.name;
      els.projectSelect.append(option);
    }

    const firstProject = data.activeProject || (projects[0] && projects[0].path);
    const hasProjects = Boolean(firstProject);
    els.projectSelect.disabled = !hasProjects;
    els.compileButton.disabled = !hasProjects;

    if (hasProjects) {
      els.projectSelect.value = firstProject;
      await openProject(firstProject);
    } else {
      setStatus('No projects in workspace', 'error');
      setEditorContent('');
    }
  } catch (error) {
    setStatus(error.message, 'error');
    renderConsole([{ type: 'error', message: error.message, line: null }], []);
  }
}

async function openProject(projectPath) {
  try {
    clearTimeout(saveTimer);
    setStatus('Opening...', 'busy');
    const data = await requestJson('/api/open', {
      method: 'POST',
      body: JSON.stringify({ projectPath }),
    });

    activeProject = data.project;
    els.projectSelect.value = projectPath;
    setEditorContent(data.content || '');
    latestIssues = [];
    updateEditorDiagnostics();
    renderConsole([], [], `Opened ${activeProject}.`);

    if (data.pdfUrl) {
      await loadPdf(data.pdfUrl);
    } else {
      clearPdf('PDF will appear after the first successful compile.');
    }

    setStatus('Opened');
  } catch (error) {
    setStatus(error.message, 'error');
    renderConsole([{ type: 'error', message: error.message, line: null }], []);
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
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  setStatus('Unsaved changes');
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!activeProject) return false;

  try {
    setStatus('Saving...', 'busy');
    await requestJson('/api/save', {
      method: 'POST',
      body: JSON.stringify({ content: editorView.state.doc.toString() }),
    });
    setStatus('Saved');
    return true;
  } catch (error) {
    setStatus(error.message, 'error');
    renderConsole([{ type: 'error', message: error.message, line: null }], []);
    return false;
  }
}

async function saveAndCompile() {
  const saved = await saveNow();
  if (!activeProject || !saved) return;

  try {
    await requestJson('/api/compile', { method: 'POST' });
  } catch (error) {
    setStatus(error.message, 'error');
    renderConsole([{ type: 'error', message: error.message, line: null }], []);
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed with ${response.status}`);
  }
  return data;
}

async function loadPdf(url) {
  if (!url) {
    clearPdf('No PDF available.');
    return;
  }

  const token = ++renderToken;
  currentPdfUrl = url;
  setBusy(true);

  try {
    const loadingTask = pdfjsLib.getDocument(url);
    const doc = await loadingTask.promise;
    if (token !== renderToken || currentPdfUrl !== url) return;

    pdfDocument = doc;
    pageNumber = Math.min(pageNumber, pdfDocument.numPages || 1);
    if (pageNumber < 1) pageNumber = 1;
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
  currentPdfUrl = null;
  renderToken += 1;
  els.pdfCanvas.style.display = 'none';
  els.previewEmpty.textContent = message;
  els.previewEmpty.style.display = 'block';
  updatePdfControls();
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

    const meta = document.createElement('span');
    meta.className = `issue-type ${issue.type || 'warning'}`;
    meta.textContent = issue.type === 'error' ? 'error' : 'warning';

    const message = document.createElement('span');
    message.className = 'issue-message';
    const lineText = issue.line ? `line ${issue.line}: ` : '';
    message.textContent = `${lineText}${issue.message}`;

    row.append(meta, message);
    els.consoleOutput.append(row);
  }

  if (logLines.length) {
    const spacer = document.createElement('div');
    spacer.className = 'log-line';
    spacer.textContent = issues.length ? '\nlatexmk log:' : 'latexmk log:';
    els.consoleOutput.append(spacer);

    for (const line of logLines.slice(-140)) {
      const logLine = document.createElement('div');
      logLine.className = 'log-line';
      logLine.textContent = line;
      els.consoleOutput.append(logLine);
    }
  }
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
          severity: issue.type === 'error' ? 'error' : 'warning',
          message: issue.message,
        };
      });
  });
}

function updateEditorDiagnostics() {
  if (!editorView) return;
  forceLinting(editorView);
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
        backgroundColor: dark ? 'rgba(127, 197, 110, 0.24)' : 'rgba(38, 125, 74, 0.2)',
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
