/**
 * routes/models.js — 可用模型列表。
 *
 * 不只是 Ollama：vLLM / SGLang / Strata / LM Studio / OpenAI 都提供标准
 * `GET /v1/models`，Ollama 还额外有 `/api/tags`。统一走 llm-provider.listModels()。
 *
 * 从 server/index.js 抽出。需要读取当前配置里的 openaiBaseUrl / openaiApiKey，
 * 而 settings 在 index.js 中是可被重新赋值的模块级绑定，因此通过工厂注入 ensureSettings()。
 */
import express from 'express';

import { errorMessage } from '../errors.js';
import { listModels, normalizeBaseUrl, guessEngine, ENGINE_HINTS } from '../llm-provider.js';

export function createModelsRouter({ ensureSettings }) {
  const router = express.Router();

  /**
   * 通用模型列表（vLLM / SGLang / Strata / Ollama / OpenAI 兼容）
   * 支持 query 覆盖：?baseUrl=...&apiKey=...（设置页「测试连接」时用，避免先保存）
   */
  router.get('/api/models', async (req, res) => {
    try {
      const settings = ensureSettings();
      const baseUrl = req.query.baseUrl ? String(req.query.baseUrl) : settings.openaiBaseUrl;
      const apiKey = req.query.apiKey ? String(req.query.apiKey) : settings.openaiApiKey;
      const result = await listModels(baseUrl, apiKey);
      const engine = result.engine && result.engine !== 'unknown' ? result.engine : guessEngine(baseUrl, '');
      res.json({
        ...result,
        baseUrl: normalizeBaseUrl(baseUrl),
        engine,
        engineName: ENGINE_HINTS[engine]?.name || engine,
      });
    } catch (err) {
      res.json({ ok: false, models: [], error: errorMessage(err) });
    }
  });

  /** 兼容旧路径：只查 Ollama */
  router.get('/api/models/ollama', async (req, res) => {
    try {
      const settings = ensureSettings();
      const baseUrl = settings.openaiBaseUrl || 'http://localhost:11434/v1';
      if (!/localhost|127\.0\.0\.1/.test(baseUrl)) {
        return res.json({ models: [], error: '仅支持本地 Ollama' });
      }
      const result = await listModels(baseUrl, settings.openaiApiKey);
      res.json({ models: result.models, error: result.ok ? undefined : result.error });
    } catch (err) {
      res.json({ models: [], error: errorMessage(err) });
    }
  });

  return router;
}

export default createModelsRouter;
