/**
 * GPU 指标发现脚本的端口选择（生产实测发现的噪音问题）
 *
 * 现象：`openlog-site`（nginx 静态站）2 小时内被打了 80 次 `GET /metrics` → 404，
 * 每次 404 都写进它的 error log，容器日志巡检再把它们当 ERROR 报出来。
 * 即「我们自己的探测制造噪音，再被我们自己的巡检告警」。
 *
 * 修法：候选端口只取「可能跑推理引擎」的容器发布端口，
 * 排除 nginx/httpd/caddy/traefik 与数据库类镜像。
 */
import { describe, it, expect } from 'vitest';
import { buildDiscoveryScript } from '../gpu-mfu.js';

describe('buildDiscoveryScript —— 端口候选', () => {
  const script = buildDiscoveryScript('', '');

  it('用 image+ports 一起取，而不是只取 ports', () => {
    expect(script).toContain("docker ps --format '{{.Image}} {{.Ports}}'");
  });

  it('排除静态站与数据库镜像（否则会给它们打 /metrics 制造 404 噪音）', () => {
    const m = /grep -viE '([^']+)'/.exec(script);
    expect(m).toBeTruthy();
    const pattern = m[1];
    for (const img of ['nginx', 'httpd', 'caddy', 'traefik', 'postgres', 'redis']) {
      expect(pattern, img).toContain(img);
    }
  });

  it('保留常见推理引擎端口作为兜底', () => {
    for (const p of ['8000', '8001', '8002', '8003', '8080', '8899', '30000', '11434']) {
      expect(script).toContain(p);
    }
  });

  it('端口去重排序（同一个端口不该被探多次）', () => {
    expect(script).toContain('sort -un');
  });

  it('配置了 metricsUrl 时会先探它（不受端口扫描影响）', () => {
    const withUrl = buildDiscoveryScript('http://10.0.0.9:9090/metrics', 'k');
    expect(withUrl).toContain('CONFIGURED');
    // 配置的地址要做 base64 传输（避免引号/特殊字符注入远程 shell）
    expect(withUrl).toMatch(/printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d/);
  });

  it('用户填的 URL 不会被直接拼进 shell（防注入）', () => {
    const evil = "http://x/'; rm -rf /; echo '";
    const s = buildDiscoveryScript(evil, '');
    expect(s).not.toContain(evil);
    expect(s).toContain('base64 -d');
  });

  it('只在 HTTP 200 且有内容时才 emit（401/403 会用容器里的 key 重试）', () => {
    expect(script).toContain('"$code" = "200"');
    expect(script).toContain('"401"');
    expect(script).toContain('"403"');
  });
});
