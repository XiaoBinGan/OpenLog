import { describe, it, expect } from 'vitest';

const {
  parseRemoteNvidiaGPUs, parseRemoteNvidiaProcesses, buildRemoteGPUPayload,
} = await import('../gpu.js');

const GPU_UUID_4090 = 'GPU-86d14e75-1e54-3aed-e483-6652a4c30653';
const GPU_UUID_5090 = 'GPU-6b12533d-bcfb-25b6-bafe-5a8d5bd85d07';

const GPU_OUT = [
  `0, NVIDIA GeForce RTX 4090, ${GPU_UUID_4090}, 0, 43573, 49140, 26`,
  `1, NVIDIA GeForce RTX 5090, ${GPU_UUID_5090}, 12, 31847, 32607, 27`,
].join('\n');

const PROC_OUT = [
  `${GPU_UUID_4090}, 794809, VLLM::EngineCore, 43562`,
  `${GPU_UUID_5090}, 1160887, python, 8730`,
].join('\n');

describe('远程 nvidia-smi 解析', () => {
  it('解析 --query-gpu 输出（含 uuid）', () => {
    const gpus = parseRemoteNvidiaGPUs(GPU_OUT);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({
      index: 0,
      name: 'NVIDIA GeForce RTX 4090',
      uuid: GPU_UUID_4090,
      utilization: 0,
      memoryUsed: 43573,
      memoryTotal: 49140,
      temperature: 26,
    });
  });

  it('空输出 / nvidia-smi 报错行都安全返回空数组', () => {
    expect(parseRemoteNvidiaGPUs('')).toEqual([]);
    expect(parseRemoteNvidiaGPUs('Field "gpu_index" is not a valid field to query.')).toEqual([]);
    expect(parseRemoteNvidiaProcesses('No running processes found')).toEqual([]);
    // 旧实现用的非法字段报错，不能解析出 pid=0 的假进程
    expect(parseRemoteNvidiaProcesses('Field "gpu_index" is not a valid field to query.')).toEqual([]);
  });
});

describe('buildRemoteGPUPayload', () => {
  it('设备/进程/汇总都正确（回归：非法 gpu_index + summary null）', () => {
    const { devices, summary } = buildRemoteGPUPayload(GPU_OUT, PROC_OUT);

    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({
      index: 0, name: 'NVIDIA GeForce RTX 4090', util: 0, memUsed: 43573, memTotal: 49140, temp: 26,
    });
    // gpu_uuid → index 映射成功，进程不再是 unknown/0
    expect(devices[0].processes).toEqual([
      { gpuId: '0', pid: 794809, name: 'VLLM::EngineCore', usedMemory: 43562 },
    ]);
    expect(devices[1].processes).toEqual([
      { gpuId: '1', pid: 1160887, name: 'python', usedMemory: 8730 },
    ]);

    // summary 不再全 null（旧实现喂错结构 → vendors=undefined、utilization=null）
    expect(summary).not.toBeNull();
    expect(summary.count).toBe(2);
    expect(summary.vendors).toEqual({ NVIDIA: 2 });
    expect(summary.totalMemory).toBe(49140 + 32607);
    expect(summary.usedMemory).toBe(43573 + 31847);
    expect(summary.freeMemory).toBe(summary.totalMemory - summary.usedMemory);
    expect(summary.avgUtilization).toBe(6); // round((0 + 12) / 2)
    expect(summary.maxTemperature).toBe(27);
    expect(summary.processCount).toBe(2);
  });

  it('无进程输出时设备仍在、进程为空', () => {
    const { devices, summary } = buildRemoteGPUPayload(GPU_OUT, '');
    expect(devices).toHaveLength(2);
    expect(devices[0].processes).toEqual([]);
    expect(summary.processCount).toBe(0);
  });

  it('未知 uuid 的进程会被忽略，不会挂到错误的卡上', () => {
    const { devices } = buildRemoteGPUPayload(GPU_OUT, 'GPU-unknown-uuid, 1234, ghost, 100');
    expect(devices[0].processes).toEqual([]);
    expect(devices[1].processes).toEqual([]);
  });

  it('无 GPU 输出返回空设备 + null summary', () => {
    expect(buildRemoteGPUPayload('', '')).toEqual({ devices: [], summary: null });
  });
});
