# QuickPDF Editor

Fast, simple PDF editor for **Windows**, **macOS**, and **Chrome** (browser extension), built with Electron + pdf.js + pdf-lib. All processing is local — no uploads, no cloud.

## Features

- 📂 Open and view PDFs — continuous scroll, page thumbnails, zoom 40–300%
- 🅣 **Add text** anywhere on a page (color + size)
- 🖼 **Insert images** (PNG/JPG), drag to position
- ✏️ **Freehand draw**, 🖍 **highlight**, ▭ **rectangle**, ◯ **ellipse**
- ✒️ **Sign** — draw your signature and place it on the page (e-signature stamp)
- 📝 **Fill PDF forms** — text fields, checkboxes, dropdowns (AcroForm); values are baked in on save
- 💧 **Watermark** — diagonal text watermark across all pages
- ◫ **Eraser** + select/move/delete annotations, full undo/redo
- ⟲⟳ Rotate, 🗑 delete, ⬆⬇ reorder pages
- 🧩 **Merge** multiple PDFs into one
- 🕘 Recent files with ⭐ starring
- 🌙 **Dark mode**
- 💾 Save / Save As / Export — edits are baked into a real PDF

Shortcuts: `V` select · `T` text · `D` draw · `H` highlight · `Ctrl+Z/Y` undo/redo · `Ctrl+O/S` open/save · `Delete` remove selected.

> Note on signing: the Sign tool places a hand-drawn e-signature stamp. It is not a
> cryptographic (certificate-based) digital signature — that requires a signing
> certificate (PKCS#12) and is on the roadmap.

## Development

```bash
npm install
npm start
```

## Building

### Windows installer (run on Windows)

```bash
npm run dist:win
```

→ `release/QuickPDF Editor Setup <version>.exe`

### macOS DMG (run on a Mac, or use GitHub Actions)

```bash
npm run dist:mac
```

→ `release/QuickPDF Editor-<version>-<arch>.dmg`

Or push to GitHub and run the **Build macOS** workflow (`.github/workflows/build-mac.yml`);
the DMG is uploaded as a build artifact. Unsigned by default — add `CSC_LINK` /
notarization secrets per the [electron-builder docs](https://www.electron.build/code-signing) to sign.

### Chrome extension

```bash
node scripts/build-extension.js
```

→ `extension/` (load unpacked) and zip it for the Web Store.

To install locally: Chrome → `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select the `extension/` folder. Click the toolbar icon to open the editor.
In the extension, "Save/Export" downloads the edited PDF (browsers can't overwrite files in place).

## Architecture

| Piece | Role |
|---|---|
| Electron | Desktop shell (Windows/macOS), native file dialogs via IPC |
| pdf.js | Page rendering to canvas |
| pdf-lib | Editing: annotations, form fill/flatten, page ops, merge, save |
| `src/renderer/` | Shared UI — identical code drives desktop and extension |
| `extension/api-shim.js` | Browser replacements for the desktop file APIs |

Annotations are stored in PDF user-space coordinates (via pdf.js viewport transforms),
so they survive zoom and page rotation and map 1:1 into pdf-lib when saving.
