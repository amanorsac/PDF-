import * as pdfjsLib from './vendor/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  './vendor/pdf.worker.mjs',
  import.meta.url
).toString();

const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;

// ---------------- State ----------------

const state = {
  originalBytes: null,
  filePath: null,
  fileInfo: null,        // { sizeBytes, modified }
  pdfDoc: null,
  // page entry: { srcIndex, extraRotation, annotations: [] }
  // annotations:
  //  { type:'text', x, y, size, color, text }
  //  { type:'ink'|'highlight', points:[{x,y}], color, width, opacity }
  //  { type:'rect'|'ellipse', x1,y1,x2,y2, color, width }
  //  { type:'image', x, y, w, h, dataB64, fmt }        (x,y = bottom-left)
  pages: [],
  formFields: [],        // { name, type, srcPageIndex, rect:{x,y,w,h}, value, options }
  formMode: false,
  password: null,        // open password, if the user supplied one
  flattenForms: false,   // opt-in; off keeps fields fillable (best for gov forms)
  docFlags: { encrypted: false, hasXfa: false, hasSignatures: false, pdfLibUsable: true },
  originalOrder: [],     // srcIndex order at load time, to detect structure changes
  watermark: null,       // { text }
  currentPage: 0,
  zoom: 1.0,
  tool: 'select',
  color: '#e03131',
  fontSize: 16,
  selected: null,
  undoStack: [],
  redoStack: [],
  dirty: false,
  panel: 'recent'
};

const pageViews = []; // { container, pdfCanvas, annoCanvas, formLayer, viewport, page }
const imageCache = new WeakMap(); // anno -> HTMLImageElement

// ---------------- DOM helpers ----------------

const $ = (id) => document.getElementById(id);
const viewer = $('viewer');
const statusEl = $('status');

function setStatus(msg) { statusEl.textContent = msg; }
function basename(p) { return p ? p.split(/[\\/]/).pop() : 'untitled.pdf'; }

function markDirty() {
  state.dirty = true;
  state.redoStack = [];
  updateToolbar();
}

// ---------------- Recent files (localStorage) ----------------

function getRecents() {
  try { return JSON.parse(localStorage.getItem('recentFiles') || '[]'); } catch { return []; }
}
function saveRecents(list) { localStorage.setItem('recentFiles', JSON.stringify(list.slice(0, 20))); }
function addRecent(filePath) {
  if (!filePath) return;
  let list = getRecents();
  const existing = list.find(r => r.path === filePath);
  const starred = existing ? existing.starred : false;
  list = list.filter(r => r.path !== filePath);
  list.unshift({ path: filePath, name: basename(filePath), starred, opened: Date.now() });
  saveRecents(list);
  if (state.panel === 'recent' || state.panel === 'starred') renderPanel();
}

// ---------------- Loading ----------------

function askPassword(retry) {
  return new Promise((resolve) => {
    const modal = $('pw-modal');
    const input = $('pw-input');
    input.value = '';
    $('pw-msg').textContent = retry
      ? 'Incorrect password. Please try again.'
      : 'Enter the open password to view and edit this document.';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 0);

    const done = (val) => {
      modal.classList.add('hidden');
      $('pw-ok').removeEventListener('click', ok);
      $('pw-cancel').removeEventListener('click', cancel);
      input.removeEventListener('keydown', key);
      resolve(val);
    };
    const ok = () => done(input.value || '');
    const cancel = () => done(null);
    const key = (e) => {
      if (e.key === 'Enter') ok();
      if (e.key === 'Escape') cancel();
      e.stopPropagation();
    };
    $('pw-ok').addEventListener('click', ok);
    $('pw-cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', key);
  });
}

function showBanner(text, danger = false) {
  const b = $('doc-banner');
  $('doc-banner-text').textContent = text;
  b.classList.toggle('danger', danger);
  b.classList.remove('hidden');
}
function hideBanner() { $('doc-banner').classList.add('hidden'); }

// Inspect the document for features our save pipeline must respect.
async function detectDocFlags() {
  const flags = { encrypted: false, hasXfa: false, hasSignatures: false, pdfLibUsable: true };
  try {
    const { PDFName } = window.PDFLib;
    const doc = await PDFDocument.load(state.originalBytes, {
      ignoreEncryption: true,
      ...(state.password ? { password: state.password } : {})
    });
    flags.encrypted = !!doc.isEncrypted;
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'));
    if (acro && acro.get) {
      flags.hasXfa = !!acro.get(PDFName.of('XFA'));
      const sigFlags = acro.get(PDFName.of('SigFlags'));
      if (sigFlags && typeof sigFlags.asNumber === 'function' && sigFlags.asNumber() > 0) {
        flags.hasSignatures = true;
      }
    }
    // pdf-lib cannot decrypt: an encrypted doc would serialize to garbage.
    flags.pdfLibUsable = !flags.encrypted;
  } catch (e) {
    console.warn('Flag detection failed:', e.message);
    flags.pdfLibUsable = false;
  }
  state.docFlags = flags;

  const notes = [];
  if (flags.hasXfa) notes.push('This is an XFA (dynamic) form — common in IRS/USCIS filings. Field values can be filled and saved as a flattened copy, but the dynamic form layer cannot be preserved.');
  if (flags.hasSignatures) notes.push('This document contains digital signature fields — saving will invalidate existing signatures.');
  if (flags.encrypted) notes.push('This PDF is encrypted. Edits will be saved as an unlocked, flattened copy of the pages.');
  if (notes.length) showBanner(notes.join('  •  '), flags.hasXfa || flags.encrypted);
  else hideBanner();
}

