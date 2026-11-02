'use strict';
const net = require('net');
const path = require('path');
const fs = require('fs');
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
      let proxyServerArg = null;

      if (proxyRecord?.type === 'socks5' && (proxyRecord.username || proxyRecord.password || useSystemProxy)) {
        const { SocksForwarder } = require('./socksfwd');
        const systemProxy = useSystemProxy ? await this.settings.route(proxyRecord.host, proxyRecord.port) : null;
        forwarder = await SocksForwarder.start({ ...proxyRecord, systemProxy });
        proxyServerArg = `http://127.0.0.1:${forwarder.port}`;
        proxy = { server: proxyServerArg };
      } else if (proxyRecord) {
        const scheme = proxyRecord.type === 'socks5' ? 'socks5' : 'http';
        const host = proxyRecord.host.includes(':') ? `[${proxyRecord.host}]` : proxyRecord.host;
        proxyServerArg = `${scheme}://${host}:${proxyRecord.port}`;
        proxy = { 
          server: proxyServerArg,
          ...(proxyRecord.username ? { username: proxyRecord.username } : {}),
          ...(proxyRecord.password ? { password: proxyRecord.password } : {})
        };
      }

      // 提取 profile 选项，并保留规范的代理对象
      const { options } = buildContextOptions({ ...effective, proxy });
      const debugPort = process.env.LFB_EXPOSE_DEBUGGER === '1' ? await findFreePort(4550, 4599) : null;
      
      const extraArgs = [
        '--no-first-run',
        '--no-default-browser-check',
        '--check-for-update-interval=31536000',
        '--disable-component-update',
        '--site-per-process',
        '--disable-background-mode',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        // 彻底切断 WebRTC 本地网络泄露
        '--enforce-webrtc-ip-permission-check',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ];

      if (proxyServerArg) {
        extraArgs.push(`--proxy-server=${proxyServerArg}`);
      }

      const launchOptions = {
        ...options,
        proxy: proxy || undefined, // Playwright 上下文必须持有规范 proxy 对象
        headless,
        chromiumSandbox: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          ...extraArgs,
          ...(effective.locale !== 'auto' ? [`--lang=${effective.locale}`, `--accept-lang=${effective.locale}`] : []),
          ...(debugPort ? [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'] : []),
          ...webrtcArgs({ ...effective, proxy: proxy || useSystemProxy || profile.webrtc === 'auto' }),
        ],
      };

      const isWin = process.platform === 'win32';
      const winCandidates = [
        process.env.LFB_CHROMIUM_EXECUTABLE,
        path.join(this.store.dataDir, 'chromium', 'chrome.exe'),
        path.join(this.store.dataDir, 'chromium-1148', 'chrome.exe'),
        path.join(this.store.dataDir, 'browsers', 'chromium', 'chrome.exe'),
        path.join(this.store.dataDir, 'browsers', 'chromium-1148', 'chrome.exe')
      ];

      if (isWin) {
        for (const candidate of winCandidates) {
          if (candidate && fs.existsSync(candidate)) {
            launchOptions.executablePath = candidate;
            break;
          }
        }
      } else if (process.env.LFB_CHROMIUM_EXECUTABLE) {
        launchOptions.executablePath = process.env.LFB_CHROMIUM_EXECUTABLE;
      }

      checkCancelled();

      if (!headless && this.profileIcons && !isWin) {
        launchOptions.executablePath = await require('./profileapp').ensureProfileApp(
          this.store.dataDir,
          profile,
          launchOptions.executablePath || chromium.executablePath()
        );
        checkCancelled();
      }

      const directory = this.store.profileDir(id);
      privateDirectory(directory);
      await prepareDownloads(directory, this.downloadsDirectory);

      // 启动 Persistent Context
      context = await chromium.launchPersistentContext(directory, launchOptions);

      // --- 关键：最前置注入防检测脚本，并清理 Playwright 特征 ---
      await context.addInitScript(() => {
        // 1. 删除 navigator.webdriver 使得它返回 undefined，与真实 Chrome 行为完全一致
        try {
          const newProto = navigator.__proto__;
          delete newProto.webdriver;
        } catch (_) {}

        // 2. 伪造真实 Chrome 的全局对象与运行时
        if (!window.chrome) {
          window.chrome = {};
        }
        window.chrome.app = { isInstalled: false };
        window.chrome.runtime = {
          PlatformArch: { X86_64: 'x86-64' },
          PlatformOs: { WIN: 'win' },
          OnInstalledReason: { INSTALL: 'install' }
        };

        // 3. 伪造插件列表（Playwright 默认为空，容易被判定为自动化）
        try {
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
            enumerable: true,
            configurable: true
          });
        } catch (_) {}

        // 4. 清理 WebRTC 对象，防止 UDP 探测真实 IP
        try {
          delete window.RTCPeerConnection;
          delete window.webkitRTCPeerConnection;
          delete window.RTCSessionDescription;
          delete window.RTCIceCandidate;
        } catch (_) {}
      });

      // 关键：给首次启动自动创建的已有页面补打补丁，并刷新页面以生效防检测
      const existingPages = context.pages();
      for (const page of existingPages) {
        await page.evaluate(() => {
          try {
            delete navigator.__proto__.webdriver;
          } catch (_) {}
        }).catch(() => {});
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
