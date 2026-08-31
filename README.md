# QuickPDF Editor

Fast, simple cross-platform PDF editor for **Windows** and **macOS**, built with Electron.

## Features

- 📂 Open and view PDFs (continuous scroll, page thumbnails, zoom 40–300%)
- 🅣 **Add text** anywhere on a page (color + size)
- ✏️ **Freehand draw** and 🖍 **highlight**
- 🖱 Select, move, and delete annotations (Delete key), undo with Ctrl/Cmd+Z
- ⟲⟳ **Rotate pages**, 🗑 **delete pages**, ⬆⬇ **reorder pages**
- 🧩 **Merge** multiple PDFs into one
- 💾 Save / Save As — edits are baked into a real PDF (pdf-lib)
- Open a PDF from the command line: `quickpdf mydoc.pdf`

Keyboard shortcuts: `V` select · `T` text · `D` draw · `H` highlight · `Ctrl+O/S` open/save.

## Development

```bash
npm install
npm start
```

## Building installers

### Windows (run on Windows)

```bash
npm run dist:win
```

Output: `release/QuickPDF Editor Setup <version>.exe`

### macOS (run on a Mac, or via the GitHub Actions workflow)

```bash
npm run dist:mac
```

Output: `release/QuickPDF Editor-<version>-arm64.dmg` (and x64).

Or push this repo to GitHub and run the **Build macOS** workflow
(`.github/workflows/build-mac.yml`) — the DMG is uploaded as a build artifact.

> Note: the mac build is unsigned by default. To sign/notarize, add
> `CSC_LINK`/`CSC_KEY_PASSWORD` and Apple notarization secrets per the
> [electron-builder docs](https://www.electron.build/code-signing).

## Tech

- [Electron](https://electronjs.org) — app shell
- [pdf.js](https://mozilla.github.io/pdf.js/) — rendering
- [pdf-lib](https://pdf-lib.js.org/) — editing/saving/merging
