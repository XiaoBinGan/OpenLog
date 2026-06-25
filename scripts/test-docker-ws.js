import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:3001/ws/docker/logs/local/3651649eef2137d2b637bf1f4be6e173da964887550326d94263804199e92195');

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