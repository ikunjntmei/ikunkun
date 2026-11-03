'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const exec = promisify(execFile);
const { privateDirectory, writePrivate } = require('../src/privatefiles');
const inProgress = new Map();

function chromiumEntry() {
  const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
  return JSON.parse(fs.readFileSync(file)).browsers.find(b => b.name === 'chromium');
}

function vanillaPlatform() {
  const platform = {
    'darwin-arm64': 'mac-arm64',
    'darwin-x64': 'mac',
    'linux-x64': 'linux',
    'win32-x64': 'win64'
  }[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error('不支持此平台的 Chromium 下载');
  return platform;
}

// 切换为官方开源纯净 Chromium（Vanilla 构建包，彻底去除谷歌商标）
function downloadUrl() {
  const host = process.env.PLAYWRIGHT_DOWNLOAD_HOST || 'https://playwright.azureedge.net';
  const platform = vanillaPlatform();
  const revision = chromiumEntry().revision;
  return `${host}/builds/chromium/${revision}/chromium-${platform}.zip`;
}

function browserRoot(dir) { return path.join(dir, 'browsers'); }
function executableMarker(dir) { return path.join(browserRoot(dir), 'chromium-executable.txt'); }

async function chromiumStatus(dir) {
  const entry = chromiumEntry();
  const targetRevision = entry.revision;
  try {
    let executable = null;
    const marker = executableMarker(dir);

    if (fs.existsSync(marker)) {
      executable = fs.readFileSync(marker, 'utf8').trim();
    } else if (process.env.LFB_CHROMIUM_EXECUTABLE && fs.existsSync(process.env.LFB_CHROMIUM_EXECUTABLE)) {
      executable = process.env.LFB_CHROMIUM_EXECUTABLE;
    } else if (process.platform === 'win32') {
      const candidates = [
        path.join(dir, 'chromium', 'chrome.exe'),
        path.join(dir, `chromium-${targetRevision}`, 'chrome.exe'),
        path.join(browserRoot(dir), 'chromium', 'chrome.exe'),
        path.join(browserRoot(dir), `chromium-${targetRevision}`, 'chrome.exe')
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          executable = cand;
          privateDirectory(browserRoot(dir));
          writePrivate(marker, executable + '\n');
          break;
        }
      }
    }

    if (executable && fs.existsSync(executable)) {
      return { installed: true, executable, version: targetRevision, targetVersion: targetRevision, updateAvailable: false };
    }
  } catch { /* not installed or unusable */ }
  return { installed: false, executable: null, version: null, targetVersion: targetRevision, updateAvailable: true };
}

async function downloadFile(url, dest, onProgress, redirects = 0) {
  if (redirects > 5 || new URL(url).protocol !== 'https:') throw new Error('内核下载必须使用 HTTPS，且不能无限重定向');
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'IKUN' } }, resolve);
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('内核下载超时')));
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    return downloadFile(new URL(response.headers.location, url).href, dest, onProgress, redirects + 1);
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error(`内核下载失败：HTTP ${response.statusCode}`); }
  const total = Number(response.headers['content-length']) || 0;
  let done = 0;
  response.on('data', chunk => {
    done += chunk.length;
    if (done > 1024 * 1024 * 1024) response.destroy(new Error('内核安装包异常过大'));
    onProgress?.({ done, total, pct: total ? Math.round(done / total * 100) : 0 });
  });
  await pipeline(response, fs.createWriteStream(dest, { flags: 'w' }));
}

function findExecutable(root) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.endsWith('.app')) {
        const macos = path.join(full, 'Contents', 'MacOS');
        return path.join(macos, fs.readdirSync(macos).find(n => !n.startsWith('.')));
      }
      const found = findExecutable(full); if (found) return found;
    } else if (e.isFile() && ((process.platform === 'linux' && e.name === 'chrome') || (process.platform === 'win32' && e.name.toLowerCase() === 'chrome.exe'))) {
      return full;
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function install(dir, onProgress) {
  const status = await chromiumStatus(dir);
  if (status.installed && !status.updateAvailable) return status.executable;
  privateDirectory(browserRoot(dir));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ikun-chromium-'));
  const staging = fs.mkdtempSync(path.join(browserRoot(dir), '.install-'));
  let renameSuccess = false;

  try {
    const zip = path.join(tmp, 'chromium.zip');
    await downloadFile(downloadUrl(), zip, onProgress);

    if (process.platform === 'win32') {
      await exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${staging}' -Force`
      ], { timeout: 600000 });
    } else {
      await exec('/usr/bin/unzip', ['-q', zip, '-d', staging], { timeout: 600000 });
    }

    const executable = findExecutable(staging);
    if (!executable) throw new Error('安装包中没有纯净版 Chromium');

    // 清除可能存在的 Windows 图标映射清单
    if (process.platform === 'win32') {
      const manifest = path.join(path.dirname(executable), 'chrome.VisualElementsManifest.xml');
      if (fs.existsSync(manifest)) {
        try { fs.unlinkSync(manifest); } catch (_) {}
      }
      await sleep(300);
    }

    const entry = chromiumEntry();
    const suffix = path.basename(staging).replace(/^\.install-?/, '') || Date.now().toString(36);
    const destination = path.join(browserRoot(dir), `chromium-${entry.revision}-${suffix}`);
    const relative = path.relative(staging, executable);

    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(staging, destination);
        renameSuccess = true;
        break;
      } catch (err) {
        if (i === 4 || process.platform !== 'win32') throw err;
        await sleep(500);
      }
    }

    const final = path.join(destination, relative);
    writePrivate(executableMarker(dir), final + '\n');
    onProgress?.({ done: 1, total: 1, pct: 100 });
    return final;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!renameSuccess) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

async function downloadChromium(dir, onProgress) {
  if (inProgress.has(dir)) return inProgress.get(dir);
  const promise = install(dir, onProgress);
  inProgress.set(dir, promise);
  try { return await promise; } finally { inProgress.delete(dir); }
}

module.exports = { chromiumStatus, downloadChromium, downloadUrl, executableMarker, browserRoot };
