// Browser implementations of the desktop API (no Node/Electron).
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
      download(filePath.split(/[\\/]/).pop(), bytes);
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
