'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');
const { buildContextOptions, webrtcArgs, validateProfile } = require('./fingerprint');
const { resolveProxy, inlineRecord } = require('./proxyconfig');
const { ProxyStore } = require('./proxystore');
const { checkProxy } = require('./proxycheck');
const { privateDirectory } = require('./privatefiles');
const { prepareDownloads, configureDownloads } = require('./downloads');

function findFreePort(min, max) {
  return new Promise((resolve, reject) => {
    let port = min;
    const next = () => {
      if (port > max) return reject(new Error('no free debug port'));
      const s = net.createServer();
      s.once('error', () => { port++; next(); });
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
    };
    next();
  });
}

function isForbiddenBrowser(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  const p = filePath.toLowerCase();
  return p.includes('edge') || p.includes('msedge') || p.includes('google\\chrome') || p.includes('google/chrome');
}

function resolveCleanExecutable(dataDir) {
  const customKernelFile = path.join(dataDir, 'custom_kernel.txt');
  if (fs.existsSync(customKernelFile)) {
    const customExe = fs.readFileSync(customKernelFile, 'utf8').trim();
    if (customExe && fs.existsSync(customExe) && !isForbiddenBrowser(customExe)) {
      return customExe;
    }
  }

  const marker = path.join(dataDir, 'browsers', 'chromium-executable.txt');
  if (fs.existsSync(marker)) {
    const exe = fs.readFileSync(marker, 'utf8').trim();
    if (exe && fs.existsSync(exe) && !isForbiddenBrowser(exe)) {
      return exe;
    }
  }

  const bundledPath = path.join(dataDir, 'browsers', 'chromium-1148', 'chrome.exe');
  if (fs.existsSync(bundledPath) && !isForbiddenBrowser(bundledPath)) {
    return bundledPath;
  }

  const browsersDir = path.join(dataDir, 'browsers');
  if (fs.existsSync(browsersDir)) {
    try {
      for (const item of fs.readdirSync(browsersDir)) {
        if (item.startsWith('chromium-1148')) {
          const p1 = path.join(browsersDir, item, 'chrome.exe');
          const p2 = path.join(browsersDir, item, 'chrome-win', 'chrome.exe');
          if (fs.existsSync(p1) && !isForbiddenBrowser(p1)) return p1;
          if (fs.existsSync(p2) && !isForbiddenBrowser(p2)) return p2;
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
    this.startPage = options.startPage !== false;
    this.profileIcons = options.profileIcons !== false;
  }

  isOpen(id) { return this.sessions.has(id) || this.opening.has(id); }

  listOpen() {
    return [...this.sessions].map(([id, s]) => ({
      profile_id: id,
      ...(s.debugPort ? { debug_url: `http://127.0.0.1:${s.debugPort}` } : {}),
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
    try { return await pending; } finally { this.opening.delete(id); }
  }

  async _open(id, { headless = false } = {}) {
    if (typeof headless !== 'boolean') throw Object.assign(new Error('headless 必须为布尔值'), { status: 400 });
    if (this.sessions.has(id)) return { profile_id: id, open: true, reused: true, ...this.listOpen().find(s => s.profile_id === id) };
    const profile = this.store.get(id);
    if (!profile) throw Object.assign(new Error('环境不存在'), { status: 404 });
    validateProfile(profile);

    const checkCancelled = () => { if (this.cancelled.has(id)) throw Object.assign(new Error('环境启动已取消'), { status: 409 }); };
    let proxyRecord = resolveProxy(profile, this.proxyStore);
    const useSystemProxy = this.settings?.get().socksViaSystemProxy === true;
    if (!proxyRecord && useSystemProxy) {
      const route = await this.settings.route();
      proxyRecord = inlineRecord({ server: `${route.scheme}://${route.host.includes(':') ? `[${route.host}]` : route.host}:${route.port}` });
    }

    const effective = { ...profile };
    let network = { route: proxyRecord ? 'proxy' : 'system', exitIp: null };

    if (proxyRecord) {
      const result = await this.checkProxy(proxyRecord, this.settings);
      checkCancelled();
      const current = this.store.get(id);
      if (!current || current.updatedAt !== profile.updatedAt ||
          ((profile.proxyId || profile.proxy) && JSON.stringify(resolveProxy(current, this.proxyStore)) !== JSON.stringify(proxyRecord))) {
        throw Object.assign(new Error('环境或代理在检测期间发生变化，请重试'), { status: 409 });
      }
      if (profile.proxyId) this.proxyStore.setCheckResult(profile.proxyId, result);
      if (result.status !== 'ok') throw Object.assign(new Error(result.error || '代理连接失败，已阻止启动'), { status: 502 });
      if (profile.timezone === 'auto') {
        if (!result.timezone) throw Object.assign(new Error('代理出口时区未知，请重新检测或手动选择时区；不会回退到本机时区'), { status: 409 });
        effective.timezone = result.timezone;
      }
      if (profile.locale === 'auto') {
        const { localeForCountry } = require('./localemap');
        if (!result.countryCode) throw Object.assign(new Error('代理出口地区未知，请重新检测或手动选择语言'), { status: 409 });
        effective.locale = localeForCountry(result.countryCode);
        if (!effective.locale) throw Object.assign(new Error('没有此代理地区的语言映射，请手动选择语言'), { status: 409 });
      }
      network = { route: 'proxy', exitIp: result.exitIp, checkedAt: new Date().toISOString(), timezone: effective.timezone, locale: effective.locale };
    }

    let proxy = proxyRecord ? ProxyStore.toPlaywright(proxyRecord) : null;
    let forwarder, context;

    try {
      if (proxyRecord?.type === 'socks5' && (proxyRecord.username || proxyRecord.password || useSystemProxy)) {
        const { SocksForwarder } = require('./socksfwd');
        const systemProxy = useSystemProxy ? await this.settings.route(proxyRecord.host, proxyRecord.port) : null;
        forwarder = await SocksForwarder.start({ ...proxyRecord, systemProxy });
        proxy = { server: `http://127.0.0.1:${forwarder.port}`, bypass: '127.0.0.1,localhost,<-loopback>' };
      } else if (proxy) {
        proxy.bypass = '127.0.0.1,localhost,<-loopback>';
      }

      const { options } = buildContextOptions({ ...effective, proxy });
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
        locale: effective.locale && effective.locale !== 'auto' ? effective.locale : undefined,
        timezoneId: effective.timezone && effective.timezone !== 'auto' ? effective.timezone : undefined,
        
        chromiumSandbox: false,
        devtools: true,

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
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu-sandbox',
          '--disable-breakpad',
          `--remote-debugging-port=${debugPort}`,
          '--remote-debugging-address=127.0.0.1',
          `--class=ikun_app_${profile.id}`,
          `--app-user-model-id=ikun.profile.app.${profile.id}`,
          ...(effective.locale && effective.locale !== 'auto' ? [`--lang=${effective.locale}`, `--accept-lang=${effective.locale}`] : []),
          ...webrtcArgs({ ...effective, proxy: proxy || useSystemProxy || profile.webrtc === 'auto' }),
        ],
      };

      checkCancelled();

      // 标准持久化上下文
      context = await chromium.launchPersistentContext(directory, launchOptions);

      // 精简后的初始化脚本：仅保留标准 WebDriver 隐藏与原生语言对齐，避免 Masking 报警
      await context.addInitScript((loc) => {
        try {
          if (navigator.webdriver !== false) {
            Object.defineProperty(navigator, 'webdriver', {
              get: () => undefined,
              configurable: true
            });
          }

          if (loc && loc !== 'auto') {
            const shortLoc = loc.split('-')[0];
            const languagesList = Array.from(new Set([loc, shortLoc, 'en-US', 'en']));
            Object.defineProperty(navigator, 'language', {
              get: () => loc,
              configurable: true
            });
            Object.defineProperty(navigator, 'languages', {
              get: () => languagesList,
              configurable: true
            });
          }
        } catch (_) {}
      }, effective.locale);

      if (profile.canvasMode !== 'off') {
        const seedValue = typeof profile.id === 'string'
          ? profile.id.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0)
          : (Number(profile.id) || 12345);

        await context.addInitScript((seed) => {
          try {
            const shiftR = (seed % 3) - 1;
            const shiftG = ((seed * 3) % 3) - 1;
            const shiftB = ((seed * 7) % 3) - 1;

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

            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function(...args) {
              const ctx = this.getContext('2d');
              if (ctx && this.width > 0 && this.height > 0) {
                try {
                  const imgData = ctx.getImageData(0, 0, this.width, this.height);
                  ctx.putImageData(imgData, 0, 0);
                } catch (_) {}
              }
              return originalToDataURL.apply(this, args);
            };

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
            };

            if (window.WebGLRenderingContext) hookWebGLReadPixels(WebGLRenderingContext.prototype);
            if (window.WebGL2RenderingContext) hookWebGLReadPixels(WebGL2RenderingContext2D.prototype);

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
            };

            if (window.AudioBuffer) hookAudioBuffer(AudioBuffer.prototype);

          } catch (_) {}
        }, seedValue);
      }

      await configureDownloads(context);
      checkCancelled();

      const session = { context, debugPort, headless, openedAt: Date.now(), forwarder, network };
      this.sessions.set(id, session);

      context.on('close', () => {
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        forwarder?.stop().catch(() => {});
      });

      const watchPage = page => page.on('close', () => {
        if (!context.pages().some(p => !p.isClosed()) && this.sessions.get(id) === session) {
          this.close(id).catch(() => {});
        }
      });

      context.on('page', watchPage);
      for (const page of context.pages()) watchPage(page);

      if (!headless && this.startPage) {
        await require('./startpage').openStartPage(context, profile, network, ip => {
          if (this.sessions.get(id) !== session) return;
          session.network = { ...session.network, exitIp: ip, checkedAt: new Date().toISOString() };
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
        ...(debugPort ? { debug_url: `http://127.0.0.1:${debugPort}` } : {})
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
      return { profile_id: id, open: false };
    })();
    this.closing.set(id, pending);
    try { return await pending; } finally { this.closing.delete(id); this.cancelled.delete(id); }
  }

  async closeAll() {
    const ids = [...new Set([...this.opening.keys(), ...this.sessions.keys()])];
    await Promise.all(ids.map(id => this.close(id)));
    return { closed: ids.length };
  }

  getContext(id) { return this.sessions.get(id)?.context || null; }
}

module.exports = { BrowserManager };
