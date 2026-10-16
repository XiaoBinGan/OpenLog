/**
 * settings 历史字段迁移。
 *
 * 背景：watchSources 的字段名换过一套。
 *   旧：{ id, name, logPath, watchFiles, enabled }
 *   新：{ id, name, path,    pattern,    enabled, autoAnalysis }
 *
 * 前端（Settings.tsx）与 startSourceWatcher 用的是**新**名，但数据库
 * `kv_store.app_settings` 里的数据仍是旧名。于是 startSourceWatcher 拿到
 * `source.path === undefined`，`fs.existsSync(undefined)` 返回 false，
 * 接着 `fs.mkdirSync(undefined)` 抛错并 return —— **日志监控静默不启动**，
 * 只在启动日志里留一行难以理解的
 * `The "path" argument must be of type string or an instance of Buffer or URL`。
 *
 * 迁移策略：把旧名**补成**新名，但**不删除旧名**。
 *
 * 为什么不删旧名：这样万一回退到旧版本，旧代码读 logPath 仍然能工作 ——
 * 迁移是双向安全的。代价是两个字段名会长期共存，所以另有一条不变量测试
 * （server/__tests__/settings-migration.test.js）钉住这个兼容性。
 *
 * 这个模块不依赖 index.js，因此可以单独单元测试（index.js 一 import 就会起服务）。
 */

/** 旧字段名 → 新字段名 */
export const FIELD_ALIASES = [
  ['logPath', 'path'],
  ['watchFiles', 'pattern'],
];

/**
 * 把 watchSources 里的旧字段名补成新字段名。
 *
 * 纯函数，不修改入参：
 * - 没有需要迁移的字段时返回**原对象引用**，调用方可用 `result !== input` 判断是否要落盘
 * - 已有新名时不覆盖（用户可能已经用新名配置过）
 * - 幂等：重复调用返回同一引用
 *
 * @param {unknown} settings
 * @returns {unknown} 迁移后的 settings（可能是原引用）
 */
export function migrateWatchSourceFields(settings) {
  if (!settings || typeof settings !== 'object' || !Array.isArray(settings.watchSources)) {
    return settings;
  }

  let changed = false;
  const watchSources = settings.watchSources.map((source) => {
    if (!source || typeof source !== 'object') return source;

    let next = null; // 懒拷贝：真的需要改才复制
    for (const [oldKey, newKey] of FIELD_ALIASES) {
      if (source[newKey] === undefined && typeof source[oldKey] === 'string') {
        if (!next) next = { ...source };
        next[newKey] = source[oldKey];
        changed = true;
      }
    }
    return next || source;
  });

  return changed ? { ...settings, watchSources } : settings;
}

export default migrateWatchSourceFields;
