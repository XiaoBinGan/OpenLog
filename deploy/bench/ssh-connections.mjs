/**
 * SSH 连接池容量探针 v2（实测单连接成本 + 失败原因 + 单机 stats 命令耗时）。
 */
import fs from 'node:fs';
import { Client } from 'ssh2';

const N = Number(process.env.PROBE_N || 200);
const CONCURRENCY = Number(process.env.PROBE_CONC || 8);
const HOST = process.env.PROBE_HOST || '127.0.0.1';
const PORT = Number(process.env.PROBE_PORT || 40022);
const USER = process.env.PROBE_USER || 'probe-user';
const PASS = process.env.PROBE_PASS || '';
const STATS_SAMPLES = Number(process.env.PROBE_STATS || 10);

const fdCount = () => {
  try { return fs.readdirSync('/proc/self/fd').length; } catch { return -1; }
};
const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;

function connectOne() {
  return new Promise((resolve) => {
    const c = new Client();
    const t0 = Date.now();
    c.on('ready', () => resolve({ ok: true, ms: Date.now() - t0, client: c }));
    c.on('error', (e) => resolve({ ok: false, err: String(e.message).slice(0, 80), client: c }));
    c.connect({ host: HOST, port: PORT, username: USER, password: PASS, readyTimeout: 15000 });
  });
}

const baseline = process.memoryUsage();
const fd0 = fdCount();
const t0 = Date.now();
const clients = [];
const errors = new Map();
const times = [];
let ok = 0;

for (let i = 0; i < N; i += CONCURRENCY) {
  const batch = Array.from({ length: Math.min(CONCURRENCY, N - i) }, () => connectOne());
  for (const r of await Promise.all(batch)) {
    if (r.ok) { ok++; times.push(r.ms); clients.push(r.client); }
    else { errors.set(r.err, (errors.get(r.err) || 0) + 1); }
  }
}

const rssAfter = process.memoryUsage();
const fdAfter = fdCount();
const connectMs = Date.now() - t0;
times.sort((a, b) => a - b);

// 单机 stats 命令耗时（模拟 StatsScheduler 每台做的那次采集）
const statTimes = [];
for (let i = 0; i < Math.min(STATS_SAMPLES, clients.length); i++) {
  const s = Date.now();
  await new Promise((resolve) => {
    clients[i].exec("cat /proc/loadavg; free -b | head -2; df -B1 / | tail -1; nproc", (err, stream) => {
      if (err) return resolve();
      stream.on('close', resolve).on('data', () => {}).resume();
    });
  });
  statTimes.push(Date.now() - s);
}
statTimes.sort((a, b) => a - b);

const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
const p = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0);

console.log(JSON.stringify({
  tried: N,
  connected: ok,
  failed: N - ok,
  failureReasons: [...errors.entries()],
  connectTotalMs: connectMs,
  connectAvgMs: avg(times),
  connectP95Ms: p(times, 0.95),
  statsAvgMs: avg(statTimes),
  statsP95Ms: p(statTimes, 0.95),
  statsSamples: statTimes.length,
  rssBeforeMB: mb(baseline.rss),
  rssAfterMB: mb(rssAfter.rss),
  rssDeltaMB: mb(rssAfter.rss - baseline.rss),
  rssPerConnKB: ok ? Math.round(((rssAfter.rss - baseline.rss) / 1024) / ok) : 0,
  heapDeltaMB: mb(rssAfter.heapUsed - baseline.heapUsed),
  fdBefore: fd0,
  fdAfter: fdAfter,
  fdDelta: fdAfter - fd0,
}, null, 2));

for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
console.log('done');
setTimeout(() => process.exit(0), 800);