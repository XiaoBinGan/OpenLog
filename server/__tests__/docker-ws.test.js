import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';

describe('Docker 实时日志 WebSocket', () => {
  it('应能连接 WS 并接收日志数据', async () => {
    // 动态获取 running 容器 ID
    const PORT = process.env.PORT || 3011;
    let res;
    try {
      res = await fetch(`http://localhost:${PORT}/api/docker/containers?sourceId=local`);
    } catch {
      console.warn(`⚠️ 服务器未运行(端口 ${PORT})，跳过 Docker WS 测试`);
      return;
    }
    const data = await res.json();
    const containers = data.sources?.[0]?.containers || [];
    const running = containers.find(c => c.state === 'running' && c.names?.includes('openlog-test'));
    if (!running) {
      console.warn('⚠️ 无 running 测试容器，跳过 Docker WS 测试');
      return;
    }

    const messages = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws/docker/logs/local/${running.id}`);
      const timer = setTimeout(() => {
        ws.close();
        messages.length === 0 ? reject(new Error('超时未收到日志')) : resolve();
      }, 10000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'log') messages.push(msg);
        if (messages.length >= 3) { clearTimeout(timer); ws.close(); resolve(); }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    expect(messages.length).toBeGreaterThanOrEqual(3);
  });
});