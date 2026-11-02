'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { app } = require('electron');

const REPO = 'ikunjntmei/ikunkun';
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

function get(url, file) {
  return new Promise((resolve, reject) => {
    const out = file && fs.createWriteStream(file);
    https.get(url, { headers: { 'User-Agent': 'IKUN', Accept: 'application/vnd.github+json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { out?.close(); if (file) fs.rmSync(file, { force: true }); return get(res.headers.location, file).then(resolve, reject); }
      if (res.statusCode !== 200) { out?.close(); if (file) fs.rmSync(file, { force: true }); return reject(new Error(`更新服务器返回 ${res.statusCode}`)); }
      if (!out) { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString())); }
      else { res.on('data', c => out.bytes = (out.bytes || 0) + c.length); res.pipe(out); out.on('finish', () => resolve()); }
    }).on('error', reject).setTimeout(120000, function () { this.destroy(new Error('检查更新超时')); });
  });
}

async function checkUpdate() {
  const current = app.getVersion();
  const release = JSON.parse(await get(`https://api.github.com/repos/${REPO}/releases/latest`));
  const version = release.tag_name?.replace(/^v/, '');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('更新版本格式无效');
  const dmg = release.assets?.find(a => a.name === `IKUN-${version}-mac-arm64.dmg`);
  const sums = release.assets?.find(a => a.name === 'SHA256SUMS.txt');
  if (!dmg || !sums) throw new Error('最新版本缺少安装包或校验文件');
  return { current, latest: version, available: compare(version, current) > 0, url: release.html_url, dmgUrl: dmg.browser_download_url, checksumUrl: sums.browser_download_url };
}

async function installUpdate() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !app.isPackaged) throw new Error('在线更新仅支持已安装的 Apple 芯片版 IKUN');
  const info = await checkUpdate();
  if (!info.available) return info;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ikun-update-'));
  const dmg = path.join(dir, 'update.dmg');
  await get(info.checksumUrl);
  const expected = (await get(info.checksumUrl)).match(/^([a-f0-9]{64})\s+IKUN-[0-9.]+-mac-arm64\.dmg$/m)?.[1];
  if (!expected) throw new Error('更新校验文件无效');
  await get(info.dmgUrl, dmg);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
  if (actual !== expected) throw new Error('更新文件校验失败');
  const mount = path.join(dir, 'mount');
  fs.mkdirSync(mount);
  await new Promise((resolve, reject) => execFile('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], e => e ? reject(new Error('无法打开更新镜像')) : resolve()));
  const source = path.join(mount, 'IKUN.app');
  if (!fs.existsSync(source)) throw new Error('更新镜像中缺少 IKUN');
  const target = '/Applications/IKUN.app';
  const staging = '/Applications/IKUN.app.update';
  const script = `rm -rf ${JSON.stringify(staging)} && cp -R ${JSON.stringify(source)} ${JSON.stringify(staging)} && rm -rf ${JSON.stringify(target)} && mv ${JSON.stringify(staging)} ${JSON.stringify(target)}`;
  await new Promise((resolve, reject) => execFile('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(script)} with administrator privileges`], e => e ? reject(new Error('更新安装已取消或权限不足')) : resolve()));
  app.relaunch({ execPath: path.join(target, 'Contents/MacOS/IKUN') });
  app.exit(0);
}

module.exports = { checkUpdate, installUpdate };
