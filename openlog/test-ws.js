import WebSocket from 'ws';

console.log('🔌 测试 WebSocket 连接...');

// 测试主 WebSocket
const ws1 = new WebSocket('ws://localhost:3001/ws');
ws1.on('open', () => {
  console.log('✅ 主 WebSocket 连接成功');
  ws1.close();
});

ws1.on('error', (err) => {
  console.log('❌ 主 WebSocket 连接失败:', err.message);
});

// 测试 Shell WebSocket (需要有效的服务器 ID)
setTimeout(() => {
  console.log('\n🔌 测试 Shell WebSocket 连接...');
  const ws2 = new WebSocket('ws://localhost:3001/ws/shell/86246fe0-7d3b-4289-ac77-1bb916103191');

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
