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
ignoreDefaultArgs: ['--enable-automation', '--test-type'],
args: [
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

// 上一版的“防崩溃保护”点击拦截器已删掉，原因：
// 1) Playwright 的 addInitScript 根本跑不到 chrome://、edge:// 这类特权页面上，
// 所以它对内部页面起不到任何保护作用；
// 2) 它反而会在 about:blank 页（新标签页、弹窗初始页）上把新标签页链接改成当前页跳转，
// 属于纯副作用。内部页面的真正保护是下面 alignUA 里跳过非 http(s) 页面，本来就有了。
// 浏览器进程退出时打一条日志，帮你区分“浏览器进程没了”还是“软件自己关了环境”。
try {
const browserObj = context.browser();
browserObj?.on('disconnected', () => console.log('[浏览器进程已退出] 环境:', id));
} catch (_) {}

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

const maskFn = (fn, name) => {
try { fn.toString = () => `function ${name}() { [native code]}`;} catch (_) {}
};

// 钩子里的“原生调用”放在 try 外面：原生报错（比如跨域画布）照常抛给页面，
// 不改变浏览器原生行为；只有我们自己的噪声修改包在 try 里，改失败就返回未修改的结果，
// 钩子本身永远不会把页面脚本搞崩。
const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData = function(...args) {
const imageData = originalGetImageData.apply(this, args);
// 大画布跳过噪声：逐像素循环在大画布上又慢又吃内存，
// 是“偶尔在某些页面卡死/崩掉”的典型来源，超过 1600 万像素直接返回原图。
if (imageData.data.length > 64 * 1024 * 1024) return imageData;
try {
const data = imageData.data;
for (let i = 0; i < data.length; i += 4) {
data[i] = Math.max(0, Math.min(255, data[i] + shiftR));
data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + shiftG));
data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + shiftB));
}
} catch (_) {}
return imageData;
};
maskFn(CanvasRenderingContext2D.prototype.getImageData, 'getImageData');

const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(...args) {
try {
if (this.width > 0 && this.height > 0) {
// 大画布不走临时画布路线：同尺寸再建一个画布等于内存翻倍，
// 大画布页面很容易因此 OOM，直接走原生 toDataURL（这次不加噪声，保稳定优先）。
if (this.width * this.height > 16000000) {
return originalToDataURL.apply(this, args);
}
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
// 原生调用放外面，报错照常抛；只有噪声修改包 try，避免钩子自身把页面搞崩。
origReadPixels.apply(this, arguments);
try {
if (pixels instanceof Uint8Array && pixels.length >= 4) {
for (let i = 0; i < pixels.length; i += 4) {
pixels[i] = Math.max(0, Math.min(255, pixels[i] + shiftR));
pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + shiftG));
pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + shiftB));
}
}
} catch (_) {}
};
maskFn(proto.readPixels, 'readPixels');
};

if (window.WebGLRenderingContext) hookWebGLReadPixels(WebGLRenderingContext.prototype);
if (window.WebGL2RenderingContext) hookWebGLReadPixels(WebGL2RenderingContext.prototype);

const audioOffset = ((seed % 10) + 1) * 0.0000001;
const hookAudioBuffer = (proto) => {
const origGetChannelData = proto.getChannelData;
proto.getChannelData = function(channel) {
const data = origGetChannelData.apply(this, arguments);
try {
for (let i = 0; i < data.length; i += 100) {
data[i] = data[i] + audioOffset;
}
} catch (_) {}
return data;
};
maskFn(proto.getChannelData, 'getChannelData');
};

if (window.AudioBuffer) hookAudioBuffer(AudioBuffer.prototype);

} catch (_) {}
}, seedValue);
}

// UA 对齐的回归：上一版只在页面创建时对齐一次，但新标签页、弹窗一开始都是
// about:blank / chrome://newtab，会被 URL 检查跳过，之后导航到正常网站时再也不会对齐。
// 现在改成：每个页面只在第一次成功对齐后标记，创建时和主框架首次导航到 http(s) 时都会尝试，
// 失败不标记，下次导航再重试。失败打一行日志，不再完全静默，否则出问题都看不见。
const alignUA = async (page) => {
try {
if (page.isClosed()) return false;
const url = page.url();
if (!url || (!url.startsWith('http://') &&!url.startsWith('https://'))) {
return false;
}

const current = await page.evaluate(async () => {
const data = await navigator.userAgentData.getHighEntropyValues(
['brands', 'fullVersionList', 'platform', 'platformVersion', 'architecture', 'model', 'mobile', 'bitness']
);
return { ua: navigator.userAgent, data};
});
const uaString = current.ua;
const ver = (uaString.match(/Chrome\/([\d.]+)/) || [])[1];
if (!ver) return false;
const major = ver.split('.')[0];
const brands = [...(current.data.brands || [])];
const fullVersionList = [...(current.data.fullVersionList || [])];
if (!brands.some(b => b.brand === 'Google Chrome')) {
brands.unshift({ brand: 'Google Chrome', version: major});
}
if (!fullVersionList.some(b => b.brand === 'Google Chrome')) {
fullVersionList.unshift({ brand: 'Google Chrome', version: ver});
}
const metadata = {
brands,
fullVersionList,
fullVersion: ver,
platform: current.data.platform,
platformVersion: current.data.platformVersion,
architecture: current.data.architecture,
model: current.data.model,
mobile: current.data.mobile,
bitness: current.data.bitness,
};
const params = { userAgent: uaString, userAgentMetadata: metadata};
if (effective.locale && effective.locale!== 'auto') params.acceptLanguage = effective.locale;
const session = await context.newCDPSession(page);
await session.send('Emulation.setUserAgentOverride', params);
return true;
} catch (err) {
console.log('[UA对齐失败]', err && err.message? err.message: err);
return false;
}
};
const alignedPages = new WeakSet();
const alignPage = async (page) => {
if (alignedPages.has(page)) return;
if (await alignUA(page)) alignedPages.add(page);
};

