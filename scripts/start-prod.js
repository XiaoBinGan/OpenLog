/**
 * 跨平台生产模式启动入口。
 *
 * POSIX 上 `NODE_ENV=production node server/index.js` 能直接工作，
 * 但 Windows 的 cmd/PowerShell 不支持这种内联环境变量写法 → `npm start` 会失败。
 * 这里先把 NODE_ENV 默认设为 production 再加载服务端入口，两个平台行为一致。
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

await import('../server/index.js');
