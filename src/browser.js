'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { webrtcArgs, validateProfile } = require('./fingerprint');
const { resolveProxy, inlineRecord } = require('./proxyconfig');
const { ProxyStore } = require('./proxystore');
const { checkProxy } = require('./proxycheck');
const { privateDirectory } = require('./privatefiles');
const { prepareDownloads } = require('./downloads');

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
  }

  isOpen(id) {
    return this.sessions.has(id) || this.opening.has(id);
  }

  listOpen() {
    return [...this.sessions].map(([id, s]) => ({
      profile_id: id,
      pid: s.pid,
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
    try {
      return await pending;
    } finally {
      this.opening.delete(id);
    }
  }

  async _open(id) {
    if (this.sessions.has(id)) {
      return { profile_id: id, open: true, reused: true, ...this.listOpen().find(s => s.profile_id === id) };
    }
    const profile = this.store.get(id);
    if (!profile) throw Object.assign(new Error('环境不存在'), { status: 404 });
    validateProfile(profile);

    const checkCancelled = () => {
      if (this.cancelled.has(id)) throw Object.assign(new Error('环境启动已取消'), { status: 409 });
    };

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
        if (!result.timezone) throw Object.assign(new Error('代理出口时区未知，请重新检测或手动选择时区'), { status: 409 });
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

    let forwarder = null;
    let proxyServerArg = null;

    try {
      if (proxyRecord?.type === 'socks5' && (proxyRecord.username || proxyRecord.password || useSystemProxy)) {
        const { SocksForwarder } = require('./socksfwd');
        const systemProxy = useSystemProxy ? await this.settings.route(proxyRecord.host, proxyRecord.port) : null;
        forwarder = await SocksForwarder.start({ ...proxyRecord, systemProxy });
        proxyServerArg = `http://127.0.0.1:${forwarder.port}`;
      } else if (proxyRecord) {
        const scheme = proxyRecord.type === 'socks5' ? 'socks5' : 'http';
        const host = proxyRecord.host.includes(':') ? `[${proxyRecord.host}]` : proxyRecord.host;
        proxyServerArg = `${scheme}://${host}:${proxyRecord.port}`;
      }

      // 仅使用 CIKE 目录内或 Playwright 自带的独立 Chromium，坚决不触碰电脑系统 Chrome
      const isolatedCandidates = [
        process.env.LFB_CHROMIUM_EXECUTABLE,
        path.join(this.store.dataDir, 'chromium', 'chrome.exe'),
        path.join(this.store.dataDir, 'chromium-1148', 'chrome.exe'),
        path.join(this.store.dataDir, 'browsers', 'chromium', 'chrome.exe'),
        path.join(this.store.dataDir, 'browsers', 'chromium-1148', 'chrome.exe')
      ];

      let executablePath = null;
      for (const candidate of isolatedCandidates) {
        if (candidate && fs.existsSync(candidate)) {
          executablePath = candidate;
          break;
        }
      }

      // 如果应用数据目录内没有放独立包，直接调用 playwright 自带的独立 chromium 内核二进制
      if (!executablePath) {
        try {
          executablePath = chromium.executablePath();
        } catch (_) {}
      }

      if (!executablePath || !fs.existsSync(executablePath)) {
        throw new Error('未找到内置的 Chromium 执行文件，请确认运行时包已下载完整');
      }

      const directory = path.resolve(this.store.profileDir(id));
      privateDirectory(directory);
      await prepareDownloads(directory, this.downloadsDirectory);

      const targetUrl = 'https://iphey.com';

      // 独立拉起参数：完全隔离数据、隔离单实例、不挂载任何自动化探针
      const chromeArgs = [
        `--user-data-dir=${directory}`,
        '--new-window',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
        '--disable-blink-features=AutomationControlled',
        '--exclude-switches=enable-automation',
        '--disable-infobars',
        '--enforce-webrtc-ip-permission-check',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ...(proxyServerArg ? [`--proxy-server=${proxyServerArg}`] : []),
        ...(effective.locale && effective.locale !== 'auto' ? [`--lang=${effective.locale}`, `--accept-lang=${effective.locale}`] : []),
        ...webrtcArgs({ ...effective, proxy: proxyRecord || useSystemProxy || profile.webrtc === 'auto' }),
        targetUrl
      ];

      if (effective.viewport?.width && effective.viewport?.height) {
        chromeArgs.push(`--window-size=${effective.viewport.width},${effective.viewport.height}`);
      }

      checkCancelled();

      const spawnEnv = { ...process.env };
      if (effective.timezone && effective.timezone !== 'auto') {
        spawnEnv.TZ = effective.timezone;
      }

      // 脱离控制端完全独立启动，不注入任何 CDP 管道
      const child = spawn(executablePath, chromeArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: spawnEnv
      });

      child.unref();

      const session = {
        process: child,
        pid: child.pid,
        openedAt: Date.now(),
        forwarder,
        network
      };
      this.sessions.set(id, session);

      child.on('exit', () => {
        if (this.sessions.get(id) === session) {
          this.sessions.delete(id);
        }
        forwarder?.stop().catch(() => {});
      });

      checkCancelled();
      this.store.recordOpened(id, session.network);

      return {
        profile_id: id,
        open: true,
        reused: false,
        network
      };
    } catch (error) {
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
        if (session.pid) {
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(session.pid), '/f', '/t']);
            } else {
              process.kill(session.pid);
            }
          } catch (_) {}
        }
        await session.forwarder?.stop().catch(() => {});
        if (this.sessions.get(id) === session) this.sessions.delete(id);
      }
      return { profile_id: id, open: false };
    })();

    this.closing.set(id, pending);
    try {
      return await pending;
    } finally {
      this.closing.delete(id);
      this.cancelled.delete(id);
    }
  }

  async closeAll() {
    const ids = [...new Set([...this.opening.keys(), ...this.sessions.keys()])];
    await Promise.all(ids.map(id => this.close(id)));
    return { closed: ids.length };
  }

  getContext() {
    return null;
  }
}

module.exports = { BrowserManager };