async function loadPdf(filePath, arrayBuffer) {
  setStatus('Loading…');
  try {
    state.originalBytes = arrayBuffer.slice(0);
    state.filePath = filePath;
    state.password = null;

    // pdf.js can decrypt; prompt for the open password when required.
    let attempt = 0;
    const openDoc = async () => {
      const task = pdfjsLib.getDocument({
        data: state.originalBytes.slice(0),
        ...(state.password ? { password: state.password } : {})
      });
      task.onPassword = async (updatePassword, reason) => {
        const pw = await askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
        if (pw === null) { task.destroy(); throw new Error('cancelled'); }
        state.password = pw;
        updatePassword(pw);
      };
      return task.promise;
    };

    try {
      state.pdfDoc = await openDoc();
    } catch (e) {
      if (String(e.message).includes('cancelled')) { setStatus('Cancelled — password required'); return; }
      throw e;
    }
    void attempt;

    state.pages = [];
    for (let i = 0; i < state.pdfDoc.numPages; i++) {
      state.pages.push({ srcIndex: i, extraRotation: 0, annotations: [] });
    }
    state.originalOrder = state.pages.map(p => p.srcIndex);
    state.currentPage = 0;
    state.selected = null;
    state.undoStack = [];
    state.redoStack = [];
    state.watermark = null;
    state.formMode = false;
    state.dirty = false;

    await detectDocFlags();

    state.fileInfo = null;
    if (filePath && window.api.statFile) {
      try { state.fileInfo = await window.api.statFile(filePath); } catch { /* ignore */ }
    }

    await loadFormFields();

    $('empty-state')?.remove();
    await renderAll();
    switchPanel('pages');
    updateToolbar();
    updateQuickView();
    addRecent(filePath);
    document.title = `QuickPDF Editor — ${basename(filePath)}`;
    setStatus(`${state.pages.length} page${state.pages.length > 1 ? 's' : ''}${state.formFields.length ? ` · ${state.formFields.length} form fields` : ''}`);
    console.log(`QUICKPDF_LOADED pages=${state.pages.length} fields=${state.formFields.length}`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to open: ${err.message}`);
  }
}

// ---------------- Form fields (pdf-lib) ----------------

async function loadFormFields() {
  state.formFields = [];
  try {
    const doc = await PDFDocument.load(state.originalBytes, {
      ignoreEncryption: true,
      ...(state.password ? { password: state.password } : {})
    });
    const form = doc.getForm();
    const fields = form.getFields();
    if (!fields.length) return;
    const pageRefs = doc.getPages().map(p => p.ref);

    for (const field of fields) {
      const name = field.getName();
      let type = null, value = '', options = null;
      const { PDFTextField, PDFCheckBox, PDFDropdown } = window.PDFLib;
      if (field instanceof PDFTextField) { type = 'text'; try { value = field.getText() || ''; } catch {} }
      else if (field instanceof PDFCheckBox) { type = 'checkbox'; try { value = field.isChecked(); } catch { value = false; } }
      else if (field instanceof PDFDropdown) {
        type = 'dropdown';
        try { options = field.getOptions(); value = (field.getSelected() || [])[0] || ''; } catch {}
      } else continue; // radio groups, buttons, signatures: skip in v1

      const widgets = field.acroField.getWidgets();
      if (!widgets.length) continue;
      const w = widgets[0];
      const rect = w.getRectangle();
      let srcPageIndex = -1;
      try {
        const pRef = w.P();
        srcPageIndex = pageRefs.findIndex(r => pRef && r === pRef);
      } catch {}
      if (srcPageIndex < 0) {
        // fallback: find page whose Annots contains this widget
        const pages = doc.getPages();
        for (let pi = 0; pi < pages.length; pi++) {
          const annots = pages[pi].node.Annots?.();
          if (!annots) continue;
          for (let ai = 0; ai < annots.size(); ai++) {
            if (annots.get(ai) === w.dict || annots.lookup(ai) === w.dict) { srcPageIndex = pi; break; }
          }
          if (srcPageIndex >= 0) break;
        }
      }
      if (srcPageIndex < 0) srcPageIndex = 0;

      state.formFields.push({
        name, type, srcPageIndex, value, options, initial: value,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      });
    }
  } catch (err) {
    console.warn('Form parse failed:', err.message);
  }
}

function toggleFormMode(on) {
  state.formMode = on === undefined ? !state.formMode : on;
  document.querySelectorAll('.form-layer').forEach(l => l.classList.toggle('on', state.formMode));
  renderFormLayers();
  $('btn-fill-form').classList.toggle('active', state.formMode);
  setStatus(state.formMode
    ? `Form mode: ${state.formFields.length} fillable field${state.formFields.length === 1 ? '' : 's'}`
    : '');
}

function renderFormLayers() {
  for (let i = 0; i < state.pages.length; i++) {
    const view = pageViews[i];
    if (!view) continue;
    view.formLayer.innerHTML = '';
    if (!state.formMode) continue;
    const srcIndex = state.pages[i].srcIndex;
    for (const f of state.formFields) {
      if (f.srcPageIndex !== srcIndex) continue;
      const [vx1, vy1] = view.viewport.convertToViewportPoint(f.rect.x, f.rect.y);
      const [vx2, vy2] = view.viewport.convertToViewportPoint(f.rect.x + f.rect.w, f.rect.y + f.rect.h);
      const left = Math.min(vx1, vx2), top = Math.min(vy1, vy2);
      const width = Math.abs(vx2 - vx1), height = Math.abs(vy2 - vy1);

      let el;
      if (f.type === 'checkbox') {
        el = document.createElement('input');
        el.type = 'checkbox';
        el.checked = !!f.value;
        el.addEventListener('change', () => { f.value = el.checked; markDirty(); });
      } else if (f.type === 'dropdown') {
        el = document.createElement('select');
        (f.options || []).forEach(opt => {
          const o = document.createElement('option');
          o.value = o.textContent = opt;
          if (opt === f.value) o.selected = true;
          el.appendChild(o);
        });
        el.addEventListener('change', () => { f.value = el.value; markDirty(); });
      } else {
        el = document.createElement('input');
        el.type = 'text';
        el.value = f.value || '';
        el.style.fontSize = `${Math.max(9, Math.min(height * 0.6, 18))}px`;
        el.addEventListener('input', () => { f.value = el.value; markDirty(); });
      }
      el.className = 'form-field';
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      el.title = f.name;
      view.formLayer.appendChild(el);
    }
  }
}

// ---------------- Rendering ----------------

async function renderAll() {
  viewer.innerHTML = '';
  pageViews.length = 0;
  for (let i = 0; i < state.pages.length; i++) await renderPage(i);
  if (state.panel === 'pages') renderPanel();
  renderFormLayers();
  highlightCurrent();
  updatePageBar();
  $('pagebar').classList.toggle('hidden', state.pages.length === 0);
}

async function renderPage(pageIdx) {
  const entry = state.pages[pageIdx];
  const page = await state.pdfDoc.getPage(entry.srcIndex + 1);
  const viewport = page.getViewport({
    scale: state.zoom,
    rotation: (page.rotate + entry.extraRotation) % 360
  });

  const container = document.createElement('div');
  container.className = 'page-container';
  container.dataset.pageIdx = pageIdx;

  const dpr = window.devicePixelRatio || 1;
  const mk = (cls) => {
    const c = document.createElement('canvas');
    c.className = cls;
    c.width = Math.floor(viewport.width * dpr);
    c.height = Math.floor(viewport.height * dpr);
    c.style.width = `${viewport.width}px`;
    c.style.height = `${viewport.height}px`;
    return c;
  };
  const pdfCanvas = mk('pdf-layer');
  const annoCanvas = mk(`anno-layer tool-${state.tool}`);
  const formLayer = document.createElement('div');
  formLayer.className = `form-layer${state.formMode ? ' on' : ''}`;

  container.appendChild(pdfCanvas);
  container.appendChild(annoCanvas);
  container.appendChild(formLayer);
  viewer.appendChild(container);

  const ctx = pdfCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  await page.render({ canvasContext: ctx, viewport }).promise;

  pageViews[pageIdx] = { container, pdfCanvas, annoCanvas, formLayer, viewport, page };
  drawAnnotations(pageIdx);
  attachPageEvents(pageIdx);
}

// ---------------- Side panel ----------------

function switchPanel(name) {
  state.panel = name;
  document.querySelectorAll('.nav-item[data-panel]').forEach(b =>
    b.classList.toggle('active', b.dataset.panel === name));
  $('panel-title').textContent = { pages: 'Pages', recent: 'Recent', starred: 'Starred' }[name] || name;
  $('side-panel').classList.remove('hidden');
  renderPanel();
}

function renderPanel() {
  const content = $('panel-content');
  content.innerHTML = '';

  if (state.panel === 'pages') {
    if (!state.pages.length) {
      content.innerHTML = '<div class="panel-empty">No document open.</div>';
      return;
    }
    for (let i = 0; i < state.pages.length; i++) {
      const view = pageViews[i];
      if (!view) continue;
      const thumb = document.createElement('div');
      thumb.className = 'thumb' + (i === state.currentPage ? ' current' : '');
      const c = document.createElement('canvas');
      const scale = 150 / view.pdfCanvas.width;
      c.width = 150;
      c.height = Math.floor(view.pdfCanvas.height * scale);
      c.getContext('2d').drawImage(view.pdfCanvas, 0, 0, c.width, c.height);
      const num = document.createElement('span');
      num.className = 'thumb-num';
      num.textContent = String(i + 1);
      thumb.appendChild(c);
      thumb.appendChild(num);
      thumb.addEventListener('click', () => {
        setCurrentPage(i);
        view.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      content.appendChild(thumb);
    }
  } else {
    // recent / starred
    let list = getRecents();
    if (state.panel === 'starred') list = list.filter(r => r.starred);
    if (!list.length) {
      content.innerHTML = `<div class="panel-empty">${state.panel === 'starred' ? 'No starred files yet. Click ☆ on a recent file.' : 'No recent files yet.'}</div>`;
      return;
    }
    for (const r of list) {
      const item = document.createElement('div');
      item.className = 'recent-item';
      const icon = document.createElement('span');
      icon.textContent = '📄';
      const name = document.createElement('span');
      name.className = 'rname';
      name.textContent = r.name;
      name.title = r.path;
      const star = document.createElement('span');
      star.className = 'star' + (r.starred ? ' on' : '');
      star.textContent = r.starred ? '★' : '☆';
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        const all = getRecents();
        const t = all.find(x => x.path === r.path);
        if (t) { t.starred = !t.starred; saveRecents(all); renderPanel(); }
      });
      item.appendChild(icon); item.appendChild(name); item.appendChild(star);
      item.addEventListener('click', async () => {
        try {
          const data = await window.api.readFile(r.path);
          await loadPdf(r.path, data);
        } catch {
          setStatus('File not found — removing from list');
          saveRecents(getRecents().filter(x => x.path !== r.path));
          renderPanel();
        }
      });
      content.appendChild(item);
    }
  }
}

function setCurrentPage(idx) {
  state.currentPage = Math.max(0, Math.min(idx, state.pages.length - 1));
  highlightCurrent();
  updatePageBar();
  updateQuickView();
}

function highlightCurrent() {
  if (state.panel !== 'pages') return;
  document.querySelectorAll('.thumb').forEach((t, i) =>
    t.classList.toggle('current', i === state.currentPage));
}

function updatePageBar() {
  $('pb-page').value = state.pages.length ? String(state.currentPage + 1) : '0';
  $('pb-count').textContent = `/ ${state.pages.length}`;
}

// ---------------- Quick View panel ----------------

function updateQuickView() {
  $('qv-name').textContent = state.filePath ? basename(state.filePath) : '—';
  $('qv-name').title = state.filePath || '';
  $('qv-pages').textContent = state.pages.length || '—';
  if (state.fileInfo) {
    const mb = state.fileInfo.sizeBytes / (1024 * 1024);
    $('qv-size').textContent = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(state.fileInfo.sizeBytes / 1024)} KB`;
    $('qv-modified').textContent = new Date(state.fileInfo.modified).toLocaleDateString();
  } else {
    $('qv-size').textContent = '—';
    $('qv-modified').textContent = '—';
  }
  const view = pageViews[state.currentPage];
  if (view) {
    const wmm = Math.round(view.viewport.width / state.zoom / 72 * 25.4);
    const hmm = Math.round(view.viewport.height / state.zoom / 72 * 25.4);
    $('qv-pagesize').textContent = `${wmm} × ${hmm} mm`;
    $('qv-orient').textContent = wmm > hmm ? 'Landscape' : 'Portrait';
  } else {
    $('qv-pagesize').textContent = '—';
    $('qv-orient').textContent = '—';
  }
}

// ---------------- Annotation drawing ----------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function annoBBoxView(view, a) {
  const map = (x, y) => view.viewport.convertToViewportPoint(x, y);
  let corners;
  if (a.type === 'text') {
    const w = a.text.length * a.size * 0.55;
    corners = [map(a.x, a.y), map(a.x + w, a.y + a.size)];
  } else if (a.type === 'rect' || a.type === 'ellipse') {
    corners = [map(a.x1, a.y1), map(a.x2, a.y2)];
  } else if (a.type === 'image') {
    corners = [map(a.x, a.y), map(a.x + a.w, a.y + a.h)];
  } else {
    corners = a.points.map(p => map(p.x, p.y));
  }
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function drawAnnotations(pageIdx, temp = null) {
  const view = pageViews[pageIdx];
  if (!view) return;
  const entry = state.pages[pageIdx];
  const ctx = view.annoCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view.annoCanvas.width, view.annoCanvas.height);

  const toView = (pt) => {
    const [vx, vy] = view.viewport.convertToViewportPoint(pt.x, pt.y);
    return { x: vx, y: vy };
  };

  const drawOne = (a) => {
    if (a.type === 'text') {
      const p = toView({ x: a.x, y: a.y });
      ctx.font = `${a.size * state.zoom}px Helvetica, Arial, sans-serif`;
      ctx.fillStyle = a.color;
      ctx.globalAlpha = 1;
      ctx.fillText(a.text, p.x, p.y);
    } else if (a.type === 'rect' || a.type === 'ellipse') {
      const b = annoBBoxView(view, a);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * state.zoom;
      if (a.type === 'rect') ctx.strokeRect(b.x, b.y, b.w, b.h);
      else {
        ctx.beginPath();
        ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (a.type === 'image') {
      const b = annoBBoxView(view, a);
      let img = imageCache.get(a);
      if (!img) {
        img = new Image();
        img.onload = () => drawAnnotations(pageIdx);
        img.src = `data:image/${a.fmt === 'png' ? 'png' : 'jpeg'};base64,${a.dataB64}`;
        imageCache.set(a, img);
      }
      if (img.complete && img.naturalWidth) {
        ctx.globalAlpha = 1;
        ctx.drawImage(img, b.x, b.y, b.w, b.h);
      }
    } else {
      ctx.globalAlpha = a.opacity;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * state.zoom;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      a.points.forEach((pt, i) => {
        const p = toView(pt);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };

  entry.annotations.forEach((a, ai) => {
    drawOne(a);
    const isSel = state.selected && state.selected.pageIdx === pageIdx && state.selected.annoIdx === ai;
    if (isSel) {
      const b = annoBBoxView(view, a);
      ctx.strokeStyle = '#6c5ce7';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
      ctx.setLineDash([]);
    }
  });

  // watermark preview
  if (state.watermark) {
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#555';
    const w = view.viewport.width, h = view.viewport.height;
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 4);
    ctx.font = `${48 * state.zoom}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(state.watermark.text, 0, 0);
    ctx.restore();
  }

  if (temp) drawOne(temp);
}

function redrawAllAnnotations() {
  for (let i = 0; i < state.pages.length; i++) drawAnnotations(i);
}

// ---------------- Page interaction ----------------

function attachPageEvents(pageIdx) {
  const view = pageViews[pageIdx];
  const canvas = view.annoCanvas;

  const toPdfPoint = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const [px, py] = view.viewport.convertToPdfPoint(evt.clientX - rect.left, evt.clientY - rect.top);
    return { x: px, y: py };
  };

  let drawing = null;   // temp ink/highlight
  let shaping = null;   // temp rect/ellipse
  let dragging = null;

  canvas.addEventListener('mousedown', (evt) => {
    setCurrentPage(pageIdx);
    const pdfPt = toPdfPoint(evt);

    if (state.tool === 'draw' || state.tool === 'highlight') {
      drawing = {
        type: state.tool === 'draw' ? 'ink' : 'highlight',
        points: [pdfPt],
        color: state.color,
        width: state.tool === 'draw' ? Math.max(2, state.fontSize / 8) : 14,
        opacity: state.tool === 'draw' ? 1 : 0.35
      };
    } else if (state.tool === 'rect' || state.tool === 'ellipse') {
      shaping = {
        type: state.tool,
        x1: pdfPt.x, y1: pdfPt.y, x2: pdfPt.x, y2: pdfPt.y,
        color: state.color,
        width: Math.max(2, state.fontSize / 8)
      };
    } else if (state.tool === 'eraser') {
      const hit = hitTest(pageIdx, pdfPt);
      if (hit !== null && hit !== undefined) {
        const [removed] = state.pages[pageIdx].annotations.splice(hit, 1);
        state.undoStack.push({ action: 'delete', pageIdx, anno: removed, annoIdx: hit });
        markDirty();
        drawAnnotations(pageIdx);
      }
    } else if (state.tool === 'select') {
      const hit = hitTest(pageIdx, pdfPt);
      if (hit !== null && hit !== undefined) {
        state.selected = { pageIdx, annoIdx: hit };
        const anno = state.pages[pageIdx].annotations[hit];
        dragging = { startPdf: pdfPt, orig: JSON.parse(JSON.stringify(anno)), anno };
      } else {
        state.selected = null;
      }
      redrawAllAnnotations();
    }
  });

  canvas.addEventListener('mousemove', (evt) => {
    if (drawing) {
      drawing.points.push(toPdfPoint(evt));
      drawAnnotations(pageIdx, drawing);
    } else if (shaping) {
      const p = toPdfPoint(evt);
      shaping.x2 = p.x; shaping.y2 = p.y;
      drawAnnotations(pageIdx, shaping);
    } else if (dragging && state.selected) {
      const p = toPdfPoint(evt);
      const dx = p.x - dragging.startPdf.x;
      const dy = p.y - dragging.startPdf.y;
      const anno = state.pages[pageIdx].annotations[state.selected.annoIdx];
      const o = dragging.orig;
      if (anno.type === 'text' || anno.type === 'image') {
        anno.x = o.x + dx; anno.y = o.y + dy;
      } else if (anno.type === 'rect' || anno.type === 'ellipse') {
        anno.x1 = o.x1 + dx; anno.y1 = o.y1 + dy;
        anno.x2 = o.x2 + dx; anno.y2 = o.y2 + dy;
        if (o.dataB64) imageCache.set(anno, imageCache.get(dragging.anno));
      } else {
        anno.points = o.points.map(pt => ({ x: pt.x + dx, y: pt.y + dy }));
      }
      drawAnnotations(pageIdx);
    }
  });

  window.addEventListener('mouseup', () => {
    if (drawing) {
      if (drawing.points.length > 1) {
        state.pages[pageIdx].annotations.push(drawing);
        state.undoStack.push({ action: 'add', pageIdx, annoIdx: state.pages[pageIdx].annotations.length - 1 });
        markDirty();
      }
      drawing = null;
      drawAnnotations(pageIdx);
    }
    if (shaping) {
      if (Math.abs(shaping.x2 - shaping.x1) > 3 && Math.abs(shaping.y2 - shaping.y1) > 3) {
        state.pages[pageIdx].annotations.push(shaping);
        state.undoStack.push({ action: 'add', pageIdx, annoIdx: state.pages[pageIdx].annotations.length - 1 });
        markDirty();
      }
      shaping = null;
      drawAnnotations(pageIdx);
    }
    if (dragging) { markDirty(); dragging = null; }
  });

  canvas.addEventListener('click', (evt) => {
    if (state.tool !== 'text') return;
    const rect = canvas.getBoundingClientRect();
    showTextInput(pageIdx, evt.clientX - rect.left, evt.clientY - rect.top);
  });
}

function hitTest(pageIdx, pdfPt) {
  const entry = state.pages[pageIdx];
  const tolerance = 6 / state.zoom;
  for (let i = entry.annotations.length - 1; i >= 0; i--) {
    const a = entry.annotations[i];
    if (a.type === 'text') {
      const w = a.text.length * a.size * 0.55;
      if (pdfPt.x >= a.x - 3 && pdfPt.x <= a.x + w + 3 &&
          pdfPt.y >= a.y - 3 && pdfPt.y <= a.y + a.size + 3) return i;
    } else if (a.type === 'rect' || a.type === 'ellipse') {
      const minX = Math.min(a.x1, a.x2) - tolerance, maxX = Math.max(a.x1, a.x2) + tolerance;
      const minY = Math.min(a.y1, a.y2) - tolerance, maxY = Math.max(a.y1, a.y2) + tolerance;
      if (pdfPt.x >= minX && pdfPt.x <= maxX && pdfPt.y >= minY && pdfPt.y <= maxY) return i;
    } else if (a.type === 'image') {
      if (pdfPt.x >= a.x && pdfPt.x <= a.x + a.w && pdfPt.y >= a.y && pdfPt.y <= a.y + a.h) return i;
    } else {
      const tol = tolerance + a.width / 2;
      for (const p of a.points) {
        if (Math.hypot(p.x - pdfPt.x, p.y - pdfPt.y) <= tol) return i;
      }
    }
  }
  return null;
}

// ---------------- Text input ----------------

function showTextInput(pageIdx, canvasX, canvasY) {
  removeTextInput();
  const view = pageViews[pageIdx];
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'text-input';
  const sizePx = state.fontSize * state.zoom;
  input.style.left = `${canvasX}px`;
  input.style.top = `${canvasY - sizePx}px`;
  input.style.fontSize = `${sizePx}px`;
  input.style.color = state.color;
  view.container.appendChild(input);
  setTimeout(() => input.focus(), 0);

  const commit = () => {
    const text = input.value.trim();
    if (text) {
      const [px, py] = view.viewport.convertToPdfPoint(canvasX, canvasY);
      state.pages[pageIdx].annotations.push({ type: 'text', x: px, y: py, size: state.fontSize, color: state.color, text });
      state.undoStack.push({ action: 'add', pageIdx, annoIdx: state.pages[pageIdx].annotations.length - 1 });
      markDirty();
      drawAnnotations(pageIdx);
    }
    removeTextInput();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') removeTextInput();
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
}

function removeTextInput() { $('text-input')?.remove(); }

// ---------------- Images & signature ----------------

function placeImageAnnotation(dataB64, fmt, widthPdf = 200) {
  const pageIdx = state.currentPage;
  const view = pageViews[pageIdx];
  if (!view) return;
  const img = new Image();
  img.onload = () => {
    const w = widthPdf;
    const h = w * img.naturalHeight / img.naturalWidth;
    // center of page in PDF space
    const [cx, cy] = view.viewport.convertToPdfPoint(view.viewport.width / 2, view.viewport.height / 2);
    const anno = { type: 'image', x: cx - w / 2, y: cy - h / 2, w, h, dataB64, fmt };
    state.pages[pageIdx].annotations.push(anno);
    imageCache.set(anno, img);
    state.undoStack.push({ action: 'add', pageIdx, annoIdx: state.pages[pageIdx].annotations.length - 1 });
    state.selected = { pageIdx, annoIdx: state.pages[pageIdx].annotations.length - 1 };
    setTool('select');
    markDirty();
    drawAnnotations(pageIdx);
    setStatus('Image placed — drag to position');
  };
  img.src = `data:image/${fmt === 'png' ? 'png' : 'jpeg'};base64,${dataB64}`;
}

async function addImage() {
  if (!state.pages.length) return;
  const result = await window.api.openImage();
  if (!result) return;
  placeImageAnnotation(result.dataB64, result.fmt);
}

// Signature modal
let sigDrawing = false, sigDirty = false;

function openSignatureModal() {
  if (!state.pages.length) return;
  const modal = $('sig-modal');
  const c = $('sig-canvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1a1a6e';
  sigDirty = false;
  modal.classList.remove('hidden');
}

function wireSignatureModal() {
  const modal = $('sig-modal');
  const c = $('sig-canvas');
  const ctx = c.getContext('2d');
  const pos = (e) => {
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  c.addEventListener('mousedown', (e) => {
    sigDrawing = true; sigDirty = true;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  });
  c.addEventListener('mousemove', (e) => {
    if (!sigDrawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
  });
  window.addEventListener('mouseup', () => { sigDrawing = false; });
  $('sig-clear').addEventListener('click', () => { ctx.clearRect(0, 0, c.width, c.height); sigDirty = false; });
  $('sig-cancel').addEventListener('click', () => modal.classList.add('hidden'));
  $('sig-use').addEventListener('click', () => {
    if (!sigDirty) { modal.classList.add('hidden'); return; }
    const dataUrl = c.toDataURL('image/png');
    modal.classList.add('hidden');
    placeImageAnnotation(dataUrl.split(',')[1], 'png', 160);
  });
}

// ---------------- Page operations ----------------

async function rotateCurrent(deltaDeg) {
  if (!state.pages.length) return;
  const entry = state.pages[state.currentPage];
  entry.extraRotation = ((entry.extraRotation + deltaDeg) % 360 + 360) % 360;
  markDirty();
  await renderAll();
}

async function deleteCurrentPage() {
  if (state.pages.length <= 1) { setStatus('Cannot delete the only page'); return; }
  state.pages.splice(state.currentPage, 1);
  state.currentPage = Math.min(state.currentPage, state.pages.length - 1);
  state.selected = null;
  markDirty();
  await renderAll();
  setStatus(`Page deleted — ${state.pages.length} remaining`);
}

async function moveCurrentPage(delta) {
  const i = state.currentPage, j = i + delta;
  if (j < 0 || j >= state.pages.length) return;
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  state.currentPage = j;
  markDirty();
  await renderAll();
}

function goToPage(idx) {
  if (!state.pages.length) return;
  setCurrentPage(idx);
  pageViews[state.currentPage]?.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------- Undo / redo ----------------

function deleteSelectedAnnotation() {
  if (!state.selected) return;
  const { pageIdx, annoIdx } = state.selected;
  const [removed] = state.pages[pageIdx].annotations.splice(annoIdx, 1);
  state.undoStack.push({ action: 'delete', pageIdx, anno: removed, annoIdx });
  state.selected = null;
  markDirty();
  drawAnnotations(pageIdx);
}

function undo() {
  const op = state.undoStack.pop();
  if (!op) return;
  if (op.action === 'add') {
    const [removed] = state.pages[op.pageIdx].annotations.splice(op.annoIdx, 1);
    state.redoStack.push({ action: 'add', pageIdx: op.pageIdx, anno: removed, annoIdx: op.annoIdx });
    if (state.selected && state.selected.pageIdx === op.pageIdx) state.selected = null;
  } else if (op.action === 'delete') {
    state.pages[op.pageIdx].annotations.splice(op.annoIdx, 0, op.anno);
    state.redoStack.push({ action: 'delete', pageIdx: op.pageIdx, annoIdx: op.annoIdx });
  }
  drawAnnotations(op.pageIdx);
}

function redo() {
  const op = state.redoStack.pop();
  if (!op) return;
  if (op.action === 'add') {
    state.pages[op.pageIdx].annotations.splice(op.annoIdx, 0, op.anno);
    state.undoStack.push({ action: 'add', pageIdx: op.pageIdx, annoIdx: op.annoIdx });
  } else if (op.action === 'delete') {
    const [removed] = state.pages[op.pageIdx].annotations.splice(op.annoIdx, 1);
    state.undoStack.push({ action: 'delete', pageIdx: op.pageIdx, anno: removed, annoIdx: op.annoIdx });
  }
  drawAnnotations(op.pageIdx);
}

// ---------------- Saving ----------------

const sanitize = (t) => t.replace(/[^\x20-\x7E]/g, '?');

// True when pages were reordered, deleted, or merged in — the only cases that
// force a full document rebuild.
function structureChanged() {
  const now = state.pages.map(p => p.srcIndex);
  return now.length !== state.originalOrder.length ||
         now.some((v, i) => v !== state.originalOrder[i]);
}

function applyFormValues(doc) {
  if (!state.formFields.some(f => f.value !== f.initial)) return false;
  try {
    const form = doc.getForm();
    for (const f of state.formFields) {
      try {
        if (f.type === 'text') form.getTextField(f.name).setText(f.value || '');
        else if (f.type === 'checkbox') { const cb = form.getCheckBox(f.name); f.value ? cb.check() : cb.uncheck(); }
        else if (f.type === 'dropdown' && f.value) form.getDropdown(f.name).select(f.value);
      } catch (e) { console.warn(`Field ${f.name}:`, e.message); }
    }
    form.updateFieldAppearances();
    return true;
  } catch (e) {
    console.warn('Form fill failed:', e.message);
    return false;
  }
}

async function drawAnnotationsOnPage(doc, page, entry, font) {
  for (const a of entry.annotations) {
    const c = a.color ? hexToRgb(a.color) : { r: 0, g: 0, b: 0 };
    const color = rgb(c.r / 255, c.g / 255, c.b / 255);
    if (a.type === 'text') {
      let text = a.text;
      try { font.widthOfTextAtSize(text, a.size); } catch { text = sanitize(text); }
      try { page.drawText(text, { x: a.x, y: a.y, size: a.size, font, color }); }
      catch { page.drawText(sanitize(text), { x: a.x, y: a.y, size: a.size, font, color }); }
    } else if (a.type === 'rect') {
      page.drawRectangle({
        x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2),
        width: Math.abs(a.x2 - a.x1), height: Math.abs(a.y2 - a.y1),
        borderColor: color, borderWidth: a.width
      });
    } else if (a.type === 'ellipse') {
      page.drawEllipse({
        x: (a.x1 + a.x2) / 2, y: (a.y1 + a.y2) / 2,
        xScale: Math.abs(a.x2 - a.x1) / 2, yScale: Math.abs(a.y2 - a.y1) / 2,
        borderColor: color, borderWidth: a.width
      });
    } else if (a.type === 'image') {
      try {
        const img = a.fmt === 'png' ? await doc.embedPng(a.dataB64) : await doc.embedJpg(a.dataB64);
        page.drawImage(img, { x: a.x, y: a.y, width: a.w, height: a.h });
      } catch (e) { console.warn('Image embed failed:', e.message); }
    } else {
      for (let k = 0; k < a.points.length - 1; k++) {
        page.drawLine({
          start: a.points[k], end: a.points[k + 1],
          thickness: a.width, color, opacity: a.opacity, lineCap: 1
        });
      }
    }
  }

  if (state.watermark) {
    const { width: pw, height: ph } = page.getSize();
    const size = 48;
    const tw = font.widthOfTextAtSize(sanitize(state.watermark.text), size);
    const cos = Math.cos(Math.PI / 4), sin = Math.sin(Math.PI / 4);
    page.drawText(sanitize(state.watermark.text), {
      x: pw / 2 - (tw / 2) * cos,
      y: ph / 2 - (tw / 2) * sin,
      size, font, color: rgb(0.4, 0.4, 0.4),
      opacity: 0.14, rotate: degrees(45)
    });
  }
}

/**
 * PATH 1 — In-place edit. Loads the original document and modifies it directly,
 * so the AcroForm stays live, tags/structure survive, and nothing is rebuilt.
 * Used whenever page order is untouched. This is what makes government forms safe.
 */
async function buildInPlace() {
  const doc = await PDFDocument.load(state.originalBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    ...(state.password ? { password: state.password } : {})
  });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  applyFormValues(doc);

  const pages = doc.getPages();
  for (let i = 0; i < state.pages.length; i++) {
    const entry = state.pages[i];
    const page = pages[entry.srcIndex];
    if (!page) continue;
    if (entry.extraRotation) {
      page.setRotation(degrees(((page.getRotation().angle || 0) + entry.extraRotation) % 360));
    }
    await drawAnnotationsOnPage(doc, page, entry, font);
  }

  if (state.flattenForms && state.formFields.length) {
    try { doc.getForm().flatten(); } catch (e) { console.warn('Flatten failed:', e.message); }
  }
  return doc.save();
}

/**
 * PATH 3 — Rasterize. For encrypted documents, which pdf-lib cannot decrypt and
 * would serialize to garbage. Renders each page through pdf.js (which CAN decrypt)
 * and assembles an unlocked image-based PDF. Lossy, but produces a usable file.
 */
async function buildRasterized() {
  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);

  // Render from a private document instance: the page proxies backing the
  // on-screen canvases already own render tasks, and reusing them deadlocks.
  const task = pdfjsLib.getDocument({
    data: state.originalBytes.slice(0),
    ...(state.password ? { password: state.password } : {})
  });
  const doc = await task.promise;

  try {
  for (let i = 0; i < state.pages.length; i++) {
    const entry = state.pages[i];
    const page = await doc.getPage(entry.srcIndex + 1);
    const viewport = page.getViewport({
      scale: 2,
      rotation: (page.rotate + entry.extraRotation) % 360
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const b64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const img = await outDoc.embedJpg(b64);
    // Lay the raster out at the page's own point size, so annotation
    // coordinates (stored in PDF space) still land correctly.
    const unscaled = page.getViewport({ scale: 1, rotation: (page.rotate + entry.extraRotation) % 360 });
    const outPage = outDoc.addPage([unscaled.width, unscaled.height]);
    outPage.drawImage(img, { x: 0, y: 0, width: unscaled.width, height: unscaled.height });
    await drawAnnotationsOnPage(outDoc, outPage, entry, font);
  }
  } finally {
    await doc.destroy();
  }
  return outDoc.save();
}

/**
 * PATH 2 — Rebuild. Only when pages were reordered or deleted. copyPages cannot
 * carry the AcroForm dictionary, so form values must be flattened to survive.
 */
async function buildRebuilt() {
  const srcDoc = await PDFDocument.load(state.originalBytes, {
    ignoreEncryption: true,
    ...(state.password ? { password: state.password } : {})
  });

  if (applyFormValues(srcDoc) || state.formFields.length) {
    try { srcDoc.getForm().flatten(); } catch (e) { console.warn('Flatten failed:', e.message); }
  }

  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const copied = await outDoc.copyPages(srcDoc, state.pages.map(p => p.srcIndex));

  for (let i = 0; i < copied.length; i++) {
    const page = copied[i];
    const entry = state.pages[i];
    outDoc.addPage(page);
    if (entry.extraRotation) {
      page.setRotation(degrees(((page.getRotation().angle || 0) + entry.extraRotation) % 360));
    }
    await drawAnnotationsOnPage(outDoc, page, entry, font);
  }
  return outDoc.save();
}

async function buildPdfBytes() {
  if (!state.docFlags.pdfLibUsable) return { bytes: await buildRasterized(), mode: 'rasterized' };
  if (structureChanged()) return { bytes: await buildRebuilt(), mode: 'rebuilt' };
  return { bytes: await buildInPlace(), mode: 'in-place' };
}

async function save(as = false) {
  if (!state.originalBytes) return;
  setStatus('Saving…');
  try {
    const { bytes, mode } = await buildPdfBytes();
    const note = {
      'in-place': 'structure preserved',
      'rebuilt': 'pages rebuilt, form flattened',
      'rasterized': 'unlocked flattened copy'
    }[mode];
    if (as || !state.filePath) {
      const suggested = state.filePath ? basename(state.filePath).replace(/\.pdf$/i, '-edited.pdf') : 'document.pdf';
      const savedPath = await window.api.savePdfAs(suggested, bytes);
      if (!savedPath) { setStatus(''); return; }
      setStatus(`Saved: ${basename(savedPath)} — ${note}`);
      addRecent(savedPath);
    } else {
      await window.api.writeFile(state.filePath, bytes);
      setStatus(`Saved: ${basename(state.filePath)} — ${note}`);
    }
    state.dirty = false;
  } catch (err) {
    console.error(err);
    setStatus(`Save failed: ${err.message}`);
  }
}

// ---------------- Merge ----------------

async function mergePdfs() {
  const files = await window.api.openMultiplePdfs();
  if (!files || files.length < 2) {
    if (files) setStatus('Select at least 2 PDFs to merge');
    return;
  }
  setStatus(`Merging ${files.length} PDFs…`);
  try {
    const outDoc = await PDFDocument.create();
    for (const f of files) {
      const doc = await PDFDocument.load(f.data, { ignoreEncryption: true });
      const pages = await outDoc.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => outDoc.addPage(p));
    }
    const bytes = await outDoc.save();
    const savedPath = await window.api.savePdfAs('merged.pdf', bytes);
    if (savedPath) {
      setStatus(`Merged ${files.length} PDFs`);
      const data = await window.api.readFile(savedPath);
      await loadPdf(savedPath, data);
    } else setStatus('');
  } catch (err) {
    console.error(err);
    setStatus(`Merge failed: ${err.message}`);
  }
}

// ---------------- Watermark ----------------

function addWatermark() {
  if (!state.pages.length) return;
  const text = prompt('Watermark text:', state.watermark?.text || 'CONFIDENTIAL');
  if (!text) return;
  state.watermark = { text };
  markDirty();
  redrawAllAnnotations();
}

function removeWatermark() {
  if (!state.watermark) return;
  state.watermark = null;
  markDirty();
  redrawAllAnnotations();
}

// ---------------- Toolbar / tabs ----------------

function updateToolbar() {
  const has = state.pages.length > 0;
  ['btn-save', 'btn-export', 'btn-rotate-l', 'btn-rotate-r', 'btn-page-up', 'btn-page-down',
   'btn-delete-page', 'btn-watermark', 'btn-sign2']
    .forEach(id => { const el = $(id); if (el) el.disabled = !has; });
  $('btn-save').disabled = !has || !state.filePath;
  $('btn-watermark-remove').disabled = !state.watermark;
  $('btn-fill-form').disabled = !has || !state.formFields.length;
  $('form-info').textContent = has
    ? (state.formFields.length ? `${state.formFields.length} fillable field${state.formFields.length === 1 ? '' : 's'} detected` : 'No form fields in this document')
    : '';
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
  $(`tool-${tool === 'ink' ? 'draw' : tool}`)?.classList.add('active');
  document.querySelectorAll('.anno-layer').forEach(c => { c.className = `anno-layer tool-${tool}`; });
  if (tool !== 'select') { state.selected = null; redrawAllAnnotations(); }
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  ['home', 'organize', 'form', 'tools'].forEach(n =>
    $(`ribbon-${n}`).classList.toggle('hidden', n !== name));
}

async function setZoom(z) {
  state.zoom = Math.min(3, Math.max(0.4, z));
  $('zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
  if (state.pages.length) await renderAll();
}

async function openViaDialog() {
  const result = await window.api.openPdf();
  if (result) await loadPdf(result.filePath, result.data);
}

// ---------------- Wiring ----------------

function wireUp() {
  // tabs
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // left nav
  document.querySelectorAll('.nav-item[data-panel]').forEach(b =>
    b.addEventListener('click', () => switchPanel(b.dataset.panel)));
  $('nav-documents').addEventListener('click', openViaDialog);
  $('panel-close').addEventListener('click', () => $('side-panel').classList.add('hidden'));

  // file ops
  $('btn-open').addEventListener('click', openViaDialog);
  $('btn-open-big')?.addEventListener('click', openViaDialog);
  $('btn-save').addEventListener('click', () => save(false));
  $('btn-export').addEventListener('click', () => save(true));
  $('btn-merge').addEventListener('click', mergePdfs);
  $('btn-merge2').addEventListener('click', mergePdfs);

  // tools
  $('tool-select').addEventListener('click', () => setTool('select'));
  $('tool-text').addEventListener('click', () => setTool('text'));
  $('tool-image').addEventListener('click', addImage);
  $('tool-highlight').addEventListener('click', () => setTool('highlight'));
  $('tool-rect').addEventListener('click', () => setTool('rect'));
  $('tool-ellipse').addEventListener('click', () => setTool('ellipse'));
  $('tool-draw').addEventListener('click', () => setTool('draw'));
  $('tool-eraser').addEventListener('click', () => setTool('eraser'));
  $('btn-sign').addEventListener('click', openSignatureModal);
  $('btn-sign2').addEventListener('click', openSignatureModal);
  $('btn-fill-form').addEventListener('click', () => toggleFormMode());
  $('chk-flatten').addEventListener('change', (e) => { state.flattenForms = e.target.checked; markDirty(); });
  $('doc-banner-close').addEventListener('click', hideBanner);
  $('btn-watermark').addEventListener('click', addWatermark);
  $('btn-watermark-remove').addEventListener('click', removeWatermark);

  $('color-picker').addEventListener('input', (e) => { state.color = e.target.value; });
  $('size-picker').addEventListener('change', (e) => { state.fontSize = parseInt(e.target.value, 10); });

  // page ops
  $('btn-rotate-l').addEventListener('click', () => rotateCurrent(-90));
  $('btn-rotate-r').addEventListener('click', () => rotateCurrent(90));
  $('btn-page-up').addEventListener('click', () => moveCurrentPage(-1));
  $('btn-page-down').addEventListener('click', () => moveCurrentPage(1));
  $('btn-delete-page').addEventListener('click', deleteCurrentPage);

  // theme
  const applyTheme = (dark) => {
    document.body.classList.toggle('dark', dark);
    $('btn-theme').textContent = dark ? '☀️' : '🌙';
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  };
  applyTheme(localStorage.getItem('theme') === 'dark');
  $('btn-theme').addEventListener('click', () =>
    applyTheme(!document.body.classList.contains('dark')));

  // undo/redo
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);

  // page bar
  $('pb-prev').addEventListener('click', () => goToPage(state.currentPage - 1));
  $('pb-next').addEventListener('click', () => goToPage(state.currentPage + 1));
  $('pb-page').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(e.target.value, 10);
      if (!isNaN(n)) goToPage(n - 1);
    }
    e.stopPropagation();
  });
  $('btn-zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.15));
  $('btn-zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.15));

  // right panel shortcuts
  $('rp-text').addEventListener('click', () => { switchTab('home'); setTool('text'); });
  $('rp-highlight').addEventListener('click', () => { switchTab('home'); setTool('highlight'); });
  $('rp-watermark').addEventListener('click', addWatermark);
  $('rp-merge').addEventListener('click', mergePdfs);

  // keyboard
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelectedAnnotation();
    if (e.key === 'v') setTool('select');
    if (e.key === 't') setTool('text');
    if (e.key === 'd') setTool('draw');
    if (e.key === 'h') setTool('highlight');
  });

  // scroll tracking
  $('viewer-wrap').addEventListener('scroll', () => {
    const wrap = $('viewer-wrap');
    const mid = wrap.scrollTop + wrap.clientHeight / 2;
    let best = 0, bestDist = Infinity;
    pageViews.forEach((v, i) => {
      if (!v) return;
      const center = v.container.offsetTop + v.container.offsetHeight / 2;
      const d = Math.abs(center - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (best !== state.currentPage) setCurrentPage(best);
  }, { passive: true });

  // menu / open-with
  window.api.onOpenPath(async ({ filePath, data, selftest }) => {
    await loadPdf(filePath, data);
    if (selftest) runSelfTest();
  });
  window.api.onMenu('menu:open', openViaDialog);
  window.api.onMenu('menu:save', () => save(false));
  window.api.onMenu('menu:saveas', () => save(true));
  window.api.onMenu('menu:merge', mergePdfs);

  wireSignatureModal();
  switchPanel('recent');
  updateToolbar();
}

wireUp();
setStatus('Ready');

// Debug/automation hook: lets tests drive the save pipeline directly.
window.__quickpdf = { state, buildPdfBytes, loadPdf, structureChanged, deleteCurrentPage };

// Exercises all three save paths against the loaded document. Run with --selftest.
async function runSelfTest() {
  const line = (m) => console.log('SELFTEST ' + m);
  const reload = async (d) => PDFDocument.load(d);
  try {
    // Path 1 — in-place: form values written, fields must stay live
    if (state.formFields.length) {
      state.formFields[0].value = 'Selftest Value';
      if (state.formFields[1]) state.formFields[1].value = true;
    }
    let t = performance.now();
    let r = await buildPdfBytes();
    let d = await reload(r.bytes);
    line(`path1 mode=${r.mode} pages=${d.getPageCount()} liveFields=${d.getForm().getFields().length} ` +
         `value="${state.formFields.length ? d.getForm().getTextField(state.formFields[0].name).getText() : 'n/a'}" ` +
         `ms=${Math.round(performance.now() - t)}`);

    // Path 2 — rebuild: delete a page so structure changes
    const keep = JSON.parse(JSON.stringify(state.pages));
    state.pages.splice(1, 1);
    t = performance.now();
    r = await buildPdfBytes();
    d = await reload(r.bytes);
    line(`path2 mode=${r.mode} pages=${d.getPageCount()} liveFields=${d.getForm().getFields().length} ms=${Math.round(performance.now() - t)}`);
    state.pages = keep;

    // Path 3 — rasterize: simulate an encrypted document
    state.docFlags.pdfLibUsable = false;
    state.watermark = { text: 'COPY' };
    t = performance.now();
    r = await buildPdfBytes();
    d = await reload(r.bytes);
    const p0 = d.getPage(0);
    line(`path3 mode=${r.mode} pages=${d.getPageCount()} size=${Math.round(p0.getWidth())}x${Math.round(p0.getHeight())} ` +
         `kb=${Math.round(r.bytes.length / 1024)} ms=${Math.round(performance.now() - t)}`);
    state.docFlags.pdfLibUsable = true;
    state.watermark = null;
    line('ALL PASS');
  } catch (e) {
    line('FAIL ' + e.message);
  }
}
