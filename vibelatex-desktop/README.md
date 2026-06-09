# VibeLaTeX Desktop

VibeLaTeX Desktop is a minimal desktop LaTeX IDE built with Tauri v2. It uses a
Rust backend, the system webview, CodeMirror 6, PDF.js, and `latexmk`.

## Features

- Editor on the left, live PDF preview on the right, compiler console at bottom
- Native folder picker for opening projects
- In-app Vibe CLI for `init`, `open`, `save`, and `compile`
- Active project must contain `main.tex`
- Auto-save after 1 second of idle typing and Ctrl/Cmd+S
- Vim editor mode by default, including `:w`, `:make`, and `jk`/`jj`
- `notify` watches `.tex`, `.bib`, `.cls`, and `.sty` files
- `latexmk -pdf -outdir=build -interaction=nonstopmode main.tex`, with one `-g`
  retry if `latexmk` reports a previous failed invocation without rerunning TeX
- PDF refresh after successful compilation
- Download button for saving the compiled PDF anywhere on disk
- Clickable errors and warnings jump to the matching editor line
- Last opened folder is restored on startup

## Prerequisites

- Rust 1.77.2 or newer
- Tauri CLI v2
- System webview dependencies for your OS
- `latexmk` from TeX Live, MacTeX, or MiKTeX

Install the Tauri CLI if needed:

```bash
cargo install tauri-cli --version "^2"
```

On Debian or Ubuntu, a typical TeX setup is:

```bash
sudo apt install texlive latexmk texlive-latex-extra
```

## Run In Development

```bash
cd vibelatex-desktop
cargo tauri dev
```

## Build

```bash
cd vibelatex-desktop
cargo tauri build
```

## Project Format

Open any folder that contains:

```text
main.tex
```

Optional files such as `.bib`, `.cls`, and `.sty` are watched recursively.
Generated files are written to:

```text
build/
```

## Vibe CLI

The command row above the compiler output is an app CLI, not a system shell.

- `help` shows available commands.
- `init` opens a folder picker, creates `main.tex` and `references.bib` if missing, and opens the project.
- `init ~/paper` creates or reuses that folder, initializes it, and opens it.
- `open` opens the project folder picker.
- `open ~/paper` opens an existing folder that contains `main.tex`.
- `save` or `w` saves the current editor buffer.
- `compile` or `make` saves and runs `latexmk`.
- `download` opens a save dialog for the current compiled PDF.
- `download ~/paper.pdf` saves the current compiled PDF to that path.
- `clear` clears the console output.
- `status` prints the active project path.

## Vim Mode

The editor runs CodeMirror's Vim keybinding extension by default.

- Normal, insert, and visual mode navigation are available.
- `jk` or `jj` exits insert mode.
- `Y` yanks to the end of the current line.
- `:w` saves the current document.
- `:make` or `:compile` saves and runs `latexmk`.
- Ctrl/Cmd+S still saves from any mode.

## Notes

The app checks for `latexmk` at startup and reports a console error if it is not
available. CodeMirror 6 and PDF.js are loaded from CDNs; for offline use, place
local ESM builds in `src/lib/` and update imports in `src/main.js`.
