/**
 * routes/auth.js — 本地 token 获取端点
 *
 * 唯一一个「未鉴权」端点：它存在的意义就是让本机客户端拿到 token。
 * 因此它必须自己判断来源 IP，不能依赖 authMiddleware
 * （middleware 会先把没有 token 的请求挡掉，本端点就永远拿不到 token）。
 *
 * token 通过注入传入而不是直接读 process.env，这样 index.js 里的
 * AUTH_TOKEN 仍然是唯一来源（它有自己的生成/持久化逻辑）。
 */
import express from 'express';
import { isLoopbackAddress } from '../security/loopback.js';

export default function createAuthRouter({ authToken }) {
  const router = express.Router();

  router.get('/api/auth/token', (req, res) => {
    // 与 index.js 的开发模式鉴权旁路、WS 升级放行共用同一个判定函数
    if (!isLoopbackAddress(req.ip || req.connection?.remoteAddress)) {
      return res.status(403).json({ error: '仅允许本地访问' });
    }
    res.json({ token: authToken });
  });

  return router;
}
