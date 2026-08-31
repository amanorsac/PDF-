const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e24',
    title: 'QuickPDF Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  buildMenu();

  // Support "open with" / CLI: quickpdf some.pdf
  mainWindow.webContents.once('did-finish-load', () => {
    const pdfArg = process.argv.find((a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));
    if (pdfArg) {
      const data = fs.readFileSync(pdfArg);
      mainWindow.webContents.send('file:openpath', {
        filePath: path.resolve(pdfArg),
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        selftest: process.argv.includes('--selftest')
      });
    }
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu:open')
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu:save')
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('menu:saveas')
        },
        { type: 'separator' },
        {
          label: 'Merge PDFs…',
          click: () => mainWindow.webContents.send('menu:merge')
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC: file dialogs & disk I/O ----

ipcMain.handle('dialog:openPdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const data = fs.readFileSync(filePath);
  return { filePath, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});

ipcMain.handle('dialog:openMultiplePdfs', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select PDFs to merge (in order)',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths.map((filePath) => {
    const data = fs.readFileSync(filePath);
    return { filePath, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  });
});

ipcMain.handle('dialog:savePdf', async (_evt, { suggestedName, bytes }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save PDF',
    defaultPath: suggestedName || 'document.pdf',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, Buffer.from(bytes));
  return result.filePath;
});

ipcMain.handle('file:write', async (_evt, { filePath, bytes }) => {
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
});

ipcMain.handle('dialog:openImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Insert image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const fmt = filePath.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  return { filePath, fmt, dataB64: fs.readFileSync(filePath).toString('base64') };
});

ipcMain.handle('file:stat', async (_evt, filePath) => {
  const st = fs.statSync(filePath);
  return { sizeBytes: st.size, modified: st.mtimeMs, created: st.birthtimeMs };
});

ipcMain.handle('file:read', async (_evt, filePath) => {
  const data = fs.readFileSync(filePath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
