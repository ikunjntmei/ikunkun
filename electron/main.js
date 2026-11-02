'use strict';
/**
 * CIKE — Electron shell.
 * Main process starts the local backend (Koa API + profile/browser manager)
 * and hosts the management UI, which talks to the same Local API over HTTP.
 */
const { app, BrowserWindow, Menu, Tray, ipcMain, shell, session, safeStorage, dialog, clipboard } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const { startBackend, DATA_DIR } = require('../src/server');
const { chromiumStatus, downloadChromium, executableMarker, browserRoot } = require('./chromium');
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

// Windows 增强探测：如果已有下载或手动放置的 Chromium，主动配置环境变量并补写标记
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

    if (process.platform === 'win32') {
      const candidates = [
        path.join(DATA_DIR, 'chromium', 'chrome.exe'),
        path.join(DATA_DIR, 'chromium-1148', 'chrome.exe'),
        path.join(browserRoot(DATA_DIR), 'chromium', 'chrome.exe'),
        path.join(browserRoot(DATA_DIR), 'chromium-1148', 'chrome.exe')
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          process.env.LFB_CHROMIUM_EXECUTABLE = cand;
          try {
            const { privateDirectory, writePrivate } = require('../src/privatefiles');
            privateDirectory(browserRoot(DATA_DIR));
            writePrivate(marker, cand + '\n');
          } catch { /* 容错忽略 */ }
          break;
        }
      }
    }
  } catch { /* not downloaded yet */ }
}

// 创建系统右下角托盘
function initTray(iconPath) {
  if (tray) return;
  const finalIcon = fs.existsSync(iconPath) ? iconPath : undefined;
  if (!finalIcon) return;

  tray = new Tray(finalIcon);
  tray.setToolTip('CIKE 环境管理');

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

  // 单击托盘图标切换显示/隐藏
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

// 设置自定义顶层菜单：左上角仅保留「菜单」->「最小化到托盘」
function setupAppMenu() {
  const template = [
    {
      label: '菜单',
      submenu: [
        {
          label: '最小化到托盘',
          accelerator: 'CmdOrCtrl+M',
          click: () => {
            if (mainWindow) mainWindow.hide();
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'CIKE',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 不拦截 close 事件：点击红叉 X 时执行原生关闭流程

  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== uiURL) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadFile(uiFile);

  // 初始化右下角托盘
  initTray(iconPath);
}

app.whenReady().then(async () => {
  setupAppMenu();
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
    console.error('[CIKE] backend failed to start:', err.message);
    dialog.showErrorBox('CIKE 无法启动', err.message);
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

  // 3 秒安全退出兜底
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
