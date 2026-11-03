'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').execFile);
const { privateDirectory, writeJSON, readJSON } = require('./privatefiles');

function findAppBundle(executable) {
  const end = executable.indexOf('.app/');
  return end < 0 ? null : executable.slice(0, end + 4);
}

function appsRoot(dataDir) { return path.join(dataDir, 'browsers', 'apps'); }

/**
 * Windows 下生成彻底脱离 Chrome 标识的独立启动器（实现无图标/白纸图标状态）
 */
async function ensureWindowsProfileApp(dataDir, profile, executable) {
  try {
    if (!executable || !fs.existsSync(executable)) return executable;

    const root = appsRoot(dataDir);
    privateDirectory(root);

    // 为每个环境创建独立的隔离容器目录，切断与原 chrome 目录元数据的关联
    const profileAppDir = path.join(root, `win-profile-${profile.id || profile.sequence || 'default'}`);
    privateDirectory(profileAppDir);

    const isolatedLauncher = path.join(profileAppDir, 'core-browser.exe');

    // 1. 如果尚未生成独立执行文件，进行复制创建（避免硬链接共享文件元数据与图标流）
    if (!fs.existsSync(isolatedLauncher)) {
      try {
        fs.copyFileSync(executable, isolatedLauncher);
      } catch (_) {
        return executable;
      }
    }

    // 2. 核心：阻断与覆盖 Windows 视觉元素清单（VisualElementsManifest）
    // 很多时候任务栏死咬 Chrome 彩色图标，就是因为原目录下的 chrome.VisualElementsManifest.xml
    // 在这里写入一个空的清单，切断任务栏对 Google 官方图标素材的追溯，退化为无图标/纯净状态
    const manifestFile = path.join(profileAppDir, 'core-browser.VisualElementsManifest.xml');
    if (!fs.existsSync(manifestFile)) {
      try {
        const dummyManifest = `<?xml version="1.0" encoding="utf-8"?>
<Application xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <VisualElements ShowNameOnSquare150x150Logo="on" Square150x150Logo="" Square70x70Logo="" ForegroundText="light" BackgroundColor="#ffffff"/>
</Application>`;
        fs.writeFileSync(manifestFile, dummyManifest, 'utf8');
      } catch (_) {}
    }

    return isolatedLauncher;
  } catch (_) {
    return executable;
  }
}

async function ensureProfileApp(dataDir, profile, executable) {
  // 1. Windows 分支：返回去 Chrome 标识的独立启动器，恢复无图标白纸状态
  if (process.platform === 'win32') {
    return ensureWindowsProfileApp(dataDir, profile, executable);
  }

  // 2. macOS 分支
  if (process.platform !== 'darwin') return executable;
  const source = findAppBundle(executable);
  if (!source) return executable;
  const root = appsRoot(dataDir); privateDirectory(root);

  const destination = path.join(root, `IKUN-${profile.sequence}-${profile.id}.app`);
  const relative = path.relative(source, executable);
  const sourceStat = fs.statSync(executable);
  const identity = { source, size: sourceStat.size, mtime: sourceStat.mtimeMs, sequence: profile.sequence, revision: 3 };
  const marker = destination + '.json';
  if (JSON.stringify(readJSON(marker, null)) === JSON.stringify(identity) && fs.existsSync(path.join(destination, relative))) return path.join(destination, relative);
  const temporary = fs.mkdtempSync(path.join(root, '.profile-'));
  const bundle = path.join(temporary, path.basename(destination));
  try {
    try { await exec('/bin/cp', ['-cR', source, bundle], { timeout: 120000 }); }
    catch { fs.rmSync(bundle, { recursive: true, force: true }); await exec('/usr/bin/ditto', [source, bundle], { timeout: 120000 }); }
    const plist = path.join(bundle, 'Contents', 'Info.plist');

    const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
    const originalInfo = JSON.parse(stdout);
    for (const key of ['CFBundleIconName', 'CFBundleIcons', 'CFBundleIcons~ipad']) {
      if (Object.hasOwn(originalInfo, key)) await exec('/usr/bin/plutil', ['-remove', key, plist]);
    }

    for (const [key, value] of Object.entries({
      CFBundleIdentifier: `local.ikun.browser.${profile.id}`,
      CFBundleName: `IKUN #${profile.sequence}`,
      CFBundleDisplayName: `IKUN #${profile.sequence}`,
      CFBundleIconFile: 'ikun-profile.icns'
    })) {
      await exec('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
    }
    const png = path.join(temporary, 'icon.png');
    const baseIcon = path.join(temporary, 'base.png');

    fs.writeFileSync(baseIcon, fs.readFileSync(path.join(__dirname, '../electron/assets/icon.png')));
    const script = fs.readFileSync(path.join(__dirname, '../electron/profile-icon.js'), 'utf8');
    await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, baseIcon, String(profile.sequence), png], { timeout: 30000 });
    const iconset = path.join(temporary, 'profile.iconset'); fs.mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
      await exec('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), png, '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
    }

    await exec('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(bundle, 'Contents/Resources/ikun-profile.icns')]);
    await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', bundle], { timeout: 120000 });
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30000 });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(bundle, destination);
    writeJSON(marker, identity);
    return path.join(destination, relative);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { ensureProfileApp, findAppBundle, appsRoot };
