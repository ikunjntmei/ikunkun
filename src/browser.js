'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { chromium} = require('playwright');
const { buildContextOptions, webrtcArgs, validateProfile} = require('./fingerprint');
const { resolveProxy, inlineRecord} = require('./proxyconfig');
const { ProxyStore} = require('./proxystore');
const { checkProxy} = require('./proxycheck');
const { privateDirectory} = require('./privatefiles');
const { prepareDownloads, configureDownloads} = require('./downloads');

function findFreePort(min, max) {
return new Promise((resolve, reject) => {
let port = min;
const next = () => {
if (port > max) return reject(new Error('no free debug port'));
const s = net.createServer();
s.once('error', () => { port++; next();});
s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
};
next();
});
}

function isForbiddenBrowser(filePath) {
if (!filePath || typeof filePath!== 'string') return true;
const p = filePath.toLowerCase();
return p.includes('edge') || p.includes('msedge') || p.includes('google\\chrome') || p.includes('google/chrome');
}

function resolveCleanExecutable(dataDir) {
const customKernelFile = path.join(dataDir, 'custom_kernel.txt');
if (fs.existsSync(customKernelFile)) {
const customExe = fs.readFileSync(customKernelFile, 'utf8').trim();
if (customExe && fs.existsSync(customExe) &&!isForbiddenBrowser(customExe)) {
return customExe;
}
}

const marker = path.join(dataDir, 'browsers', 'chromium-executable.txt');
if (fs.existsSync(marker)) {
const exe = fs.readFileSync(marker, 'utf8').trim();
if (exe && fs.existsSync(exe) &&!isForbiddenBrowser(exe)) {
return exe;
}
}

const bundledPath = path.join(dataDir, 'browsers', 'chromium-1148', 'chrome.exe');
if (fs.existsSync(bundledPath) &&!isForbiddenBrowser(bundledPath)) {
return bundledPath;
}

const browsersDir = path.join(dataDir, 'browsers');
if (fs.existsSync(browsersDir)) {
try {
for (const item of fs.readdirSync(browsersDir)) {
if (item.startsWith('chromium-1148')) {
const p1 = path.join(browsersDir, item, 'chrome.exe');
const p2 = path.join(browsersDir, item, 'chrome-win', 'chrome.exe');
if (fs.existsSync(p1) &&!isForbiddenBrowser(p1)) return p1;
if (fs.existsSync(p2) &&!isForbiddenBrowser(p2)) return p2;
}
}
} catch (_) {}
}

return null;
}

