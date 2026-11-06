/**
 * server/__tests__/diagnosis-container-facts.test.js
 *
 * 回归 2026-11-06 的「AI 智能诊断看起来坏了」：
 *   1. 前端从来不带 exitCode → 提示词里是 "退出码: undefined" → 模型编造「容器已被清理」
 *   2. 日志驱动不支持读取（501）被静默吞掉 → 同样变成假结论
 *   3. 长连接迟迟不出字（先吐 reasoning）→ 面板空白，看起来像卡死
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeContainerFacts, explainLogReadFailure, buildContainerDiagnosisPrompt,
} from '../diagnosis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('describeContainerFacts —— 以 docker inspect 为事实来源', () => {
  it('异常退出：exitCode / exitLabel / 镜像 / 重启次数都对', () => {
    const f = describeContainerFacts({
      Id: 'abcdef1234567890abcdef',
      Name: '/wonderful_cartwright',
      RestartCount: 3,
      Config: { Image: 'myapp:1.2.3' },
      State: { Status: 'exited', ExitCode: 1, OOMKilled: false, FinishedAt: '2026-11-01T02:03:04Z' },
    });
    expect(f).toMatchObject({
      id: 'abcdef123456', name: 'wonderful_cartwright', image: 'myapp:1.2.3',
      state: 'exited', exitCode: 1, oomKilled: false, restartCount: 3, running: false,
      exitType: 'error',
    });
    expect(f.exitLabel).toContain('异常退出(1)');
  });

  it('OOM（137）识别为 oom 且标记 oomKilled', () => {
    const f = describeContainerFacts({ Id: 'x', State: { Status: 'exited', ExitCode: 137, OOMKilled: true } });
    expect(f.exitType).toBe('oom');
    expect(f.oomKilled).toBe(true);
    expect(f.exitLabel).toContain('OOM');
  });

  it('运行中容器 → running，退出码不当成 0 冒充正常', () => {
    const f = describeContainerFacts({
      Id: 'r', Name: '/openlog', State: { Status: 'running', Running: true, ExitCode: 0 },
    });
    expect(f.running).toBe(true);
    expect(f.exitType).toBe('running');
    expect(f.exitLabel).toContain('运行中');
  });

  it('139 段错误 / 143 被终止 / 0 正常退出', () => {
    expect(describeContainerFacts({ State: { Status: 'exited', ExitCode: 139 } }).exitType).toBe('segfault');
    expect(describeContainerFacts({ State: { Status: 'exited', ExitCode: 143 } }).exitType).toBe('terminated');
    expect(describeContainerFacts({ State: { Status: 'exited', ExitCode: 0 } }).exitType).toBe('normal');
  });

  it('缺 State / 空对象 / null 不崩', () => {
    expect(describeContainerFacts(null)).toBeNull();
    expect(describeContainerFacts({})).toBeTruthy();
    const f = describeContainerFacts({ Id: 'z' });
    expect(f.exitCode).toBeNull();
    expect(f.state).toBe('unknown');
  });
});

describe('explainLogReadFailure —— 读不到日志要说人话', () => {
  it('501 日志驱动不支持 → 点名驱动，不说「容器已清理」', () => {
    const msg = explainLogReadFailure(new Error('(HTTP code 501) unexpected - configured logging driver does not support reading'));
    expect(msg).toContain('日志驱动');
    expect(msg).toContain('501');
    expect(msg).not.toContain('已被清理');
  });

  it('容器不存在 / 权限不足 / 超时 各有专门文案', () => {
    expect(explainLogReadFailure(new Error('(HTTP code 404) no such container'))).toContain('容器已不存在');
    expect(explainLogReadFailure(new Error('permission denied while trying to connect'))).toContain('权限');
    expect(explainLogReadFailure(new Error('ETIMEDOUT'))).toContain('超时');
  });

  it('未知错误原样带出（截断），空输入返回空串', () => {
    expect(explainLogReadFailure(new Error('weird failure'))).toContain('weird failure');
    expect(explainLogReadFailure(null)).toBe('');
    expect(explainLogReadFailure('')).toBe('');
  });
});

describe('buildContainerDiagnosisPrompt —— 不给模型留「编故事」的空洞', () => {
  const facts = describeContainerFacts({
    Id: 'abc', Name: '/myapp', Config: { Image: 'myapp:1' },
    State: { Status: 'exited', ExitCode: 1, FinishedAt: '2026-11-01T00:00:00Z' },
  });

  it('带上真实退出码和镜像，不出现 undefined', () => {
    const p = buildContainerDiagnosisPrompt({ facts });
    expect(p).toContain('退出码: 1');
    expect(p).toContain('myapp:1');
    expect(p).not.toContain('undefined');
  });

  it('日志读不到时明确写出原因，并声明「不代表容器已清理」', () => {
    const p = buildContainerDiagnosisPrompt({
      facts,
      logFailure: explainLogReadFailure(new Error('(HTTP code 501) configured logging driver does not support reading')),
    });
    expect(p).toContain('日志驱动');
    expect(p).toContain('不代表容器没有报错');
    expect(p).not.toContain('容器可能已被清理');
  });

  it('有错误日志时把日志内容带进提示词', () => {
    const p = buildContainerDiagnosisPrompt({
      facts,
      errorLines: [{ level: 'ERROR', content: 'FATAL: connection refused to db:5432' }],
    });
    expect(p).toContain('connection refused to db:5432');
    expect(p).toContain('[ERROR]');
  });

  it('运行中容器用「运行态健康」而不是「异常退出」，且说明不要假设已退出', () => {
    const running = describeContainerFacts({ Id: 'r', State: { Status: 'running', Running: true } });
    const p = buildContainerDiagnosisPrompt({ facts: running });
    expect(p).toContain('运行态');
    expect(p).toContain('不要假设它已经退出');
    expect(p).not.toContain('异常退出诊断');
  });

  it('明确禁止编造', () => {
    const p = buildContainerDiagnosisPrompt({ facts });
    expect(p).toContain('不要编造');
  });
});

describe('接线 —— 路由真的用了这套事实来源和进度事件', () => {
  const route = read('server/routes/docker.js');

  it('服务端自己 inspect（不再依赖前端 body）', () => {
    expect(route).toContain('docker.inspectContainer(');
    expect(route).toContain('describeContainerFacts(');
  });

  it('日志失败走 explainLogReadFailure，不再吞掉', () => {
    expect(route).toContain('logFailure = explainLogReadFailure(err)');
  });

  it('首字节立刻下发（flushHeaders）并推送进度事件', () => {
    expect(route).toContain('res.flushHeaders?.()');
    expect(route).toContain("status: '正在读取容器状态…'");
    expect(route).toContain('模型思考中');
  });

  it('docker.js 提供 inspectContainer', () => {
    expect(read('server/docker.js')).toContain('export async function inspectContainer');
  });

  it('前端带上了 JSON body 并处理 status 事件', () => {
    const page = read('client/src/pages/Docker.tsx');
    expect(page).toContain("headers: { 'Content-Type': 'application/json' }");
    expect(page).toContain('正在读取容器状态');
    expect(page).toContain('j.status');
  });
});
