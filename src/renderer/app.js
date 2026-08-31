import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../../node_modules/pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;

// ---------------- State ----------------

const state = {
  originalBytes: null,   // ArrayBuffer of the currently loaded PDF
  filePath: null,
  pdfDoc: null,          // pdf.js document
  // Editable page list. Each entry: { srcIndex, extraRotation, annotations: [] }
  // annotation: { type:'text', x, y, size, color, text }  (PDF space, y = baseline)
  //             { type:'ink'|'highlight', points:[{x,y}], color, width, opacity }
  pages: [],
  currentPage: 0,        // index into state.pages
  zoom: 1.0,
  tool: 'select',
  color: '#e03131',
  fontSize: 16,
  selected: null,        // { pageIdx, annoIdx }
  undoStack: [],         // { action:'add'|'delete'|'move', pageIdx, anno, annoIdx, from }
  dirty: false
};

// Per-rendered-page cache: viewport + canvas refs
const pageViews = []; // { container, pdfCanvas, annoCanvas, viewport, page }

// ---------------- DOM ----------------

const $ = (id) => document.getElementById(id);
const viewer = $('viewer');
const sidebar = $('sidebar');
const statusEl = $('status');

function setStatus(msg) { statusEl.textContent = msg; }
function markDirty() {
  state.dirty = true;
  $('btn-save').disabled = !state.filePath;
  $('btn-saveas').disabled = false;
}

// ---------------- Loading & rendering ----------------

async function loadPdf(filePath, arrayBuffer) {
  setStatus('Loading…');
  state.originalBytes = arrayBuffer.slice(0);
  state.filePath = filePath;
  state.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  state.pages = [];
  for (let i = 0; i < state.pdfDoc.numPages; i++) {
    state.pages.push({ srcIndex: i, extraRotation: 0, annotations: [] });
  }
  state.currentPage = 0;
  state.selected = null;
  state.undoStack = [];
  state.dirty = false;
  $('empty-state')?.remove();
  await renderAll();
  updateToolbar();
  document.title = `QuickPDF Editor — ${basename(filePath)}`;
  setStatus(`${state.pages.length} page${state.pages.length > 1 ? 's' : ''}`);
}

function basename(p) { return p ? p.split(/[\\/]/).pop() : 'untitled.pdf'; }

async function renderAll() {
  viewer.innerHTML = '';
  sidebar.innerHTML = '';
  pageViews.length = 0;

  for (let i = 0; i < state.pages.length; i++) {
    await renderPage(i);
    renderThumb(i);
  }
  highlightCurrent();
}

async function renderPage(pageIdx) {
  const entry = state.pages[pageIdx];
  const page = await state.pdfDoc.getPage(entry.srcIndex + 1);
  const baseRotation = page.rotate; // built-in page rotation
  const viewport = page.getViewport({
    scale: state.zoom * (window.devicePixelRatio > 1 ? 1 : 1),
    rotation: (baseRotation + entry.extraRotation) % 360
  });

  const container = document.createElement('div');
  container.className = 'page-container';
  container.dataset.pageIdx = pageIdx;

  const dpr = window.devicePixelRatio || 1;
  const pdfCanvas = document.createElement('canvas');
  pdfCanvas.className = 'pdf-layer';
  pdfCanvas.width = Math.floor(viewport.width * dpr);
  pdfCanvas.height = Math.floor(viewport.height * dpr);
  pdfCanvas.style.width = `${viewport.width}px`;
  pdfCanvas.style.height = `${viewport.height}px`;

  const annoCanvas = document.createElement('canvas');
  annoCanvas.className = `anno-layer tool-${state.tool}`;
  annoCanvas.width = Math.floor(viewport.width * dpr);
  annoCanvas.height = Math.floor(viewport.height * dpr);
  annoCanvas.style.width = `${viewport.width}px`;
  annoCanvas.style.height = `${viewport.height}px`;

  container.appendChild(pdfCanvas);
  container.appendChild(annoCanvas);
  viewer.appendChild(container);

  const ctx = pdfCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  await page.render({ canvasContext: ctx, viewport }).promise;

  pageViews[pageIdx] = { container, pdfCanvas, annoCanvas, viewport, page };
  drawAnnotations(pageIdx);
  attachPageEvents(pageIdx);
}

