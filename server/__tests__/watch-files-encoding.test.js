import { describe, it, expect } from 'vitest';

/**
 * watch_files 双重编码膨胀 bug 的回归测试。
 *
 * 真实事故：服务器列表页「SSH 连接全没了」，后端日志报
 *   [RemoteStore] 写服务器 xxx 失败: Connection terminated due to connection timeout
 * 根因是这个字段每保存一次就多一层 JSON 转义，长度按 2^n 增长：
 *   '*.log' → '"*.log"' → '"\\"*.log\\""' → … → 单行 32MB
 * 而 saveServer() 在每次状态采集（30s）都会调用，几十分钟就撑爆。
 * 最终 /api/remote/servers 返回上百 MB JSON，浏览器卡死。
 *
 * 修复：字符串原样存；读取时最多解 8 层历史嵌套；超过 4KB 判定为脏数据回退默认值。
 */

const {
  normalizeWatchFiles, deepNormalizeWatchFiles, serializeWatchFiles,
  DEFAULT_WATCH_FILES, MAX_WATCH_FILES_CHARS, serverToRow, rowToServer,
} = await import('../remote-store.js');

const encrypt = (p) => `enc(${p})`;
const decrypt = (p) => String(p).replace(/^enc\((.*)\)$/, '$1');

describe('watch_files —— 编码不会逐次膨胀', () => {
  it('字符串原样存储（不再 JSON.stringify）', () => {
    const row = serverToRow({ id: 'a', host: 'h', watchFiles: '*.log' }, encrypt);
    expect(row.watch_files).toBe('*.log');
  });

  it('反复 保存→读取 100 次，长度保持不变', () => {
    let server = { id: 'a', host: 'h', watchFiles: '*.log' };
    const lengths = [];
    for (let i = 0; i < 100; i++) {
      const row = serverToRow(server, encrypt);
      lengths.push(String(row.watch_files).length);
      server = rowToServer(row, decrypt);
    }
    expect(new Set(lengths).size, '长度不应随保存次数增长').toBe(1);
    expect(server.watchFiles).toBe('*.log');
  });

  it('历史脏值：保存时收敛，深度修复能还原原值', () => {
    // 模拟被坑过几轮的数据：层层转义
    let dirty = '*.log';
    for (let i = 0; i < 12; i++) dirty = JSON.stringify(dirty);
    expect(dirty.length).toBeGreaterThan(1000); // 历史脏值确实很长

    // 启动时的一次性修复用深度归一化，能剥干净
    expect(deepNormalizeWatchFiles(dirty)).toBe('*.log');

    // 写入路径也不会再把它变长（收敛为干净值或默认值，总之不会持续膨胀）
    const row = serverToRow({ id: 'a', host: 'h', watchFiles: dirty }, encrypt);
    expect(String(row.watch_files).length).toBeLessThan(MAX_WATCH_FILES_CHARS);
    expect(rowToServer(row, decrypt).watchFiles).toBe('*.log');
  });
});

describe('normalizeWatchFiles —— 兼容历史数据', () => {
  it('拆掉一层 JSON 字符串编码', () => {
    expect(normalizeWatchFiles('"*.log"')).toBe('*.log');
  });

  it('拆掉多层嵌套（普通归一化 8 层以内）', () => {
    let v = '*.log';
    for (let i = 0; i < 6; i++) v = JSON.stringify(v);
    expect(normalizeWatchFiles(v)).toBe('*.log');
  });

  it('超过 8 层的深层脏值交给深度修复', () => {
    let v = '*.log';
    for (let i = 0; i < 20; i++) v = JSON.stringify(v);
    expect(deepNormalizeWatchFiles(v)).toBe('*.log');
  });

  it('旧的数组形式还原成数组（保持原语义）', () => {
    expect(normalizeWatchFiles('["*.log","*.err"]')).toEqual(['*.log', '*.err']);
  });

  it('空值回退默认值', () => {
    expect(normalizeWatchFiles(null)).toBe(DEFAULT_WATCH_FILES);
    expect(normalizeWatchFiles(undefined)).toBe(DEFAULT_WATCH_FILES);
    expect(normalizeWatchFiles('')).toBe(DEFAULT_WATCH_FILES);
  });

  it('超长（历史 32MB 那种）回退默认值', () => {
    const huge = 'x'.repeat(MAX_WATCH_FILES_CHARS + 1);
    expect(normalizeWatchFiles(huge)).toBe(DEFAULT_WATCH_FILES);
  });

  it('普通模式串原样保留（含逗号/星号）', () => {
    expect(normalizeWatchFiles('*.log,*.out')).toBe('*.log,*.out');
    expect(normalizeWatchFiles('/var/log/app-*.log')).toBe('/var/log/app-*.log');
  });

  it('非法 JSON 不抛错、当普通字符串', () => {
    expect(normalizeWatchFiles('["broken')).toBe('["broken');
  });

  it('对象值转成字符串而不是 [object Object] 爆炸', () => {
    expect(normalizeWatchFiles({ a: 1 })).toBe('[object Object]');
  });
});

describe('serializeWatchFiles —— 与 normalize 一致', () => {
  it('字符串原样存，数组仍按 JSON 存（往返稳定）', () => {
    expect(serializeWatchFiles('*.log')).toBe('*.log');
    expect(serializeWatchFiles(['a', 'b'])).toBe('["a","b"]');
    // 数组往返不膨胀
    const once = serializeWatchFiles(['a', 'b']);
    const twice = serializeWatchFiles(normalizeWatchFiles(once));
    expect(twice).toBe(once);
  });
});

describe('rowToServer —— 脏行也不会把巨型字段带进内存', () => {
  it('32MB 的历史脏值被收敛', () => {
    const dirty = '\\"'.repeat(8 * 1024 * 1024); // 约 16MB
    const srv = rowToServer({ id: 'a', name: 'n', host: 'h', watch_files: dirty }, decrypt);
    expect(srv.watchFiles).toBe(DEFAULT_WATCH_FILES);
  });

  it('正常行原样返回', () => {
    const srv = rowToServer({ id: 'a', name: 'n', host: 'h', watch_files: '*.log', status: 'connected' }, decrypt);
    expect(srv.watchFiles).toBe('*.log');
    expect(srv.status).toBe('connected');
  });
});