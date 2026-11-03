'use strict';
/**
 * ikun — Electron shell.
 * Main process starts the local backend (Koa API + profile/browser manager)
 * and hosts the management UI, which talks to the same Local API over HTTP.
 */
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, session, safeStorage, dialog, clipboard } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const { startBackend, DATA_DIR } = require('../src/server');
const { chromiumStatus, downloadChromium, executableMarker } = require('./chromium');
const { checkUpdate, installUpdate } = require('./updater');

let backend = null;
let mainWindow = null;
let tray = null;

const uiFile = path.join(__dirname, 'renderer', 'index.html');
const uiURL = pathToFileURL(uiFile).href;

if (process.env.LFB_DATA) app.setPath('userData', path.join(DATA_DIR, 'desktop'));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { 
  if (mainWindow && !mainWindow.isDestroyed()) { 
    mainWindow.show(); 
    mainWindow.focus(); 
  } 
});

function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== uiURL) {
    throw new Error('Untrusted IPC sender');
  }
}

ipcMain.on('connection-info', event => {
  try { trusted(event); event.returnValue = { apiBase: backend.url, token: backend.token }; }
  catch { event.returnValue = {}; }
});

// 仅保留官方内部 Marker 标记检测，彻底拔除对系统外部 Google Chrome 的扫描与绑定
function applyChromiumEnv() {
  try {
    const marker = executableMarker(DATA_DIR);
    if (fs.existsSync(marker)) {
      const exe = fs.readFileSync(marker, 'utf8').trim();
      if (exe && fs.existsSync(exe)) {
        process.env.LFB_CHROMIUM_EXECUTABLE = exe;
        return;
      }
    }
    // 未设定特定内部标记时，清空环境变量，让 Playwright 自行拉起官方纯净无标 Chromium
    delete process.env.LFB_CHROMIUM_EXECUTABLE;
  } catch {
    delete process.env.LFB_CHROMIUM_EXECUTABLE;
  }
}

function getAppIconPath() {
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(icoPath)) {
    return icoPath;
  }
  return fs.existsSync(pngPath) ? pngPath : undefined;
}

function initTray(iconPath) {
  if (tray || !iconPath) return;

  tray = new Tray(iconPath);
  tray.setToolTip('ikun');

  const trayMenu = Menu.buildFromTemplate([
    {
      label: '显示主界面',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出软件',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(trayMenu);

  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function createWindow() {
  const iconPath = getAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'ikun',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== uiURL) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  await mainWindow.loadFile(uiFile);
  initTray(iconPath);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  applyChromiumEnv();

  try {
    const requireSafeStorage = () => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全读取或迁移代理凭据');
    };
    backend = await startBackend(undefined, {
      secretStorage: {
        encrypt: value => { requireSafeStorage(); return safeStorage.encryptString(value).toString('base64'); },
        decrypt: value => { requireSafeStorage(); return safeStorage.decryptString(Buffer.from(value, 'base64')); },
      },
      resolveSystemProxy: url => session.defaultSession.resolveProxy(url),
      downloadsDirectory: app.getPath('downloads'),
    });
  } catch (err) {
    console.error('[ikun] backend failed to start:', err.message);
    dialog.showErrorBox('ikun 无法启动', err.message);
    app.exit(1);
    return;
  }
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { 
  if (process.platform !== 'darwin') app.quit(); 
});

let quitting = false;
app.on('before-quit', event => {
  if (quitting || !backend) return;
  event.preventDefault();
  quitting = true;

  const timer = setTimeout(() => { app.exit(0); }, 3000);

  backend.browsers.closeAll().finally(() => {
    clearTimeout(timer);
    backend.server?.close?.();
    if (tray) tray.destroy();
    app.quit();
  });
});

// --- renderer IPC ---

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => { trusted(event); return callback(event, ...args); });
}

handle('minimize-to-tray', () => {
  if (mainWindow) mainWindow.hide();
  return { ok: true };
});

handle('chromium-status', async () => {
  return chromiumStatus(DATA_DIR);
});

handle('chromium-download', async (event) => {
  if (backend.browsers.listOpen().length || backend.browsers.opening.size) throw new Error('请先关闭所有环境再更新内核');
  const send = (p) => event.sender.send('chromium-download-progress', p);
  try {
    const exe = await downloadChromium(DATA_DIR, send);
    process.env.LFB_CHROMIUM_EXECUTABLE = exe;
    return { ok: true, executable: exe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handle('open-data-dir', async () => {
  shell.openPath(backend.dataDir);
  return { ok: true };
});

handle('proxy-clipboard', async () => {
  try { return { ok: true, proxy: require('../src/proxyparse').parseProxyLine(await clipboard.readText()) }; }
  catch { return { ok: false }; }
});

handle('update-check', () => checkUpdate());
handle('update-install', () => installUpdate());