class BrowserManager {
constructor(store, proxyStore = null, settings = null, options = {}) {
this.store = store;
this.proxyStore = proxyStore;
this.settings = settings;
this.downloadsDirectory = options.downloadsDirectory;
this.checkProxy = options.checkProxy || checkProxy;
this.sessions = new Map();
this.opening = new Map();
this.closing = new Map();
this.cancelled = new Set();
this.startPage = options.startPage!== false;
this.profileIcons = options.profileIcons!== false;
}

isOpen(id) { return this.sessions.has(id) || this.opening.has(id);}

listOpen() {
return [...this.sessions].map(([id, s]) => ({
profile_id: id,
...(s.debugPort? { debug_url: `http://127.0.0.1:${s.debugPort}`}: {}),
headless: s.headless,
opened_at: new Date(s.openedAt).toISOString(),
network: s.network
}));
}

async open(id, options = {}) {
if (this.closing.has(id)) await this.closing.get(id);
if (this.opening.has(id)) return this.opening.get(id);
this.cancelled.delete(id);
const pending = this._open(id, options);
this.opening.set(id, pending);
try { return await pending;} finally { this.opening.delete(id);}
}

async _open(id, { headless = false} = {}) {
if (typeof headless!== 'boolean') throw Object.assign(new Error('headless 必须为布尔值'), { status: 400});
if (this.sessions.has(id)) return { profile_id: id, open: true, reused: true,...this.listOpen().find(s => s.profile_id === id)};
const profile = this.store.get(id);
if (!profile) throw Object.assign(new Error('环境不存在'), { status: 404});
validateProfile(profile);

const checkCancelled = () => { if (this.cancelled.has(id)) throw Object.assign(new Error('环境启动已取消'), { status: 409});};
let proxyRecord = resolveProxy(profile, this.proxyStore);
const useSystemProxy = this.settings?.get().socksViaSystemProxy === true;
if (!proxyRecord && useSystemProxy) {
const route = await this.settings.route();
proxyRecord = inlineRecord({ server: `${route.scheme}://${route.host.includes(':')? `[${route.host}]`: route.host}:${route.port}`});
}

const effective = {...profile};
let network = { route: proxyRecord? 'proxy': 'system', exitIp: null};

if (proxyRecord) {
const result = await this.checkProxy(proxyRecord, this.settings);
checkCancelled();
const current = this.store.get(id);
if (!current || current.updatedAt!== profile.updatedAt ||
((profile.proxyId || profile.proxy) && JSON.stringify(resolveProxy(current, this.proxyStore))!== JSON.stringify(proxyRecord))) {
throw Object.assign(new Error('环境或代理在检测期间发生变化，请重试'), { status: 409});
}
if (profile.proxyId) this.proxyStore.setCheckResult(profile.proxyId, result);
if (result.status!== 'ok') throw Object.assign(new Error(result.error || '代理连接失败，已阻止启动'), { status: 502});
if (profile.timezone === 'auto') {
if (!result.timezone) throw Object.assign(new Error('代理出口时区未知，请重新检测或手动选择时区；不会回退到本机时区'), { status: 409});
effective.timezone = result.timezone;
}
if (profile.locale === 'auto') {
const { localeForCountry} = require('./localemap');
if (!result.countryCode) throw Object.assign(new Error('代理出口地区未知，请重新检测或手动选择语言'), { status: 409});
effective.locale = localeForCountry(result.countryCode);
if (!effective.locale) throw Object.assign(new Error('没有此代理地区的语言映射，请手动选择语言'), { status: 409});
}
network = { route: 'proxy', exitIp: result.exitIp, checkedAt: new Date().toISOString(), timezone: effective.timezone, locale: effective.locale};
}

let proxy = proxyRecord? ProxyStore.toPlaywright(proxyRecord): null;
let forwarder, context;

try {
if (proxyRecord?.type === 'socks5' && (proxyRecord.username || proxyRecord.password || useSystemProxy)) {
const { SocksForwarder} = require('./socksfwd');
const systemProxy = useSystemProxy? await this.settings.route(proxyRecord.host, proxyRecord.port): null;
forwarder = await SocksForwarder.start({...proxyRecord, systemProxy});
proxy = { server: `http://127.0.0.1:${forwarder.port}`, bypass: '127.0.0.1,localhost,<-loopback>'};
} else if (proxy) {
proxy.bypass = '127.0.0.1,localhost,<-loopback>';
}

const { options} = buildContextOptions({...effective, proxy});
const debugPort = await findFreePort(4550, 4599);

const targetExecutable = resolveCleanExecutable(this.store.dataDir);
if (!targetExecutable || isForbiddenBrowser(targetExecutable)) {
throw new Error(`致命错误：当前未能成功定位 1148 纯净版 Chromium 内核。请点击软件中的“下载 Chromium”进行安装！`);
}

const directory = this.store.profileDir(id);
privateDirectory(directory);
await prepareDownloads(directory, this.downloadsDirectory);

const launchOptions = {
...options,
headless,
executablePath: targetExecutable,
locale: effective.locale && effective.locale!== 'auto'? effective.locale: undefined,
timezoneId: effective.timezone && effective.timezone!== 'auto'? effective.timezone: undefined,
chromiumSandbox: false,
// 加回自动化开关忽略：--enable-automation 本身就是 bot 信号，上一版删掉它是倒退
ignoreDefaultArgs: ['--enable-automation', '--test-type'],
// 上一版的 devtools: true 已删除：启动就打开开发者工具会被检测站直接抓到
args: [
// 注意：不要在这里加 --user-data-dir，目录由 launchPersistentContext 的首参数接管
'--no-first-run',
'--no-default-browser-check',
'--site-per-process',
'--disable-background-mode',
'--disable-blink-features=AutomationControlled',
'--exclude-switches=enable-automation',
'--disable-infobars',
'--enforce-webrtc-ip-permission-check',
'--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
'--proxy-bypass-list=127.0.0.1,localhost,<-loopback>',
'--no-sandbox',
'--disable-setuid-sandbox',
// 删掉 --disable-gpu / --disable-software-rasterizer / --disable-accelerated-2d-canvas：
// 这组参数会让 WebGL 退到 SwiftShader 软渲染，是很典型的自动化特征。
// 前提是机器有可用显卡（核显也算）；如果是无显卡的机器起不来，再把这组加回去。
'--disable-dev-shm-usage',
'--disable-gpu-sandbox',
'--disable-breakpad',
`--remote-debugging-port=${debugPort}`,
'--remote-debugging-address=127.0.0.1',
`--class=ikun_app_${profile.id}`,
`--app-user-model-id=ikun.profile.app.${profile.id}`,
...(effective.locale && effective.locale!== 'auto'? [`--lang=${effective.locale}`, `--accept-lang=${effective.locale}`]: []),
...webrtcArgs({...effective, proxy: proxy || useSystemProxy || profile.webrtc === 'auto'}),
],
};

checkCancelled();

console.log('[启动] 内核:', targetExecutable);
console.log('[启动] 环境目录:', directory, '调试端口:', debugPort);
context = await chromium.launchPersistentContext(directory, launchOptions);

// webdriver 与语言改到 Navigator.prototype 上，并把值改回标准值：
// 正常浏览器 navigator.webdriver 是 false，不是 undefined；挂在实例上会被 hasOwnProperty 查出来，
// 挂在原型上则和原生布局一致。getter 的 toString 也做了 native 伪装（只能防初级检查）。
await context.addInitScript((loc) => {
try {
const maskGetter = (fn, name) => {
try { fn.toString = () => `function get ${name}() { [native code]}`;} catch (_) {}
return fn;
};
Object.defineProperty(Navigator.prototype, 'webdriver', {
get: maskGetter(() => false, 'webdriver'),
configurable: true
});

if (loc && loc!== 'auto') {
const shortLoc = loc.split('-')[0];
const languagesList = Array.from(new Set([loc, shortLoc, 'en-US', 'en']));
Object.defineProperty(Navigator.prototype, 'language', {
get: maskGetter(() => loc, 'language'),
configurable: true
});
Object.defineProperty(Navigator.prototype, 'languages', {
get: maskGetter(() => languagesList, 'languages'),
configurable: true
});
}
} catch (_) {}
}, effective.locale);

if (profile.canvasMode!== 'off') {
const seedValue = typeof profile.id === 'string'
? profile.id.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0)
: (Number(profile.id) || 12345);

await context.addInitScript((seed) => {
try {
const shiftR = (seed % 3) - 1;
const shiftG = ((seed * 3) % 3) - 1;
const shiftB = ((seed * 7) % 3) - 1;

// 被替换的函数加 native toString 伪装：检测站直接调 fn.toString() 时看到的是原生字样。
// 注意：这只能防初级检查，Function.prototype.toString.call(fn) 这种查法是绕不过去的。
const maskFn = (fn, name) => {
try { fn.toString = () => `function ${name}() { [native code]}`;} catch (_) {}
};

const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData = function(...args) {
const imageData = originalGetImageData.apply(this, args);
const data = imageData.data;
for (let i = 0; i < data.length; i += 4) {
data[i] = Math.max(0, Math.min(255, data[i] + shiftR));
data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + shiftG));
data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + shiftB));
}
return imageData;
};
maskFn(CanvasRenderingContext2D.prototype.getImageData, 'getImageData');

const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(...args) {
// 上一版是 getImageData（带噪声）再 putImageData 写回原画布：
// 每次调用都多叠一层噪声，还永久污染原画布，多次读取结果都不一样，这本身就是“不一致”。
// 改成在临时画布上做噪声，原画布不动，多次读取结果稳定。
try {
if (this.width > 0 && this.height > 0) {
const tmp = document.createElement('canvas');
tmp.width = this.width;
tmp.height = this.height;
const tctx = tmp.getContext('2d');
if (tctx) {
tctx.drawImage(this, 0, 0);
const imgData = tctx.getImageData(0, 0, tmp.width, tmp.height);
tctx.putImageData(imgData, 0, 0);
return originalToDataURL.apply(tmp, args);
}
}
} catch (_) {}
return originalToDataURL.apply(this, args);
};
maskFn(HTMLCanvasElement.prototype.toDataURL, 'toDataURL');

const hookWebGLReadPixels = (proto) => {
const origReadPixels = proto.readPixels;
proto.readPixels = function(x, y, width, height, format, type, pixels) {
origReadPixels.apply(this, arguments);
if (pixels instanceof Uint8Array && pixels.length >= 4) {
for (let i = 0; i < pixels.length; i += 4) {
pixels[i] = Math.max(0, Math.min(255, pixels[i] + shiftR));
pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + shiftG));
pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + shiftB));
}
}
};
maskFn(proto.readPixels, 'readPixels');
};

