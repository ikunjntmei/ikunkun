'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');

async function openStartPage(context, profile, network, onResult) {
  const page = context.pages()[0] || await context.newPage();
  
  // 查找启动页目录的潜在位置
  const candidateRoots = [
    path.join(__dirname, '..', 'electron', 'start'),
    path.join(__dirname, 'electron', 'start'),
    path.join(__dirname, 'start')
  ];
  let root = candidateRoots.find(p => fs.existsSync(path.join(p, 'index.html'))) || candidateRoots[0];

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

  // 本地轻量 HTTP 服务，杜绝 page.route 引起的 CDP 侦测
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // 处理 IP 上报
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
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="16" fill="#172b48"/><text x="32" y="43" text-anchor="middle" fill="white" font-size="${String(profile.sequence).length > 3 ? 18 : 30}" font-family="sans-serif">${Number(profile.sequence || 1)}</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
      return;
    }

    // 尝试读取本地静态文件
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

    // 兜底默认首页，防止返回 404 导致 page.goto 抛错崩溃
    if (url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${profile.name || '环境启动中'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; color: #1e293b; }
    .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 90%; }
    h2 { margin: 0 0 10px; font-size: 1.25rem; }
    p { margin: 0; color: #64748b; font-size: 0.9rem; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${profile.name || 'CIKE 独立环境'}</h2>
    <p>出口线路: ${network.route === 'proxy' ? (network.exitIp || '代理已连接') : '系统网络'}</p>
  </div>
</body>
</html>`);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const startUrl = `http://127.0.0.1:${port}/`;

  page.once('close', () => server.close());
  context.once('close', () => server.close());

  // 导航至本地启动页
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  return page;
}

module.exports = { openStartPage };
