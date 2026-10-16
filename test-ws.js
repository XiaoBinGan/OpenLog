import WebSocket from 'ws';

// WebSocket 现在强制鉴权，token 从环境变量读取：
//   OPENLOG_TOKEN=<data/.auth_token 的内容> node test-ws.js
const PORT = process.env.PORT || 3011;
const TOKEN = process.env.OPENLOG_TOKEN || '';
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';

console.log('🔌 测试 WebSocket 连接...');
if (!TOKEN) console.warn('⚠️  未设置 OPENLOG_TOKEN，连接将返回 401');

// 测试主 WebSocket
const ws1 = new WebSocket(`ws://localhost:${PORT}/ws${q}`);
ws1.on('open', () => {
  console.log('✅ 主 WebSocket 连接成功');
  ws1.close();
});

ws1.on('error', (err) => {
  console.log('❌ 主 WebSocket 连接失败:', err.message);
});

// 测试 Shell WebSocket（服务器 ID 通过 argv 传入：node test-ws.js <serverId>）
setTimeout(() => {
  const serverId = process.argv[2];
  if (!serverId) {
    console.log('\n⏭️  跳过 Shell WebSocket 测试（未提供 serverId 参数）');
    return;
  }
  console.log('\n🔌 测试 Shell WebSocket 连接...');
  const ws2 = new WebSocket(`ws://localhost:${PORT}/ws/shell/${serverId}${q}`);

  ws2.on('open', () => {
    console.log('✅ Shell WebSocket 连接成功');
    ws2.close();
  });

  ws2.on('message', (data) => {
    console.log('收到消息:', data.toString());
  });

  ws2.on('error', (err) => {
    console.log('❌ Shell WebSocket 连接失败:', err.message);
  });
}, 1000);

setTimeout(() => {
  process.exit(0);
}, 3000);
