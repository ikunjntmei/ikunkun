'use strict';

const START_ORIGIN = 'https://start.ikun.invalid';

async function openStartPage(context, profile, network, onResult) {
  const page = context.pages()[0] || await context.newPage();

  const title = profile.name || 'IKUN 独立环境';
  const routeText = network.route === 'proxy' ? '代理连接 (Proxy)' : '系统默认网络';
  const exitIpText = network.exitIp || '检测中 / 本地';

  // 将启动页直接构建为纯本地 Data URI，彻底规避 HTTP 端口与代理冲突
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
    }
    .box {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 36px 48px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);
      text-align: center;
      min-width: 320px;
    }
    .badge {
      display: inline-block;
      width: 48px;
      height: 48px;
      line-height: 48px;
      border-radius: 12px;
      background: #0ea5e9;
      color: #ffffff;
      font-size: 20px;
      font-weight: bold;
      margin-bottom: 16px;
    }
    h2 { margin: 0 0 12px 0; font-size: 20px; font-weight: 600; }
    .item { margin: 8px 0; font-size: 14px; color: #64748b; }
    .val { color: #0f172a; font-weight: 500; font-family: monospace; }
  </style>
</head>
<body>
  <div class="box">
    <div class="badge">${Number(profile.sequence || 1)}</div>
    <h2>${title}</h2>
    <div class="item">路由线路: <span class="val">${routeText}</span></div>
    <div class="item">出口 IP: <span class="val">${exitIpText}</span></div>
  </div>
</body>
</html>`;

  const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  // 直接加载内联页面，零网络握手，瞬间完成
  await page.goto(dataUri);
  return page;
}

module.exports = { openStartPage, START_ORIGIN };
