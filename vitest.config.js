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
    /**
     * 覆盖率（`npm run test:coverage`）
     *
     * 此前完全没有 coverage 配置：`coverage.all` 默认 true，会把 client/src 下几百个
     * 从未被 node 测试 import 的组件也算进分母，于是出现「client 0%、整体 34%」这种
     * 没意义也没人看的数字。这里明确 include/exclude，让统计只算**真正参与测试的源码**。
     *
     * 阈值设得比当前实测略低（是「不许倒退」的下限，不是「必须 80%」的目标）：
     * 掉下去会红，涨上去不会被卡。
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['server/**/*.js', 'client/src/**/*.{ts,tsx}'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
        '**/*.test.{js,ts,tsx}',
        'client/src/main.tsx',
      ],
      // 只为「不倒退」设下限；真实数字看每次输出
      thresholds: {
        lines: 30,
        functions: 55,
        branches: 65,
      },
    },
  },
});