if (window.WebGLRenderingContext) hookWebGLReadPixels(WebGLRenderingContext.prototype);
// 原代码写的是不存在的 WebGL2RenderingContext2D，会被 try/catch 吃掉导致 WebGL2 没 hook 上
if (window.WebGL2RenderingContext) hookWebGLReadPixels(WebGL2RenderingContext.prototype);

const audioOffset = ((seed % 10) + 1) * 0.0000001;
const hookAudioBuffer = (proto) => {
const origGetChannelData = proto.getChannelData;
proto.getChannelData = function(channel) {
const data = origGetChannelData.apply(this, arguments);
for (let i = 0; i < data.length; i += 100) {
data[i] = data[i] + audioOffset;
}
return data;
};
maskFn(proto.getChannelData, 'getChannelData');
};

if (window.AudioBuffer) hookAudioBuffer(AudioBuffer.prototype);

} catch (_) {}
}, seedValue);
}

// UA 与 userAgentData 对齐：截图里 UA 是 131.0.6778.33，检测站却认成 131.0.0.0，
// 就是因为 UA 字符串和 userAgentData 的品牌版本对不上。用 CDP 给每个页面下发同一套品牌信息。
// 注意：platformVersion 不硬编码，留空让它用真实值，避免和真实系统对不上又多一处不一致。
const alignUA = async (page) => {
try {
const uaString = launchOptions.userAgent || options.userAgent;
if (!uaString) return;
const ver = (uaString.match(/Chrome\/([\d.]+)/) || [])[1];
if (!ver) return;
const major = ver.split('.')[0];
const platform = /Windows/.test(uaString)? 'Windows'
: /Macintosh/.test(uaString)? 'macOS'
: /Linux/.test(uaString)? 'Linux': undefined;
const metadata = {
brands: [
{ brand: 'Google Chrome', version: major},
{ brand: 'Chromium', version: major},
{ brand: 'Not-A.Brand', version: '99'},
],
fullVersionList: [
{ brand: 'Google Chrome', version: ver},
{ brand: 'Chromium', version: ver},
{ brand: 'Not-A.Brand', version: '99.0.0.0'},
],
fullVersion: ver,
architecture: 'x86',
bitness: '64',
mobile: false,
};
if (platform) metadata.platform = platform;
const params = { userAgent: uaString, userAgentMetadata: metadata};
if (effective.locale && effective.locale!== 'auto') params.acceptLanguage = effective.locale;
const session = await context.newCDPSession(page);
await session.send('Emulation.setUserAgentOverride', params);
} catch (_) {}
};
context.on('page', alignUA);
for (const page of context.pages()) alignUA(page);

