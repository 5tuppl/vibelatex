const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const chokidar = require('chokidar');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_ROOT = path.join(ROOT, 'public');
const WORKSPACE_ROOT = path.join(ROOT, 'workspace');
const WATCH_EXTENSIONS = new Set(['.tex', '.bib', '.cls', '.sty']);
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let activeProject = null;
let watcher = null;
let compileTimer = null;
let compileProcess = null;
let isCompiling = false;
let compileAgain = false;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_ROOT));

app.get('/api/project', async (_req, res, next) => {
  try {
    await ensureWorkspace();
    const projects = await listProjects();
    res.json({
      projects,
      activeProject: activeProject ? activeProject.name : null,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/open', async (req, res, next) => {
  try {
    const project = await resolveProject(req.body && req.body.projectPath);
    activeProject = project;
    await startWatcher(project);

    const mainPath = path.join(project.root, 'main.tex');
    const content = await readTextIfExists(mainPath);
    const pdfPath = path.join(project.root, 'build', 'main.pdf');
    const pdfExists = await pathExists(pdfPath);

    res.json({
      project: project.name,
      content,
      pdfUrl: pdfExists ? buildPdfUrl() : null,
    });

    scheduleCompile('project opened');
  } catch (error) {
    next(error);
  }
});

app.post('/api/save', async (req, res, next) => {
  try {
    if (!activeProject) {
      throw httpError(400, 'Open a project before saving.');
    }

    const content = req.body && req.body.content;
    if (typeof content !== 'string') {
      throw httpError(400, 'Request body must include a string content field.');
    }

    await fsp.mkdir(activeProject.root, { recursive: true });
    await fsp.writeFile(path.join(activeProject.root, 'main.tex'), content, 'utf8');
    res.json({ ok: true, savedAt: Date.now() });

    scheduleCompile('file saved');
  } catch (error) {
    next(error);
  }
});

app.post('/api/compile', (_req, res, next) => {
  try {
    if (!activeProject) {
      throw httpError(400, 'Open a project before compiling.');
    }
    scheduleCompile('manual compile');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/build/:file', async (req, res, next) => {
  try {
    if (!activeProject) {
      throw httpError(404, 'No active project.');
    }

    const requestedFile = path.basename(req.params.file);
    if (requestedFile !== req.params.file || path.extname(requestedFile) !== '.pdf') {
      throw httpError(400, 'Only generated PDF files can be served.');
    }

    const pdfPath = path.join(activeProject.root, 'build', requestedFile);
    if (!(await pathExists(pdfPath))) {
      throw httpError(404, 'PDF has not been generated yet.');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(pdfPath);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status || 500);
  const message = status >= 500 ? 'Internal server error.' : error.message;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ error: message });
});

async function ensureWorkspace() {
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true });
}

async function listProjects() {
  const entries = await fsp.readdir(WORKSPACE_ROOT, { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const projectRoot = path.join(WORKSPACE_ROOT, entry.name);
        return {
          name: entry.name,
          path: entry.name,
          hasMain: await pathExists(path.join(projectRoot, 'main.tex')),
        };
      })
  );

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveProject(projectPath) {
  const requested = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!requested) {
    throw httpError(400, 'projectPath is required.');
  }

  const normalized = path.normalize(requested);
  if (normalized !== path.basename(normalized)) {
    throw httpError(400, 'Project names cannot contain path separators.');
  }

  const root = path.resolve(WORKSPACE_ROOT, normalized);
  const relative = path.relative(WORKSPACE_ROOT, root);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw httpError(400, 'Project path must stay inside workspace/.');
  }

  const stat = await fsp.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw httpError(404, `Project "${normalized}" was not found.`);
  }

  return { name: normalized, root };
}

async function startWatcher(project) {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }

  watcher = chokidar.watch(project.root, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
    ignored: (candidatePath, stats) => {
      const relative = path.relative(project.root, candidatePath);
      if (!relative || relative.startsWith('..')) return false;
      if (relative.split(path.sep).includes('build')) return true;
      if (relative.split(path.sep).includes('node_modules')) return true;
      if (stats && stats.isDirectory()) return false;
      return !WATCH_EXTENSIONS.has(path.extname(candidatePath).toLowerCase());
    },
  });

  watcher.on('all', (_event, changedPath) => {
    if (WATCH_EXTENSIONS.has(path.extname(changedPath).toLowerCase())) {
      scheduleCompile('watched file changed');
    }
  });

  watcher.on('error', (error) => {
    io.emit('compile:error', {
      errors: [{ type: 'error', message: `Watcher error: ${error.message}`, line: null }],
      log: [error.stack || error.message],
    });
  });
}

function scheduleCompile(_reason) {
  if (!activeProject) return;
  clearTimeout(compileTimer);
  compileTimer = setTimeout(() => {
    compile().catch((error) => {
      io.emit('compile:error', {
        errors: [{ type: 'error', message: error.message, line: null }],
        log: [error.stack || error.message],
      });
    });
  }, 300);
}

