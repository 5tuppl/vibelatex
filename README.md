# VibeLaTeX

VibeLaTeX now contains two apps:

- `vibelatex/` root: web app using Node.js, Express, Socket.IO, and Chokidar.
- `vibelatex/vibelatex-desktop/`: desktop app using Tauri v2 and Rust.

Both use CodeMirror 6, PDF.js, and `latexmk`.

## Requirements

- Node.js 18 or newer
- Rust and Tauri CLI v2 for the desktop app
- A TeX distribution with `latexmk`
- `bibtex` or `biber` if your project uses bibliography tooling
- Browser internet access for CDN-loaded CodeMirror 6 and PDF.js assets

On Debian or Ubuntu, a typical TeX setup is:

```bash
sudo apt install texlive latexmk texlive-latex-extra
```

## Run Web App

```bash
cd ~/vibelatex
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Run Desktop App

```bash
cd ~/vibelatex/vibelatex-desktop
cargo tauri dev
```

Build the desktop app:

```bash
cd ~/vibelatex/vibelatex-desktop
cargo tauri build
```

## Project Layout

```text
vibelatex/
├── server.js
├── package.json
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── lib/
├── vibelatex-desktop/
│   ├── src/
│   │   ├── index.html
│   │   ├── styles.css
│   │   └── main.js
│   └── src-tauri/
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       └── src/
│           ├── main.rs
│           ├── commands.rs
│           └── watcher.rs
├── workspace/
│   └── demo/
│       ├── main.tex
│       └── references.bib
└── .gitignore
```

For the web app, each project is a subfolder of `workspace/` and should contain
`main.tex`. Generated files are written to `workspace/<project>/build/`.

For the desktop app, open or initialize any folder on disk that contains
`main.tex`. Generated files are written to that folder's `build/` directory.

## Web App Internals

- `POST /api/open` selects an active project and starts a Chokidar watcher.
- `POST /api/save` writes the current editor buffer to `main.tex`.
- Saves and watched file changes trigger:

```bash
latexmk -pdf -interaction=nonstopmode -outdir=build main.tex
```

- Socket.IO events report compiler status:
  - `compile:start`
  - `compile:done`
  - `compile:error`

The compiler log parser extracts LaTeX errors and warnings, including nearby
line numbers when LaTeX prints `l.<number>` or `on input line <number>`.

## Desktop App Features

- Native project folder picker.
- Vibe CLI for `init`, `open`, `save`, `compile`, `download`, `clear`, and `status`.
- Download PDF button after successful compilation.
- Last opened folder restore.

## Vim Mode

The editor runs CodeMirror's Vim keybinding extension by default.

- Normal, insert, and visual mode navigation are available.
- `jk` or `jj` exits insert mode.
- `Y` yanks to the end of the current line.
- `:w` saves the current document.
- `:make` or `:compile` saves and runs `latexmk`.
- Ctrl/Cmd+S still saves from any mode.
