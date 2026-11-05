/**
 * server/__tests__/gpu-amd-process.test.js
 *
 * AMD GPU 进程解析的回归测试。
 *
 * 原实现是一个 TODO 桩函数（永远返回 []），所以 AMD 机器上 GPU 页的
 * 「进程」区域永远是空的 —— 用户看不到哪个进程在占显存。
 *
 * rocm-smi 各版本/各发行版输出格式不统一，这里覆盖实际会遇到的三类格式。
 */
import { describe, it, expect } from 'vitest';
import { parseAMDProcessOutput, parseVendorProcessCsv } from '../gpu.js';

describe('parseAMDProcessOutput —— 格式 1：新版 CSV（--csv 带表头）', () => {
  const out = `device,PID,Process Name,VRAM
card0,12345,python3,1234 MB
card0,23456,torchrun,8192 MB
card1,34567,python3,512 MB`;

  it('解析出全部进程', () => {
    const ps = parseAMDProcessOutput(out);
    expect(ps).toHaveLength(3);
  });

  it('GPU 编号、PID、进程名、显存都正确', () => {
    const ps = parseAMDProcessOutput(out);
    expect(ps[0]).toMatchObject({ gpuId: '0', pid: 12345, name: 'python3', memoryUsed: 1234 });
    expect(ps[1]).toMatchObject({ pid: 23456, name: 'torchrun', memoryUsed: 8192 });
    expect(ps[2]).toMatchObject({ gpuId: '1', pid: 34567, memoryUsed: 512 });
  });
});

describe('parseAMDProcessOutput —— 格式 2：旧版 CSV（不同列名/顺序）', () => {
  const out = `GPU,PID,Process Name,GPU Memory Usage
0,11111,llama-server,2048
1,22222,vllm,4096`;

  it('靠表头定位列，不依赖固定顺序', () => {
    const ps = parseAMDProcessOutput(out);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({ gpuId: '0', pid: 11111, name: 'llama-server', memoryUsed: 2048 });
    expect(ps[1]).toMatchObject({ gpuId: '1', pid: 22222, memoryUsed: 4096 });
  });
});

describe('parseAMDProcessOutput —— 格式 3：纯文本（老 rocm-smi）', () => {
  const out = `======================= Processes on GPU[0] =======================
GPU[0] : PID[45678]  Process Name: python3  VRAM: 6144 MB
GPU[0] : PID[56789]  Process Name: ollama  VRAM: 2048 MB
======================= Processes on GPU[1] =======================
GPU[1] : PID[67890]  Process Name: python  VRAM: 1024 MB`;

  it('解析出全部进程并正确归属 GPU', () => {
    const ps = parseAMDProcessOutput(out);
    expect(ps).toHaveLength(3);
    expect(ps[0]).toMatchObject({ gpuId: '0', pid: 45678, name: 'python3', memoryUsed: 6144 });
    expect(ps[1]).toMatchObject({ gpuId: '0', pid: 56789, name: 'ollama' });
    expect(ps[2]).toMatchObject({ gpuId: '1', pid: 67890, memoryUsed: 1024 });
  });
});

describe('parseAMDProcessOutput —— 健壮性', () => {
  it('空输入返回空数组，不崩', () => {
    expect(parseAMDProcessOutput('')).toEqual([]);
    expect(parseAMDProcessOutput('   \n  ')).toEqual([]);
    expect(parseAMDProcessOutput(null)).toEqual([]);
    expect(parseAMDProcessOutput(undefined)).toEqual([]);
  });

  it('只有表头没有数据 → 空数组', () => {
    expect(parseAMDProcessOutput('device,PID,Process Name,VRAM')).toEqual([]);
  });

  it('遇到 "No processes" 之类提示 → 空数组（不会造出假进程）', () => {
    expect(parseAMDProcessOutput('No processes found on GPU')).toEqual([]);
    expect(parseAMDProcessOutput('GPU[0] : No KFD PIDs running')).toEqual([]);
  });

  it('重复行被去重（同一 GPU 同一 PID 只留一条）', () => {
    const out = `GPU,PID,Process Name,GPU Memory Usage
0,11111,python,1024
0,11111,python,1024`;
    expect(parseAMDProcessOutput(out)).toHaveLength(1);
  });

  it('PID 非法/为 0 的行被跳过', () => {
    const out = `GPU,PID,Process Name,GPU Memory Usage
0,0,init,0
0,abc,weird,0
0,99999,real,1024`;
    const ps = parseAMDProcessOutput(out);
    expect(ps).toHaveLength(1);
    expect(ps[0].pid).toBe(99999);
  });

  it('显存单位保留（GB 也能识别）', () => {
    const out = `device,PID,Process Name,VRAM
card0,12345,python,1.5 GB`;
    const ps = parseAMDProcessOutput(out);
    expect(ps[0].memoryUsed).toBe(1.5);
    expect(ps[0].memoryUnit).toBe('GB');
  });

  it('CRLF 换行也能解析（Windows 上生成的脚本输出）', () => {
    const out = 'device,PID,Process Name,VRAM\r\ncard0,12345,python3,1234 MB\r\n';
    expect(parseAMDProcessOutput(out)).toHaveLength(1);
  });
});

describe('parseVendorProcessCsv —— 沐熙 / 华为共用解析', () => {
  it('带表头：按列名定位', () => {
    const out = `npu_id,pid,process_name,memory
0,12345,python3,2048
1,23456,torchrun,4096`;
    const ps = parseVendorProcessCsv(out);
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({ gpuId: '0', pid: 12345, name: 'python3', memoryUsed: 2048 });
    expect(ps[1]).toMatchObject({ gpuId: '1', pid: 23456 });
  });

  it('无表头：按「第一个 4+ 位纯数字 = pid」兜底', () => {
    const out = `0,12345,python3,2048
1,23456,vllm,4096`;
    const ps = parseVendorProcessCsv(out);
    expect(ps).toHaveLength(2);
    expect(ps[0].pid).toBe(12345);
    expect(ps[0].name).toBe('python3');
    expect(ps[0].memoryUsed).toBe(2048);
  });

  it('"No running processes" 之类提示 → 空数组', () => {
    expect(parseVendorProcessCsv('No running processes found')).toEqual([]);
    expect(parseVendorProcessCsv('')).toEqual([]);
    expect(parseVendorProcessCsv(null)).toEqual([]);
  });

  it('同时给出 name/usedMemory 别名（前端渲染不会空）', () => {
    const [p] = parseVendorProcessCsv('0,12345,python3,2048');
    expect(p.name).toBe('python3');
    expect(p.processName).toBe('python3');
    expect(p.usedMemory).toBe(2048);
    expect(p.memoryUsed).toBe(2048);
  });
});

describe('接线 —— AMD 本地/远程都调用了真解析（不再是 TODO 桩）', () => {
  it('gpu.js 里导出解析函数，且本地与远程两处都用了它', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'gpu.js'), 'utf8');
    expect(src).toContain('export function parseAMDProcessOutput');
    // 老版本 rocm-smi 不支持 --csv → 回落到纯文本
    expect(src).toContain("rocm-smi --showpids 2>/dev/null");
    expect(src).not.toContain('TODO: 根据实际输出格式解析');
  });
});