async function compile() {
  if (!activeProject) return;
  if (isCompiling) {
    compileAgain = true;
    return;
  }

  const project = activeProject;
  isCompiling = true;
  compileAgain = false;

  await fsp.mkdir(path.join(project.root, 'build'), { recursive: true });
  io.emit('compile:start', { project: project.name, startedAt: Date.now() });

  const args = ['-pdf', '-interaction=nonstopmode', '-outdir=build', 'main.tex'];
  const result = await runLatexmk(project, args);
  const logText = result.logText;
  const issues = parseLatexLog(logText);
  const log = tailLines(logText, 220);
  const pdfPath = path.join(project.root, 'build', 'main.pdf');
  const sameProjectIsActive = activeProject && activeProject.root === project.root;
  const hasLatexError = issues.some((issue) => issue.type === 'error');
  const hardFailure = result.exitCode !== 0 || Boolean(result.spawnError);

  isCompiling = false;
  compileProcess = null;

  if (sameProjectIsActive) {
    const pdfExists = await pathExists(pdfPath);
    if (pdfExists && !hardFailure && !hasLatexError) {
      io.emit('compile:done', {
        project: project.name,
        pdfUrl: buildPdfUrl(),
        errors: issues,
        log,
        completedAt: Date.now(),
      });
    } else {
      io.emit('compile:error', {
        project: project.name,
        errors: issues.length ? issues : [{ type: 'error', message: result.failureMessage || 'latexmk failed.', line: null }],
        log,
        completedAt: Date.now(),
      });
    }
  }

  if (compileAgain || activeProject !== project) {
    scheduleCompile('queued compile');
  }
}

function runLatexmk(project, args) {
  return new Promise((resolve) => {
    let combinedLog = '';
    let finished = false;
    let exitCode = 0;
    let spawnError = null;
    let failureMessage = '';

    function appendLog(chunk) {
      combinedLog += chunk.toString();
      if (combinedLog.length > MAX_LOG_BYTES) {
        combinedLog = combinedLog.slice(combinedLog.length - MAX_LOG_BYTES);
      }
    }

    function finish(extraText) {
      if (finished) return;
      finished = true;
      if (extraText) appendLog(extraText);
      resolve({ logText: combinedLog, exitCode, spawnError, failureMessage });
    }

    compileProcess = spawn('latexmk', args, {
      cwd: project.root,
      env: process.env,
      shell: false,
    });

    compileProcess.stdout.on('data', appendLog);
    compileProcess.stderr.on('data', appendLog);
    compileProcess.on('error', (error) => {
      spawnError = error;
      exitCode = 127;
      failureMessage = error.code === 'ENOENT'
        ? 'latexmk was not found. Install a TeX distribution with latexmk, then restart VibeLaTeX.'
        : error.message;
      finish(`\n${failureMessage}\n`);
    });
    compileProcess.on('close', (code) => {
      exitCode = code;
      if (code !== 0) {
        failureMessage = `latexmk exited with code ${code}.`;
        appendLog(`\nlatexmk exited with code ${code}.\n`);
      }
      finish();
    });
  });
}

function parseLatexLog(logText) {
  const issues = [];
  const seen = new Set();
  const lines = logText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const message = lines[i].trim();
    if (!message) continue;

    const isError = message.startsWith('! ');
    const isWarning = !isError && /\bwarning\b/i.test(message);
    if (!isError && !isWarning) continue;

    const type = isError ? 'error' : 'warning';
    const line = findNearbyLineNumber(lines, i);
    const key = `${type}:${line || ''}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    issues.push({ type, message, line });
  }

  return issues;
}

function findNearbyLineNumber(lines, index) {
  for (let i = index; i < Math.min(index + 6, lines.length); i += 1) {
    const line = lines[i];
    const direct = line.match(/\bl\.(\d+)\b/);
    if (direct) return Number(direct[1]);

    const inputLine = line.match(/\bon input line\s+(\d+)\b/i);
    if (inputLine) return Number(inputLine[1]);

    const plainLine = line.match(/\bline\s+(\d+)\b/i);
    if (plainLine) return Number(plainLine[1]);
  }
  return null;
}

function tailLines(text, maxLines) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-maxLines);
}

function buildPdfUrl() {
  return `/build/main.pdf?t=${Date.now()}`;
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function shutdown() {
  if (compileProcess) {
    compileProcess.kill('SIGTERM');
  }
  const closeWatcher = watcher ? watcher.close() : Promise.resolve();
  closeWatcher.finally(() => server.close(() => process.exit(0)));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to another value and restart.`);
  } else if (error.code === 'EPERM') {
    console.error(`Permission denied while binding to port ${PORT}.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

ensureWorkspace()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`VibeLaTeX running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
