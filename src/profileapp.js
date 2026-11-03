'use strict';
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').execFile);
const Jimp = require('jimp');
const pngToIco = require('png-to-ico');
const { privateDirectory, writeJSON, readJSON } = require('./privatefiles');

function findAppBundle(executable) {
  const end = executable.indexOf('.app/');
  return end < 0 ? null : executable.slice(0, end + 4);
}

function appsRoot(dataDir) { return path.join(dataDir, 'browsers', 'apps'); }

/**
 * 动态合成带编号徽标的 Windows .ico 图标
 */
async function generateBadgeIco(baseIconPngPath, outputIcoPath, sequence) {
  const image = await Jimp.read(baseIconPngPath);
  image.resize(256, 256);

  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const text = String(sequence);

  // 绘制右下角红色圆形角标背景
  const badgeRadius = 38;
  const badgeCenterX = 256 - badgeRadius - 6;
  const badgeCenterY = 256 - badgeRadius - 6;

  image.scan(badgeCenterX - badgeRadius, badgeCenterY - badgeRadius, badgeRadius * 2, badgeRadius * 2, function (x, y, idx) {
    const dx = x - badgeCenterX;
    const dy = y - badgeCenterY;
    if (dx * dx + dy * dy <= badgeRadius * badgeRadius) {
      this.bitmap.data[idx] = 230;     // R
      this.bitmap.data[idx + 1] = 45;  // G
      this.bitmap.data[idx + 2] = 45;  // B
      this.bitmap.data[idx + 3] = 255; // Alpha
    }
  });

  // 居中打印数字编号
  const textWidth = Jimp.measureText(font, text);
  const textHeight = Jimp.measureTextHeight(font, text);
  const textX = badgeCenterX - Math.floor(textWidth / 2);
  const textY = badgeCenterY - Math.floor(textHeight / 2);

  image.print(font, textX, textY, text);

  // 导出为 PNG Buffer 并转换为 Windows .ico
  const pngBuffer = await image.getBufferAsync(Jimp.MIME_PNG);
  const icoBuffer = await pngToIco(pngBuffer);
  fs.writeFileSync(outputIcoPath, icoBuffer);
}

/**
 * Windows 下处理独立环境图标与快捷方式
 */
async function ensureWindowsProfileApp(dataDir, profile, executable) {
  const root = appsRoot(dataDir);
  privateDirectory(root);

  const basePngPath = path.resolve(__dirname, '../electron/assets/icon.png');
  const defaultIcoPath = path.resolve(__dirname, '../electron/assets/icon.ico');
  const customIcoPath = path.join(root, `ikun-${profile.sequence || profile.id}.ico`);
  const profileLnkPath = path.join(root, `ikun-profile-${profile.id}.lnk`);

  // 如果专属带编号图标不存在且底图存在，动态绘制
  if (!fs.existsSync(customIcoPath) && fs.existsSync(basePngPath)) {
    try {
      await generateBadgeIco(basePngPath, customIcoPath, profile.sequence || profile.id);
    } catch (_) {}
  }

  const finalIconPath = fs.existsSync(customIcoPath) ? customIcoPath : defaultIcoPath;

  // 使用 PowerShell 生成带专属图标的 Windows 快捷方式，引导任务栏识别
  if (fs.existsSync(finalIconPath)) {
    try {
      const psScript = `
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut('${profileLnkPath.replace(/'/g, "''")}')
        $Shortcut.TargetPath = '${executable.replace(/'/g, "''")}'
        $Shortcut.IconLocation = '${finalIconPath.replace(/'/g, "''")}, 0'
        $Shortcut.Save()
      `;
      await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], { timeout: 15000 });
    } catch (_) {}
  }

  return executable;
}

async function ensureProfileApp(dataDir, profile, executable) {
  // 1. Windows 分支
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
