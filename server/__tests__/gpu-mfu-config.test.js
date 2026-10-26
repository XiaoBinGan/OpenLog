import { describe, it, expect } from 'vitest';

const { maskGpuConfigs, mergeGpuConfigs, GPU_API_KEY_MASK } = await import('../gpu.js');

describe('MFU 数据源配置 —— 凭据脱敏与合并', () => {
  it('GET 返回时 apiKey 只露前 4 位', () => {
    const masked = maskGpuConfigs([
      { serverId: 'a', apiKey: '083a3d319ce024089a39cb0ef5a93d2c6fa379cb0142f5cb' },
      { serverId: 'b' },
    ]);
    expect(masked[0].apiKey).toBe(`083a${GPU_API_KEY_MASK}`);
    expect(masked[0].apiKey).not.toContain('9ce02408');
    expect(masked[1].apiKey).toBeUndefined();
  });

  it('POST 回传脱敏值时保留原密钥', () => {
    const existing = [{ serverId: 'a', apiKey: 'real-secret-key-1234' }];
    const merged = mergeGpuConfigs([
      { serverId: 'a', apiKey: 'real***', metricsUrl: 'http://127.0.0.1:8000/metrics' },
    ], existing);
    expect(merged[0].apiKey).toBe('real-secret-key-1234');
    expect(merged[0].metricsUrl).toBe('http://127.0.0.1:8000/metrics');
  });

  it('POST 显式新密钥时覆盖旧密钥', () => {
    const merged = mergeGpuConfigs([{ serverId: 'a', apiKey: 'brand-new-key-9999' }], [{ serverId: 'a', apiKey: 'old-key' }]);
    expect(merged[0].apiKey).toBe('brand-new-key-9999');
  });

  it('空字符串 / 空值字段被清除，paramsB 转数字', () => {
    const merged = mergeGpuConfigs([
      { serverId: 'a', apiKey: '', metricsUrl: '   ', paramsB: '27.5' },
      { serverId: 'b', paramsB: '' },
    ], []);
    expect(merged[0].apiKey).toBeUndefined();
    expect(merged[0].metricsUrl).toBeUndefined();
    expect(merged[0].paramsB).toBe(27.5);
    expect(merged[1].paramsB).toBeUndefined();
  });

  it('新服务器的脱敏 key（无历史值）直接丢弃，不会存占位符', () => {
    const merged = mergeGpuConfigs([{ serverId: 'new', apiKey: 'fake***' }], []);
    expect(merged[0].apiKey).toBeUndefined();
  });
});