await configureDownloads(context);
checkCancelled();

const session = { context, debugPort, headless, openedAt: Date.now(), forwarder, network};
this.sessions.set(id, session);

context.on('close', () => {
if (this.sessions.get(id) === session) this.sessions.delete(id);
forwarder?.stop().catch(() => {});
});

// 窗口超出屏幕时自动收进来，不用每个分辨率手动设：
// 超出屏幕的来源有两个：环境里设了固定 viewport（比当前屏幕大），或者 Chromium
// 从 profile 里恢复了上次在大屏上保存的窗口位置。两种都会让窗口比屏幕高，
// 底部固定栏（比如去支付）被顶到屏幕外，页面滚动也救不回来。
// 这里用页面里量到的 CSS 像素（screen.availWidth/Height），和 viewport 单位一致，
// 不受 Windows 缩放比例影响，任何分辨率启动时都会自动收进屏幕。
// 收敛后窗口尺寸和真实屏幕一致，反而更像真机。
let screenAvail = null; // { width, height}，在第一个能量到的页面上量一次
let windowClampLogged = false;
const fitWindowToScreen = async (page) => {
try {
if (page.isClosed()) return;
if (screenAvail) {
// 已经量到屏幕了：只有固定 viewport 的页面才可能再次超高，超了就收。
// viewport 为 null 的页面跟窗口走，窗口前面已经收过了，这里直接跳过。
const vs = page.viewportSize();
if (vs && (vs.width > screenAvail.width - 16 || vs.height > screenAvail.height - 48)) {
const targetW = Math.max(320, Math.min(vs.width, screenAvail.width - 16));
const targetH = Math.max(320, Math.min(vs.height, screenAvail.height - 48));
await page.setViewportSize({ width: targetW, height: targetH});
if (!windowClampLogged) {
windowClampLogged = true;
console.log(`[窗口] 已收进屏幕：${vs.width}x${vs.height} -> ${targetW}x${targetH}`);
}
}
return;
}
// 还没量到屏幕：从当前页面量。chrome:// 这类特权页面量不到会抛错，
// catch 后不标记，下个页面再试，不阻塞启动。
const info = await page.evaluate(() => ({
availW: window.screen.availWidth,
availH: window.screen.availHeight,
innerW: window.innerWidth,
innerH: window.innerHeight,
}));
if (!info.availW ||!info.availH) return;
screenAvail = { width: info.availW, height: info.availH};
const targetW = Math.max(320, Math.min(info.innerW, info.availW - 16));
const targetH = Math.max(320, Math.min(info.innerH, info.availH - 48));
if (targetW < info.innerW || targetH < info.innerH) {
await page.setViewportSize({ width: targetW, height: targetH});
if (!windowClampLogged) {
windowClampLogged = true;
console.log(`[窗口] 已收进屏幕：${info.innerW}x${info.innerH} -> ${targetW}x${targetH}`);
}
}
} catch (_) {}
};

const watchPage = page => {
fitWindowToScreen(page);
page.on('close', () => {
if (!context.pages().some(p =>!p.isClosed()) && this.sessions.get(id) === session) {
this.close(id).catch(() => {});
}
});
// 渲染进程崩溃（标签页变“喔唷，崩溃了”）和浏览器进程退出是两回事，
// 打日志才能分清你遇到的是哪一种。
page.on('crash', () => {
console.log('[页面渲染进程崩溃]', page.url());
});
// 主框架第一次导航到正常网站时补一次 UA 对齐（覆盖 about:blank 起手的标签页）。
page.on('framenavigated', (frame) => {
if (frame.parentFrame()) return;
const url = frame.url();
if (url.startsWith('http://') || url.startsWith('https://')) alignPage(page);
});
};

context.on('page', page => { alignPage(page); watchPage(page);});
for (const page of context.pages()) { alignPage(page); watchPage(page);}

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
