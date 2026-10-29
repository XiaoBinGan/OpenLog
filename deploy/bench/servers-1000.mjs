/**
 * 1000 台规模端到端压测（隔离容器 + 独立 SQLite，不碰生产）。
 *
 * 关键点：loadServers() 优先从数据库读，所以必须先把 1000 行写进 SQLite 的
 * remote_servers 表（只写文件会被数据库路径忽略 —— 第一次跑就踩了，加载到 0 台）。
 *
 * 场景比成功路径更苛刻：1000 台全部指向一个「接受后立刻断开」的端口，
 * 每台都要走一遍建连失败 + 退避，验证失败路径不会把单实例拖死。
 */
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const N = Number(process.env.BENCH_N || 1000);
const APP_PORT = Number(process.env.BENCH_PORT || 3021);
const DEAD_PORT = Number(process.env.BENCH_DEAD_PORT || 45999);
const DATA_DIR = '/tmp/bench1000-data';
const DB_FILE = path.join(DATA_DIR, 'openlog.db');

const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── 1. 播种 1000 行到 SQLite（与生产同表结构）──
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS remote_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER, username TEXT,
  password TEXT, private_key TEXT, private_key_path TEXT, log_path TEXT, watch_files TEXT,
  status TEXT, last_error TEXT, last_error_at TEXT, last_connected TEXT, extra TEXT,
  created_at INTEGER, updated_at INTEGER
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_rs_status ON remote_servers(status)');

const insert = db.prepare(`INSERT INTO remote_servers
  (id,name,host,port,username,password,private_key,private_key_path,log_path,watch_files,
   status,last_error,last_error_at,last_connected,extra,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

const seedT0 = Date.now();
const seedTx = db.transaction((rows) => {
  for (const r of rows) insert.run(...r);
});
seedTx(Array.from({ length: N }, (_, i) => [
  `bench-${String(i).padStart(4, '0')}`, `bench-${i}`, '127.0.0.1', DEAD_PORT,
  'nobody', 'x', null, null, '/var/log', '*.log',
  'connected', null, null, null, null, 1793290000 + i, 1793290000 + i,
]));
const seedMs = Date.now() - seedT0;
db.close();
const dbBytes = fs.statSync(DB_FILE).size;

// ── 2. 死端口（接受后立刻断开，模拟不可达，不消耗宿主机 sshd）──
const deadServer = net.createServer((sock) => { sock.destroy(); });
await new Promise((res) => deadServer.listen(DEAD_PORT, '127.0.0.1', res));

// ── 3. 启动生产 server/index.js ──
const t0 = Date.now();
const child = spawn(process.execPath, ['/app/server/index.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
    OPENLOG_DATA_DIR: DATA_DIR,
    OPENLOG_DB_TYPE: 'sqlite',
    OPENLOG_STARTUP_CONNECT_CONCURRENCY: '16',
    OPENLOG_MAX_SSH_CONNECTIONS: '1200',
    OPENLOG_SSH_READY_TIMEOUT_MS: '2000',
    OPENLOG_STATS_INTERVAL_MS: '30000',
    OPENLOG_STATS_CONCURRENCY: '16',
    REMOTE_CONFIG_PATH: path.join(DATA_DIR, 'remote-servers.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });
let childPid = child.pid;

const procStat = (what) => {
  try {
    const status = fs.readFileSync(`/proc/${childPid}/status`, 'utf8');
    if (what === 'rss') {
      const m = status.match(/VmRSS:\s+(\d+) kB/);
      return m ? Math.round(Number(m[1]) / 1024) : -1;
    }
    return -1;
  } catch { return -1; }
};
const fdCount = () => { try { return fs.readdirSync(`/proc/${childPid}/fd`).length; } catch { return -1; } };

async function waitReady(deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      await new Promise((res, rej) => {
        const req = http.get({ host: '127.0.0.1', port: APP_PORT, path: '/', timeout: 2000 }, (r) => { r.resume(); res(null); });
        req.on('error', rej);
        req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
      });
      return true;
    } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  return false;
}

const ready = await waitReady(180_000);
const bootMs = Date.now() - t0;
if (!ready) {
  console.log('启动失败：\n' + log.slice(-2500));
  child.kill('SIGKILL'); deadServer.close(); process.exit(1);
}

const fetchJson = (p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: APP_PORT, path: p, timeout: 180_000 }, (r) => {
    let body = '';
    r.on('data', (c) => { body += c; });
    r.on('end', () => resolve({ status: r.statusCode, bytes: Buffer.byteLength(body), body }));
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('timeout')));
});

// ── 4. 列表接口 ──
const tList = Date.now();
const list = await fetchJson('/api/remote/servers');
const listMs = Date.now() - tList;
let listed = 0;
try { listed = (JSON.parse(list.body).servers || []).length; } catch { /* ignore */ }

// ── 5. stats 快照（强制刷新，1000 台全部失败路径）──
const rssBeforeStats = procStat('rss');
const tStats = Date.now();
let stats = await fetchJson('/api/remote/servers/stats?refresh=1');
let meta = {};
try { meta = JSON.parse(stats.body).meta || {}; } catch { /* ignore */ }
// 轮询到这一轮采集真的结束（最多 120s）
while ((meta.lastPass?.total ?? 0) === 0 && Date.now() - tStats < 120_000) {
  await new Promise(r => setTimeout(r, 2000));
  stats = await fetchJson('/api/remote/servers/stats?refresh=1');
  try { meta = JSON.parse(stats.body).meta || {}; } catch { /* ignore */ }
}
const statsMs = Date.now() - tStats;
const rssAfterStats = procStat('rss');

// ── 6. 等一轮自动重连，看是否还活着 ──
await new Promise(r => setTimeout(r, 12_000));
const alive = (() => { try { process.kill(childPid, 0); return true; } catch { return false; } })();

console.log(JSON.stringify({
  n: N,
  seed: { rows: N, ms: seedMs, dbMB: mb(dbBytes) },
  bootMs,
  listApi: { status: list.status, servers: listed, bytes: list.bytes, kb: Math.round(list.bytes / 1024), ms: listMs },
  statsApi: {
    status: stats.status, bytes: stats.bytes, kb: Math.round(stats.bytes / 1024), ms: statsMs,
    lastPass: meta.lastPass || null,
  },
  process: {
    rssBeforeStatsMB: rssBeforeStats,
    rssAfterStatsMB: rssAfterStats,
    rssDeltaMB: rssAfterStats - rssBeforeStats,
    fds: fdCount(),
    aliveAfter12s: alive,
  },
  logTail: log.split('\n').filter(l => /Stats|Remote|重连|pool|连接/i.test(l)).slice(-10),
}, null, 2));

child.kill('SIGTERM');
await new Promise(r => setTimeout(r, 2000));
try { child.kill('SIGKILL'); } catch { /* ignore */ }
deadServer.close();
