/**
 * routes/settings.js — 配置读取与保存
 *
 * 从 server/index.js 抽出。`PUT /api/settings` 的价值几乎全在它的副作用上 ——
 * 它是一堆定时器/监听器的重启开关，因此依赖面比其它路由宽得多，
 * 全部通过工厂显式注入，让「改配置会触发什么」一眼可见：
 *
 *   ensureSettings            —— 读取当前生效配置（settings 是可重新赋值的绑定）
 *   saveSettings              —— 持久化到 settings.json
 *   startLogWatcher           —— watchSources / logPath / watchFiles 变化时重启日志监控
 *   restartDockerEventWatch   —— dockerSources / dockerEventNotify 变化时重启事件监听
 *   restartContainerPatrol    —— dockerSources / 巡检配置变化时重启容器巡检
 *   startMonitor              —— refreshInterval 变化时重启系统监控
 *
 * docker 模块直接 import（它是无状态的函数集合 + 一个导出的 Map）。
 */
import express from 'express';
import * as docker from '../docker.js';

/** 需要脱敏、且拒绝把脱敏值写回配置的字段。 */
export const SENSITIVE_KEYS = ['openaiApiKey'];

/**
 * 返回给客户端的配置副本：敏感字段只留首 4 位与末 4 位。
 *
 * GET 与 PUT 必须共用这一个函数。此前 PUT 返回的是未经脱敏的整个 settings 对象，
 * 会把明文 openaiApiKey 回显在响应体里 —— 同一个 key 在 GET 里是脱敏的，
 * 在 PUT 里却是明文，只要两处各写一遍就一定会再次分叉。
 */
function sanitizeSettings(source) {
  const sanitized = { ...source };
  if (sanitized.openaiApiKey && sanitized.openaiApiKey.length > 8) {
    sanitized.openaiApiKey = sanitized.openaiApiKey.slice(0, 4) + '***' + sanitized.openaiApiKey.slice(-4);
  }
  return sanitized;
}

export default function createSettingsRouter({
  ensureSettings,
  saveSettings,
  startLogWatcher,
  restartDockerEventWatch,
  restartContainerPatrol,
  startMonitor,
}) {
  const router = express.Router();

  router.get('/api/settings', (req, res) => {
    res.json(sanitizeSettings(ensureSettings()));
  });

  router.put('/api/settings', (req, res) => {
    const updates = req.body;

    const currentSettings = ensureSettings();
    for (const [key, value] of Object.entries(updates)) {
      // 拒绝保存脱敏后的敏感字段（含 *** 占位符）
      if (SENSITIVE_KEYS.includes(key) && typeof value === 'string' && value.includes('***') && value.length < 30) {
        continue;
      }
      currentSettings[key] = value;
    }

    // 持久化到文件
    saveSettings(ensureSettings());

    // 重启日志监控（watchSources 变化）
    if (updates.watchSources || updates.logPath || updates.watchFiles) {
      startLogWatcher();
    }

    // 重置 Docker 连接池（dockerSources 变化）
    if (updates.dockerSources) {
      // docker.js 里的 dockerInstances 是导出的 Map
      if (docker.dockerInstances) {
        docker.dockerInstances.forEach((_, k) => docker.dockerInstances.delete(k));
      }
      restartDockerEventWatch();
      restartContainerPatrol();
    }

    if (updates.dockerEventNotify !== undefined) {
      restartDockerEventWatch();
    }

    if (updates.containerPatrolEnabled !== undefined || updates.containerPatrolInterval !== undefined || updates.containerPatrolLevels !== undefined) {
      restartContainerPatrol();
    }

    if (updates.refreshInterval) {
      startMonitor();
    }

    // 注意：这里曾写作 res.json({ success: true, settings })，引用了一个只有
    // index.js 模块作用域里才存在的 settings 绑定 —— 文件搬家后就成了 ReferenceError。
    // 现在显式取当前值，并且与 GET 一样脱敏。
    res.json({ success: true, settings: sanitizeSettings(ensureSettings()) });
  });

  return router;
}
