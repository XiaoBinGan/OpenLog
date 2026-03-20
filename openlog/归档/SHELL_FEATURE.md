# 🚀 OpenLog - Web Shell 终端功能

## 功能说明

为远程服务器页面添加了 **Web Shell 终端**功能，允许用户直接在浏览器中操作远程服务器。

## 技术实现

### 后端 (server/remote.js)

添加了两个新的 API 函数：

1. **`execShellCommand(id, command, timeout)`**
   - 执行单条 Shell 命令并返回结果
   - 适用于简单的命令执行

2. **`createShellSession(id, ws)`**
   - 创建交互式 Shell 会话（PTY 模式）
   - 通过 WebSocket 实现实时双向通信
   - 支持交互式命令（如 vim、top）

### 后端 (server/index.js)

添加了：

1. **HTTP API: `/api/remote/servers/:id/shell`**
   - POST 方法，执行单条命令
   - 返回 `{ success, stdout, stderr, code }`

2. **WebSocket 端点: `/ws/shell/:serverId`**
   - 实时交互式 Shell 终端
   - 消息格式：
     ```json
     { "type": "input", "data": "命令" }
     { "type": "shell_output", "data": "输出内容" }
     { "type": "shell_ready", "message": "..." }
     { "type": "shell_error", "error": "..." }
     { "type": "shell_closed" }
     ```

### 前端 (client/src/components/ShellTerminal.tsx)

新建组件特性：

- **实时终端输出**：支持 ANSI 颜色代码渲染
- **命令历史**：上下箭头浏览历史命令
- **快捷命令**：预设常用命令按钮
- **全屏模式**：支持全屏显示
- **状态指示**：连接状态、错误提示
- **安全关闭**：自动清理 WebSocket 连接

### 前端集成 (client/src/pages/Remote.tsx)

- 添加 "打开 Shell 终端" 按钮
- 模态窗口显示 Shell 终端组件

## 使用方法

### 1. 在远程服务器页面

1. 选择一个已连接的远程服务器
2. 点击右上角的 **"打开 Shell 终端"** 按钮
3. 在终端中输入命令并回车执行

### 2. 通过 API 测试

```bash
# 执行单条命令
curl -X POST http://localhost:3001/api/remote/servers/<server-id>/shell \
  -H "Content-Type: application/json" \
  -d '{"command":"ls -la"}'
```

### 3. WebSocket 连接（浏览器控制台）

```javascript
const ws = new WebSocket('ws://localhost:3001/ws/shell/<server-id>');

ws.onmessage = (event) => {
  console.log('Output:', JSON.parse(event.data));
};

ws.send(JSON.stringify({ type: 'input', data: 'ls -la\n' }));
```

## 安全考虑

⚠️ **重要提示**：

1. **认证**：确保只有授权用户可以访问 Shell 功能
2. **命令限制**：`/api/remote/servers/:id/exec` 端点有白名单限制
3. **日志记录**：建议记录所有执行的命令（审计）
4. **生产环境**：建议添加：
   - 用户身份验证
   - 命令审计日志
   - 会话超时机制
   - IP 白名单

## 未来改进

- [ ] 支持 xterm.js 完整终端模拟
- [ ] 添加命令审计日志
- [ ] 支持多标签终端
- [ ] 添加文件上传/下载功能
- [ ] 支持 SFTP 浏览器

## 开发测试

```bash
# 启动服务器
cd openlog
node server/index.js

# 构建前端
npm run build

# 开发模式
npm run dev
```

## 文件清单

**后端**:
- `server/remote.js` - Shell 会话管理
- `server/index.js` - WebSocket 路由

**前端**:
- `client/src/components/ShellTerminal.tsx` - 终端组件
- `client/src/pages/Remote.tsx` - 集成页面

---

Made with ❤️ by OpenLog Team
