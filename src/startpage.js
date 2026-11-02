'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');

// 不使用 page.route 拦截，改用轻量本地 loopback 服务，杜绝 Fetch.enable 引发的 hasCDP: true
async function openStartPage(context, profile, network, onResult) {
  const page = context.pages()[0] || await context.newPage();
  const root = path.join(__dirname, '..', 'electron', 'start');
  const config = {
    name: profile.name,
    sequence: profile.sequence,
    proxy: network.route === 'proxy',
    expectedIp: network.exitIp
  };

  const assets = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/start.js': ['start.js', 'text/javascript; charset=utf-8'],
    '/start.css': ['start.css', 'text/css; charset=utf-8']
  };

  // 启动仅限本机 loopback 的临时轻量服务
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 处理 IP 检测结果上报
    if (url.pathname === '/result' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (net.isIP(data.ip)) {
            onResult(data.ip);
            res.writeHead(204);
            res.end();
            return;
          }
        } catch (_) {}
        res.writeHead(400);
        res.end();
      });
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    // 动态配置脚本
    if (url.pathname === '/config.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end('window.cikeEnvironment=' + JSON.stringify(config) + ';');
      return;
    }

    // 环境图标
    if (url.pathname === '/icon.svg') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="16" fill="#172b48"/><text x="32" y="43" text-anchor="middle" fill="white" font-size="${String(profile.sequence).length > 3 ? 18 : 30}" font-family="sans-serif">${Number(profile.sequence)}</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
      return;
    }

    // 静态前端资源
    const file = assets[url.pathname];
    if (file) {
      const filePath = path.join(root, file[0]);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, {
          'Content-Type': file[1],
          'Cache-Control': 'no-store'
        });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  // 随机端口监听本机
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const startUrl = `http://127.0.0.1:${port}/`;

  // 页面关闭或 context 关闭时销毁临时服务
  page.once('close', () => server.close());
  context.once('close', () => server.close());

  await page.goto(startUrl);
  return page;
}

module.exports = { openStartPage };
