'use strict';
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

// 在启动前直接写入 Chromium 原生首选项。
// Chromium 的原生下载管理器会读取 Default/Preferences 中的配置，
// 保留文件名并自动处理重命名，无需依赖 CDP 协议干预。
async function prepareDownloads(profileDirectory, directory = path.join(os.homedir(), 'Downloads')) {
  directory = path.resolve(directory);
  await fs.mkdir(directory, { recursive: true });
  const defaultDirectory = path.join(profileDirectory, 'Default');
  await fs.mkdir(defaultDirectory, { recursive: true });
  const filename = path.join(defaultDirectory, 'Preferences');
  let preferences = {};
  try {
    preferences = JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  preferences.background_mode = { ...preferences.background_mode, enabled: false };
  preferences.profile = { ...preferences.profile, name: path.basename(profileDirectory), exit_type: 'Normal' };
  preferences.session = { ...preferences.session, restore_on_startup: 5 };
  preferences.download = {
    ...preferences.download,
    default_directory: directory,
    prompt_for_download: false,
    directory_upgrade: true,
  };

  // 临时文件后缀修改为 .ikun-downloads
  const temporary = filename + '.ikun-downloads';
  try {
    await fs.writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// 移除 newCDPSession(page)，彻底杜绝因挂载调试会话导致的 hasCDP: true 泄漏
async function configureDownloads(context) {
  // 原生配置已由 prepareDownloads 固化到 Preferences 文件中，保持静默即可
  return;
}

module.exports = { prepareDownloads, configureDownloads };
