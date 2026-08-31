// Assembles the Chrome extension (MV3) into ./extension from src/renderer.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'extension');
const vendor = path.join(out, 'vendor');

fs.mkdirSync(vendor, { recursive: true });

// ---- vendor libs ----
const copies = [
  ['node_modules/pdfjs-dist/build/pdf.mjs', 'vendor/pdf.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.mjs', 'vendor/pdf.worker.mjs'],
  ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib.min.js']
];
for (const [from, to] of copies) {
  fs.copyFileSync(path.join(root, from), path.join(out, to));
}

// ---- app.js with adjusted paths ----
let app = fs.readFileSync(path.join(src, 'app.js'), 'utf8');
app = app.replace("'../../node_modules/pdfjs-dist/build/pdf.mjs'", "'./vendor/pdf.mjs'");
app = app.replace("'../../node_modules/pdfjs-dist/build/pdf.worker.mjs'", "'./vendor/pdf.worker.mjs'");
fs.writeFileSync(path.join(out, 'app.js'), app);

// ---- styles ----
fs.copyFileSync(path.join(src, 'styles.css'), path.join(out, 'styles.css'));

// ---- editor.html with adjusted script tags + shim ----
let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
html = html.replace(
  '<script src="../../node_modules/pdf-lib/dist/pdf-lib.min.js"></script>',
  '<script src="vendor/pdf-lib.min.js"></script>\n  <script src="api-shim.js"></script>'
);
fs.writeFileSync(path.join(out, 'editor.html'), html);

// ---- manifest ----
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'QuickPDF Editor',
  version: '1.0.0',
  description: 'View, annotate, fill forms, sign, organize and merge PDFs — entirely in your browser. No uploads.',
  action: { default_title: 'Open QuickPDF Editor' },
  background: { service_worker: 'background.js' },
  icons: { 128: 'icon128.png' }
}, null, 2));

// ---- background worker ----
fs.writeFileSync(path.join(out, 'background.js'),
`chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
});
`);

// ---- simple icon (purple square with Q), generated as PNG ----
// 128x128 solid-color PNG via minimal encoder-free approach: use a canvas at runtime instead.
// Chrome requires a real PNG; generate once with node-canvas alternative: embed a pre-built tiny PNG.
const iconB64 =
'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// 1x1 purple pixel placeholder — Chrome scales it. Replace with real art later.
fs.writeFileSync(path.join(out, 'icon128.png'), Buffer.from(iconB64, 'base64'));

// ---- api shim (browser file access) ----
fs.writeFileSync(path.join(out, 'api-shim.js'), `// Browser implementations of the desktop API (no Node/Electron).
(function () {
  function pickFile(accept, multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = !!multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.remove();
        resolve(files.length ? files : null);
      });
      // if the user cancels, we simply never resolve with files; clean up on focus
      window.addEventListener('focus', () => setTimeout(() => {
        if (document.body.contains(input)) { input.remove(); resolve(null); }
      }, 400), { once: true });
      input.click();
    });
  }

  function download(name, bytes) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  let openPathCb = null;

  window.api = {
    openPdf: async () => {
      const files = await pickFile('application/pdf', false);
      if (!files) return null;
      return { filePath: files[0].name, data: await files[0].arrayBuffer() };
    },
    openMultiplePdfs: async () => {
      const files = await pickFile('application/pdf', true);
      if (!files) return null;
      return Promise.all(files.map(async f => ({ filePath: f.name, data: await f.arrayBuffer() })));
    },
    savePdfAs: async (suggestedName, bytes) => {
      download(suggestedName || 'document.pdf', bytes);
      return suggestedName || 'document.pdf';
    },
    writeFile: async (filePath, bytes) => {
      download(filePath.split(/[\\\\/]/).pop(), bytes);
      return filePath;
    },
    readFile: async () => { throw new Error('Not available in browser'); },
    statFile: null,
    openImage: async () => {
      const files = await pickFile('image/png,image/jpeg', false);
      if (!files) return null;
      const f = files[0];
      const fmt = f.type === 'image/png' ? 'png' : 'jpg';
      const buf = await f.arrayBuffer();
      let bin = '';
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      }
      return { filePath: f.name, fmt, dataB64: btoa(bin) };
    },
    onMenu: () => {},
    onOpenPath: (cb) => { openPathCb = cb; }
  };

  // Test hook: ?test=<url> auto-loads a PDF (used for automated verification)
  window.addEventListener('DOMContentLoaded', async () => {
    const t = new URLSearchParams(location.search).get('test');
    if (t && openPathCb) {
      try {
        const resp = await fetch(t);
        const data = await resp.arrayBuffer();
        openPathCb({ filePath: t.split('/').pop(), data });
      } catch (e) { console.error('test load failed', e); }
    }
  });
})();
`);

console.log('Extension built at', out);
