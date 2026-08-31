# Changelog

## v1.0.0

First release. Windows installer, macOS DMG (Apple Silicon + Intel), and a
Chrome extension built from the same editor source.

### Viewing
- Continuous-scroll viewer with page thumbnails and 40–300% zoom
- Dark mode, remembered between sessions
- Recent files list with starring
- Opens password-protected PDFs when you supply the password

### Editing
- Add text, images, freehand ink, highlighter, rectangles, and ellipses
- Signature tool: draw a signature and place it on the page
- Eraser, select/move/delete, undo and redo
- Text watermark across all pages
- Rotate, delete, and reorder pages; merge multiple PDFs

### Forms
- Fill AcroForm text fields, checkboxes, and dropdowns
- Filled forms stay editable by default; flattening is opt-in
- Warns when a document uses XFA, carries digital signatures, or is encrypted

### Saving
Three save strategies, chosen automatically and reported in the status bar:

| Strategy | Used when | Preserves |
|---|---|---|
| In-place | Page order unchanged | Live form fields, tags, metadata, bookmarks |
| Rebuild | Pages reordered or deleted | Page content and annotations; form is flattened |
| Rasterize | Encrypted documents | Page images plus annotations |
