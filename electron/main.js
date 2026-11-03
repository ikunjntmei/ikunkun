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

function applyChromiumEnv() {
  try {
    const customFile = path.join(DATA_DIR, 'custom_kernel.txt');
    if (fs.existsSync(customFile)) {
      const customExe = fs.readFileSync(customFile, 'utf8').trim();
      if (customExe && fs.existsSync(customExe) && !customExe.toLowerCase().includes('edge') && !customExe.toLowerCase().includes('msedge')) {
        process.env.LFB_CHROMIUM_EXECUTABLE = customExe;
        return;
      }
    }
    const marker = executableMarker(DATA_DIR);
    if (fs.existsSync(marker)) {
      const exe = fs.readFileSync(marker, 'utf8').trim();
      if (exe && fs.existsSync(exe) && !exe.toLowerCase().includes('edge') && !exe.toLowerCase().includes('msedge')) {
        process.env.LFB_CHROMIUM_EXECUTABLE = exe;
        return;
      }
    }
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
  // 全局强锁：将 Playwright 默认内核直接定向到本地 1148 纯净核心
  const forcedChromiumPath = path.join(DATA_DIR, 'browsers', 'chromium-1148', 'chrome.exe');
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = forcedChromiumPath;

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
  const status = await chromiumStatus(DATA_DIR);
  const customFile = path.join(DATA_DIR, 'custom_kernel.txt');
  let customPath = '';
  if (fs.existsSync(customFile)) {
    customPath = fs.readFileSync(customFile, 'utf8').trim();
  }
  return { ...status, customPath };
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

handle('settings:save-kernel', async (_, kernelPath) => {
  if (kernelPath && (kernelPath.toLowerCase().includes('edge') || kernelPath.toLowerCase().includes('msedge'))) {
    throw new Error('严禁使用 Microsoft Edge 内核');
  }
  const customFile = path.join(DATA_DIR, 'custom_kernel.txt');
  if (kernelPath) {
    fs.writeFileSync(customFile, kernelPath, 'utf8');
  } else if (fs.existsSync(customFile)) {
    fs.unlinkSync(customFile);
  }
  applyChromiumEnv();
  return { ok: true };
});

handle('settings:get-kernel', async () => {
  const customFile = path.join(DATA_DIR, 'custom_kernel.txt');
  if (fs.existsSync(customFile)) {
    return fs.readFileSync(customFile, 'utf8').trim();
  }
  return '';
});

// 修复与 preload.js 的通道名称对齐：由 browse-kernel 改为 dialog:select-kernel
handle('dialog:select-kernel', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择自定义浏览器内核可执行文件',
    filters: [{ name: 'Executables', extensions: ['exe', 'app'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return '';
  const filePath = result.filePaths[0];
  if (filePath.toLowerCase().includes('edge') || filePath.toLowerCase().includes('msedge')) {
    throw new Error('严禁选择 Microsoft Edge 内核');
  }
  return filePath;
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
