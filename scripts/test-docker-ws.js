import { WebSocket } from 'ws';

// WebSocket 现在强制鉴权：OPENLOG_TOKEN=<token> node scripts/test-docker-ws.js <sourceId> <containerId>
const PORT = process.env.PORT || 3011;
const TOKEN = process.env.OPENLOG_TOKEN || '';
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';
const [sourceId = 'local', containerId = ''] = process.argv.slice(2);

if (!TOKEN) console.warn('⚠️  未设置 OPENLOG_TOKEN，连接将返回 401');
if (!containerId) {
  console.error('用法: OPENLOG_TOKEN=<token> node scripts/test-docker-ws.js <sourceId> <containerId>');
  process.exit(1);
}

const ws = new WebSocket(`ws://localhost:${PORT}/ws/docker/logs/${sourceId}/${containerId}${q}`);

let count = 0;
ws.on('open', () => console.log('WS connected'));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  count++;
  console.log(`[${msg.level || '?'}] ${msg.content?.substring(0, 80)}`);
  if (count >= 5) {
    console.log(`\n✅ 收到 ${count} 条日志，实时日志流验证通过`);
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (err) => {
  console.error('WS error:', err.message);
  process.exit(1);
});
setTimeout(() => { console.log('Timeout'); process.exit(1); }, 15000);