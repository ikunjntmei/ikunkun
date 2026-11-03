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
const { chromiumStatus, downloadChromium, executableMarker, browserRoot } = require('./chromium');
const { checkUpdate, installUpdate } = require('./updater');

let backend = null;
let mainWindow = null;
let tray = null;

const uiFile = path.join(__dirname, 'renderer', 'index.html');
const uiURL = pathToFileURL(uiFile).href;

// 自定义内核路径保存文件位置
const customKernelFile = path.join(DATA_DIR, 'custom_kernel.txt');

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
    // 1. 最高优先级：检查用户是否在界面上自定义了专属内核路径
    if (fs.existsSync(customKernelFile)) {
      const userKernel = fs.readFileSync(customKernelFile, 'utf8').trim();
      if (userKernel && fs.existsSync(userKernel)) {
        process.env.LFB_CHROMIUM_EXECUTABLE = userKernel;
        return;
      }
    }

    // 2. 次优先级：检查 markers
    const marker = executableMarker(DATA_DIR);
    if (fs.existsSync(marker)) {
      const exe = fs.readFileSync(marker, 'utf8').trim();
      if (exe && fs.existsSync(exe)) {
        process.env.LFB_CHROMIUM_EXECUTABLE = exe;
        return;
      }
    }

    // 3. 第三优先级：检查专属沙盒目录下的独立 chrome.exe
    const sandboxChrome = path.join(DATA_DIR, 'browsers', 'chrome-win', 'chrome.exe');
    if (fs.existsSync(sandboxChrome)) {
      process.env.LFB_CHROMIUM_EXECUTABLE = sandboxChrome;
      return;
    }

    // 4. 兜底备用探测
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

// 获取适配当前系统的图标路径（Windows 优先 .ico，其它平台 .png）
function getAppIconPath() {
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  const pngPath = path.join(__dirname, 'assets', 'icon.png');
  if (process.platform === 'win32' && fs.existsSync(icoPath)) {
    return icoPath;
  }
  return fs.existsSync(pngPath) ? pngPath : undefined;
}

// 创建系统右下角托盘
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

  // 阻止自动唤起外部 Chrome 浏览器
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  await mainWindow.loadFile(uiFile);

  // 初始化右下角托盘
  initTray(iconPath);
}

app.whenReady().then(async () => {
  // 移除原生小菜单栏，保持界面清爽现代
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

// 侧边栏“最小化到托盘”通道
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

// --- 新增：自定义内核路径 IPC 交互通道 ---

// 1. 弹出 Windows 原生文件选择对话框
handle('dialog:select-kernel', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择独立 Chromium 执行文件 (chrome.exe)',
    properties: ['openFile'],
    filters: [
      { name: 'Chromium 可执行程序', extensions: ['exe'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

// 2. 保存自定义内核路径并实时生效
handle('settings:save-kernel', async (_e, kernelPath) => {
  try {
    const p = String(kernelPath || '').trim();
    if (p) {
      fs.writeFileSync(customKernelFile, p, 'utf8');
      process.env.LFB_CHROMIUM_EXECUTABLE = p;
    } else {
      if (fs.existsSync(customKernelFile)) {
        fs.unlinkSync(customKernelFile);
      }
      delete process.env.LFB_CHROMIUM_EXECUTABLE;
      applyChromiumEnv();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 3. 读取已持久化保存的自定义内核路径
handle('settings:get-kernel', async () => {
  try {
    if (fs.existsSync(customKernelFile)) {
      return fs.readFileSync(customKernelFile, 'utf8').trim();
    }
    return '';
  } catch {
    return '';
  }
});