function renderThumb(pageIdx) {
  const view = pageViews[pageIdx];
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.dataset.pageIdx = pageIdx;

  const c = document.createElement('canvas');
  const scale = 130 / view.pdfCanvas.width;
  c.width = 130;
  c.height = Math.floor(view.pdfCanvas.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(view.pdfCanvas, 0, 0, c.width, c.height);

  const num = document.createElement('span');
  num.className = 'thumb-num';
  num.textContent = String(pageIdx + 1);

  thumb.appendChild(c);
  thumb.appendChild(num);
  thumb.addEventListener('click', () => {
    setCurrentPage(pageIdx);
    view.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  sidebar.appendChild(thumb);
}

function setCurrentPage(idx) {
  state.currentPage = idx;
  highlightCurrent();
}

function highlightCurrent() {
  document.querySelectorAll('.thumb').forEach((t, i) => {
    t.classList.toggle('current', i === state.currentPage);
  });
}

// ---------------- Annotation drawing (live overlay) ----------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function drawAnnotations(pageIdx, tempStroke = null) {
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

  entry.annotations.forEach((a, ai) => {
    const isSel = state.selected && state.selected.pageIdx === pageIdx && state.selected.annoIdx === ai;
    if (a.type === 'text') {
      const p = toView({ x: a.x, y: a.y });
      const sizePx = a.size * state.zoom;
      ctx.font = `${sizePx}px Helvetica, Arial, sans-serif`;
      ctx.fillStyle = a.color;
      ctx.globalAlpha = 1;
      ctx.fillText(a.text, p.x, p.y);
      if (isSel) {
        const w = ctx.measureText(a.text).width;
        ctx.strokeStyle = '#4dabf7';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(p.x - 2, p.y - sizePx, w + 4, sizePx * 1.25);
        ctx.setLineDash([]);
      }
    } else {
      // ink / highlight
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
      if (isSel) {
        const pts = a.points.map(toView);
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        ctx.strokeStyle = '#4dabf7';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(Math.min(...xs) - 4, Math.min(...ys) - 4,
          Math.max(...xs) - Math.min(...xs) + 8, Math.max(...ys) - Math.min(...ys) + 8);
        ctx.setLineDash([]);
      }
    }
  });

  if (tempStroke && tempStroke.points.length > 1) {
    ctx.globalAlpha = tempStroke.opacity;
    ctx.strokeStyle = tempStroke.color;
    ctx.lineWidth = tempStroke.width * state.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    tempStroke.points.forEach((pt, i) => {
      const p = toView(pt);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// ---------------- Page interaction ----------------

function attachPageEvents(pageIdx) {
  const view = pageViews[pageIdx];
  const canvas = view.annoCanvas;

  const toPdfPoint = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    const [px, py] = view.viewport.convertToPdfPoint(x, y);
    return { x: px, y: py };
  };

  let drawing = null; // temp stroke
  let dragging = null; // { startPdf, origAnno }

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
    } else if (state.tool === 'select') {
      const hit = hitTest(pageIdx, pdfPt);
      if (hit !== null && hit !== undefined) {
        state.selected = { pageIdx, annoIdx: hit };
        const anno = state.pages[pageIdx].annotations[hit];
        dragging = { startPdf: pdfPt, orig: JSON.parse(JSON.stringify(anno)) };
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
    } else if (dragging && state.selected) {
      const pdfPt = toPdfPoint(evt);
      const dx = pdfPt.x - dragging.startPdf.x;
      const dy = pdfPt.y - dragging.startPdf.y;
      const anno = state.pages[pageIdx].annotations[state.selected.annoIdx];
      if (anno.type === 'text') {
        anno.x = dragging.orig.x + dx;
        anno.y = dragging.orig.y + dy;
      } else {
        anno.points = dragging.orig.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
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
    if (dragging) {
      markDirty();
      dragging = null;
    }
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
    } else {
      const tol = tolerance + a.width / 2;
      for (const p of a.points) {
        if (Math.hypot(p.x - pdfPt.x, p.y - pdfPt.y) <= tol) return i;
      }
    }
  }
  return null;
}

function redrawAllAnnotations() {
  for (let i = 0; i < state.pages.length; i++) drawAnnotations(i);
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
      state.pages[pageIdx].annotations.push({
        type: 'text', x: px, y: py, size: state.fontSize, color: state.color, text
      });
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

function removeTextInput() {
  const el = $('text-input');
  if (el) { el.removeEventListener('blur', () => {}); el.remove(); }
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
  const i = state.currentPage;
  const j = i + delta;
  if (j < 0 || j >= state.pages.length) return;
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  state.currentPage = j;
  markDirty();
  await renderAll();
}

// ---------------- Undo / delete annotation ----------------

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
    state.pages[op.pageIdx].annotations.splice(op.annoIdx, 1);
    if (state.selected && state.selected.pageIdx === op.pageIdx) state.selected = null;
  } else if (op.action === 'delete') {
    state.pages[op.pageIdx].annotations.splice(op.annoIdx, 0, op.anno);
  }
  drawAnnotations(op.pageIdx);
}

// ---------------- Saving ----------------

async function buildPdfBytes() {
  const srcDoc = await PDFDocument.load(state.originalBytes);
  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);

  const indices = state.pages.map(p => p.srcIndex);
  const copied = await outDoc.copyPages(srcDoc, indices);

  for (let i = 0; i < copied.length; i++) {
    const page = copied[i];
    const entry = state.pages[i];
    outDoc.addPage(page);

    if (entry.extraRotation) {
      const current = page.getRotation().angle || 0;
      page.setRotation(degrees((current + entry.extraRotation) % 360));
    }

    for (const a of entry.annotations) {
      const c = hexToRgb(a.color);
      const color = rgb(c.r / 255, c.g / 255, c.b / 255);
      if (a.type === 'text') {
        let text = a.text;
        try {
          font.widthOfTextAtSize(text, a.size);
        } catch {
          text = text.replace(/[^\x20-\x7E]/g, '?');
        }
        try {
          page.drawText(text, { x: a.x, y: a.y, size: a.size, font, color });
        } catch {
          page.drawText(text.replace(/[^\x20-\x7E]/g, '?'), { x: a.x, y: a.y, size: a.size, font, color });
        }
      } else {
        for (let k = 0; k < a.points.length - 1; k++) {
          page.drawLine({
            start: a.points[k],
            end: a.points[k + 1],
            thickness: a.width,
            color,
            opacity: a.opacity,
            lineCap: 1 // round
          });
        }
      }
    }
  }

  return outDoc.save();
}

async function save(as = false) {
  if (!state.originalBytes) return;
  setStatus('Saving…');
  try {
    const bytes = await buildPdfBytes();
    if (as || !state.filePath) {
      const suggested = state.filePath ? basename(state.filePath).replace(/\.pdf$/i, '-edited.pdf') : 'document.pdf';
      const savedPath = await window.api.savePdfAs(suggested, bytes);
      if (!savedPath) { setStatus(''); return; }
      setStatus(`Saved: ${basename(savedPath)}`);
    } else {
      await window.api.writeFile(state.filePath, bytes);
      setStatus(`Saved: ${basename(state.filePath)}`);
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
      const doc = await PDFDocument.load(f.data);
      const pages = await outDoc.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => outDoc.addPage(p));
    }
    const bytes = await outDoc.save();
    const savedPath = await window.api.savePdfAs('merged.pdf', bytes);
    if (savedPath) {
      setStatus(`Merged ${files.length} PDFs`);
      const data = await window.api.readFile(savedPath);
      await loadPdf(savedPath, data);
    } else {
      setStatus('');
    }
  } catch (err) {
    console.error(err);
    setStatus(`Merge failed: ${err.message}`);
  }
}

// ---------------- Toolbar wiring ----------------

function updateToolbar() {
  const has = state.pages.length > 0;
  ['btn-save', 'btn-saveas', 'btn-rotate-l', 'btn-rotate-r', 'btn-page-up', 'btn-page-down', 'btn-delete-page']
    .forEach(id => { $(id).disabled = !has; });
}

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
  $(`tool-${tool}`).classList.add('active');
  document.querySelectorAll('.anno-layer').forEach(c => {
    c.className = `anno-layer tool-${tool}`;
  });
  if (tool !== 'select') { state.selected = null; redrawAllAnnotations(); }
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

function wireUp() {
  $('btn-open').addEventListener('click', openViaDialog);
  $('btn-open-big')?.addEventListener('click', openViaDialog);
  $('btn-save').addEventListener('click', () => save(false));
  $('btn-saveas').addEventListener('click', () => save(true));
  $('btn-merge').addEventListener('click', mergePdfs);

  $('tool-select').addEventListener('click', () => setTool('select'));
  $('tool-text').addEventListener('click', () => setTool('text'));
  $('tool-draw').addEventListener('click', () => setTool('draw'));
  $('tool-highlight').addEventListener('click', () => setTool('highlight'));

  $('color-picker').addEventListener('input', (e) => { state.color = e.target.value; });
  $('size-picker').addEventListener('change', (e) => { state.fontSize = parseInt(e.target.value, 10); });

  $('btn-rotate-l').addEventListener('click', () => rotateCurrent(-90));
  $('btn-rotate-r').addEventListener('click', () => rotateCurrent(90));
  $('btn-page-up').addEventListener('click', () => moveCurrentPage(-1));
  $('btn-page-down').addEventListener('click', () => moveCurrentPage(1));
  $('btn-delete-page').addEventListener('click', deleteCurrentPage);

  $('btn-zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.15));
  $('btn-zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.15));

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelectedAnnotation();
    if (e.key === 'v') setTool('select');
    if (e.key === 't') setTool('text');
    if (e.key === 'd') setTool('draw');
    if (e.key === 'h') setTool('highlight');
  });

  // Track most-visible page while scrolling
  $('viewer-wrap').addEventListener('scroll', () => {
    const wrap = $('viewer-wrap');
    const mid = wrap.scrollTop + wrap.clientHeight / 2;
    let best = 0, bestDist = Infinity;
    pageViews.forEach((v, i) => {
      if (!v) return;
      const top = v.container.offsetTop;
      const center = top + v.container.offsetHeight / 2;
      const d = Math.abs(center - mid);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (best !== state.currentPage) setCurrentPage(best);
  }, { passive: true });

  window.api.onOpenPath(async ({ filePath, data }) => {
    await loadPdf(filePath, data);
    console.log(`QUICKPDF_LOADED pages=${state.pages.length}`);
  });

  window.api.onMenu('menu:open', openViaDialog);
  window.api.onMenu('menu:save', () => save(false));
  window.api.onMenu('menu:saveas', () => save(true));
  window.api.onMenu('menu:merge', mergePdfs);
}

wireUp();
setStatus('Ready');
