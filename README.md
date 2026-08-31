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

## Save fidelity — how your document is preserved

Most PDF tools rebuild the whole document on save, which quietly destroys form
structure. QuickPDF picks the least destructive path it can:

| Path | When it's used | What survives |
|---|---|---|
| **In-place** (default) | Page order unchanged | Everything — the AcroForm stays **live and fillable**, tags/accessibility structure, metadata, bookmarks |
| **Rebuild** | Pages reordered or deleted | Page content + annotations. `copyPages` cannot carry the AcroForm dictionary, so form values are flattened (baked in) to avoid losing them |
| **Rasterize** | Encrypted documents | Pages become images plus your annotations. Lossy but produces a working, unlocked file — pdf-lib cannot decrypt, so this is the only safe option |

The status bar reports which path was used after every save.

**Flatten on save** (Form tab) is **off by default**, so filled forms stay editable
for the next person — the right behavior for government and shared forms. Turn it
on to permanently lock values in.

### Working with government / official documents

- **Standard AcroForm PDFs** (most federal and state forms): fully supported. Fill,
  save, and the form remains a real fillable form.
- **XFA / dynamic forms** (some IRS, USCIS, DoD filings): detected on open and a
  warning banner appears. Values can be filled and saved as a flattened copy, but the
  dynamic XFA layer cannot be preserved — no JS PDF library supports it. Use the
  official Adobe-based workflow when the agency requires a live XFA submission.
- **Already-signed documents**: detected on open, with a warning that saving will
  invalidate existing digital signatures. This is inherent to modifying a signed PDF,
  not specific to this app.
- **Tagged / Section 508 documents**: preserved on the in-place path; avoid page
  reordering if accessibility structure matters.

### Password-protected PDFs

If a PDF requires an open password, QuickPDF prompts for it and unlocks the document
for viewing and editing once you supply it (pdf.js handles the decryption). Because
pdf-lib cannot re-encrypt or write encrypted content streams, saving produces an
**unlocked** copy via the rasterize path — this is a decryption limitation, not a
bypass. QuickPDF does not attempt to recover or crack unknown passwords.

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

## License

Copyright (c) 2026 amanorsac. All rights reserved. This software is proprietary;
see [LICENSE](LICENSE). Bundled third-party components remain under their own
licenses — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
