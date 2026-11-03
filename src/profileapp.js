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

async function ensureProfileApp(dataDir, profile, executable) {
  // 1. Windows 分支：直接透传 Playwright 纯净内核路径，彻底杜绝复制产生的旧版图标关联
  if (process.platform === 'win32') {
    return executable;
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
