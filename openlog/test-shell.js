#!/usr/bin/env node
/**
 * 测试 Shell 终端功能
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3001';

async function testShell() {
  try {
    // 1. 获取服务器列表
    const serversRes = await fetch(`${BASE_URL}/api/remote/servers`);
    const { servers } = await serversRes.json();
    
    console.log('📡 找到服务器:', servers.length);
    
    if (servers.length === 0) {
      console.log('❌ 没有配置远程服务器');
      return;
    }
    
    const server = servers[0];
    console.log('🖥️  使用服务器:', server.name, `(${server.host})`);
    
    // 2. 测试 Shell 命令执行
    console.log('\n🧪 测试 Shell 命令执行...');
    
    const shellRes = await fetch(`${BASE_URL}/api/remote/servers/${server.id}/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'ls -la' })
    });
    
    const shellResult = await shellRes.json();
    
    if (shellResult.success) {
      console.log('✅ 命令执行成功');
      console.log('标准输出:', shellResult.stdout.substring(0, 200));
      if (shellResult.stderr) {
        console.log('标准错误:', shellResult.stderr);
      }
    } else {
      console.log('❌ 命令执行失败:', shellResult.error);
    }
    
    // 3. 测试更多命令
    const commands = ['whoami', 'pwd', 'df -h | head -5', 'free -h'];
    
    for (const cmd of commands) {
      console.log(`\n🔧 执行: ${cmd}`);
      const res = await fetch(`${BASE_URL}/api/remote/servers/${server.id}/shell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      
      const result = await res.json();
      if (result.success) {
        console.log('  输出:', result.stdout.trim());
      }
    }
    
    console.log('\n✅ Shell 功能测试完成！');
    console.log('\n💡 提示: 前端 Web Shell 终端通过 WebSocket 实现交互式终端');
    console.log('   WebSocket 端点: ws://localhost:3001/ws/shell/:serverId');
    
  } catch (err) {
    console.error('❌ 测试失败:', err.message);
  }
}

testShell();
