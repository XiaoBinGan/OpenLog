/**
 * security/loopback.js — 回环来源判定
 *
 * 这份逻辑原先有两份**各自独立**的副本：
 *   1. index.js 的 isLoopbackAddress()（用于开发模式鉴权旁路、WS 升级放行）
 *   2. /api/auth/token 路由里的内联判断（用于决定是否发放 token）
 *
 * 两份写的都是「剥掉 ::ffff: 前缀后比较 127.0.0.1 / ::1 / localhost」，
 * 但只要有人改了其中一份，另一份就会静默分叉 ——
 * 而这个判定的两端分别是「鉴权旁路」和「发放令牌」，分叉的代价是直接的安全缺口。
 *
 * 关于 ::ffff: 前缀：Node 在双栈监听下，IPv4 连接的对端地址常表现为
 * ::ffff:127.0.0.1。不剥前缀就会把本机连接判成非回环，
 * 表现为「本地客户端拿不到 token」——反过来，若判定写成宽松的前缀匹配，
 * 又会把 ::ffff:8.8.8.8 之类误判为回环。因此这里只做精确比较。
 */
export function isLoopbackAddress(addr) {
  const ip = String(addr || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

export default { isLoopbackAddress };
