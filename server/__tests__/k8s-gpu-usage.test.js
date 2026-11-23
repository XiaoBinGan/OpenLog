import { test, expect, vi } from 'vitest';
import { collectNodeGpuUsage, indexDevicesByKey, lookupGpuUsage } from '../k8s/gpu-usage.js';

const nodes = [
  { name: 'node1', internalIP: '10.0.0.1' },
  { name: 'node2', internalIP: '10.0.0.2' },
  { name: 'node3', internalIP: '10.0.0.3' },
];
const servers = [{ host: '10.0.0.2', username: 'u' }];

test('本机节点走 getLocalGPUs，远端按 InternalIP 匹配', async () => {
  const getLocalGPUs = vi.fn(async () => [{ uuid: 'GPU-a', util: 41, memUsed: 2048, memTotal: 24576, index: 0 }]);
  const getRemoteGPUs = vi.fn(async () => ({ devices: [{ uuid: 'GPU-b', util: 72, memUsed: 8192, memTotal: 15360, index: 0 }] }));
  const map = await collectNodeGpuUsage({ nodes, servers, deps: { getLocalGPUs, getRemoteGPUs, localIps: ['10.0.0.1'] } });
  expect(map.get('node1').get('GPU-a').util).toBe(41);
  expect(map.get('node2').get('GPU-b').util).toBe(72);
  expect(map.has('node3')).toBe(false);   // 没有对应服务器
  expect(getRemoteGPUs).toHaveBeenCalledTimes(1);
});

test('采集失败不影响其它节点', async () => {
  const map = await collectNodeGpuUsage({
    nodes, servers, deps: {
      localIps: ['10.0.0.1'],
      getLocalGPUs: async () => { throw new Error('boom'); },
      getRemoteGPUs: async () => ({ devices: [{ uuid: 'GPU-b', util: 10 }] }),
    },
  });
  expect(map.has('node1')).toBe(false);
  expect(map.get('node2').get('GPU-b').util).toBe(10);
});

test('无 uuid 时退化到 idx:N，lookup 可按 index 兜底', () => {
  const idx = indexDevicesByKey([{ index: 1, util: 30, memUsed: 500 }]);
  expect(idx.has('idx:1')).toBe(true);
  expect(lookupGpuUsage(idx, { uuid: 'GPU-x', index: 1 }).util).toBe(30);
  expect(lookupGpuUsage(idx, { uuid: 'GPU-x', index: 2 })).toBe(null);
});

test('同一 uuid 重复只认第一条（确定性）', () => {
  const idx = indexDevicesByKey([{ uuid: 'GPU-a', util: 10 }, { uuid: 'GPU-a', util: 99 }]);
  expect(idx.get('GPU-a').util).toBe(10);
});

test('空输入不炸', async () => {
  expect((await collectNodeGpuUsage({})).size).toBe(0);
  expect(indexDevicesByKey(null).size).toBe(0);
  expect(lookupGpuUsage(null, {})).toBe(null);
});