await configureDownloads(context);
checkCancelled();

const session = { context, debugPort, headless, openedAt: Date.now(), forwarder, network};
this.sessions.set(id, session);

context.on('close', () => {
if (this.sessions.get(id) === session) this.sessions.delete(id);
forwarder?.stop().catch(() => {});
});

const watchPage = page => page.on('close', () => {
if (!context.pages().some(p =>!p.isClosed()) && this.sessions.get(id) === session) {
this.close(id).catch(() => {});
}
});

context.on('page', watchPage);
for (const page of context.pages()) watchPage(page);

if (!headless && this.startPage) {
await require('./startpage').openStartPage(context, profile, network, ip => {
if (this.sessions.get(id)!== session) return;
session.network = {...session.network, exitIp: ip, checkedAt: new Date().toISOString()};
this.store.recordNetwork(id, session.network);
});
}

checkCancelled();
this.store.recordOpened(id, session.network);
return {
profile_id: id,
open: true,
reused: false,
headless,
network,
...(debugPort? { debug_url: `http://127.0.0.1:${debugPort}`}: {})
};
} catch (error) {
console.error('[环境启动失败捕获] 错误详情:', error);
await context?.close().catch(() => {});
await forwarder?.stop().catch(() => {});
throw error;
}
}

async close(id) {
if (this.closing.has(id)) return this.closing.get(id);
this.cancelled.add(id);
const pending = (async () => {
await this.opening.get(id)?.catch(() => {});
const session = this.sessions.get(id);
if (session) {
await session.context.close();
await session.forwarder?.stop();
if (this.sessions.get(id) === session) this.sessions.delete(id);
}
return { profile_id: id, open: false};
})();
this.closing.set(id, pending);
try { return await pending;} finally { this.closing.delete(id); this.cancelled.delete(id);}
}

async closeAll() {
const ids = [...new Set([...this.opening.keys(),...this.sessions.keys()])];
await Promise.all(ids.map(id => this.close(id)));
return { closed: ids.length};
}

getContext(id) { return this.sessions.get(id)?.context || null;}
}

module.exports = { BrowserManager};
