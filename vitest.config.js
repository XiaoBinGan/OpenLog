import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 测试隔离：默认情况下 api.test.js 会用 cwd=PROJECT_ROOT 启动服务，直接读写
// 生产库 data/openlog.db、settings.json、remote-servers.json。
// 这里统一改指系统临时目录下的隔离目录（与全量测试一致），避免测试污染真实数据。
// 注意：不能写死 /tmp —— Windows 上会落成当前盘根目录下的 \tmp\...，
// 既不符合系统约定，也会和多用户/多实例互相干扰。
const TEST_TMP = path.join(os.tmpdir(), 'openlog-vitest');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    env: {
      PORT: '30999',
      OPENLOG_DATA_DIR: path.join(TEST_TMP, 'data'),
      OPENLOG_SETTINGS_PATH: path.join(TEST_TMP, 'settings.json'),
      REMOTE_CONFIG_PATH: path.join(TEST_TMP, 'remote-servers.json'),
    },
  },
});