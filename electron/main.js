'use strict';
/**
 * CIKE — Electron shell.
 * Main process starts the local backend (Koa API + profile/browser manager)
 * and hosts the management UI, which talks to the same Local API over HTTP.
 */
const { app, BrowserWindow, ipcMain, shell, session, safeStorage, dialog, clipboard } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const { startBackend, DATA_DIR } = require('../src/server');
const { chromiumStatus, downloadChromium, executableMarker, browserRoot } = require('./chromium');
const { checkUpdate, installUpdate } = require('./updater');

let backend = null;
let mainWindow = null;
const uiFile = path.join(__dirname, 'renderer', 'index.html');
const uiURL = pathToFileURL(uiFile).href;

if (process.env.LFB_DATA) app.setPath('userData', path.join(DATA_DIR, 'desktop'));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });

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
        path.join(DATA_DIR, 'chromium-1148
