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
import { probeVisionSupport, probeVisionSupportCached, getCachedVisionSupport, setCachedVisionSupport } from '../vision-probe.js';

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

  /**
   * 视觉能力探测：当前模型到底能不能看图。
   *
   * 为什么不猜：Ollama 上多数纯文本模型对 image_url 不报错而是**静默忽略**，
   * 模型对着空图硬答，用户会以为是「AI 看歪了」，实际它根本没看到。
   * 所以这里真发一张洋红小图问颜色，答对才算 yes。
   *
   * 返回 supported: 'yes' | 'no' | 'unknown'
   *   unknown ≠ 不支持 —— 超时/限流/答非所问都归 unknown，界面只提示不阻止。
   */
  router.get('/api/models/vision', async (req, res) => {
    try {
      const settings = ensureSettings();
      const baseUrl = req.query.baseUrl ? String(req.query.baseUrl) : settings.openaiBaseUrl;
      const apiKey = req.query.apiKey ? String(req.query.apiKey) : settings.openaiApiKey;
      const model = req.query.model ? String(req.query.model) : settings.model;
      // fresh=1 强制重新探测（用户换了模型/引擎，或上次结论不可信）
      if (String(req.query.fresh || '') === '1') {
        // 直接用 probeVisionSupport，绕过缓存（ttl=0 那种写法依赖毫秒边界，不可靠）
        const result = await probeVisionSupport({ baseUrl, apiKey, model });
        if (result.supported !== 'unknown') setCachedVisionSupport(baseUrl, model, result);
        return res.json({ model, baseUrl: normalizeBaseUrl(baseUrl), ...result, cached: false });
      }
      const cached = getCachedVisionSupport(baseUrl, model);
      if (cached) {
        return res.json({ model, baseUrl: normalizeBaseUrl(baseUrl), ...cached, cached: true });
      }
      const result = await probeVisionSupportCached({ baseUrl, apiKey, model });
      res.json({ model, baseUrl: normalizeBaseUrl(baseUrl), ...result });
    } catch (err) {
      res.json({ supported: 'unknown', reason: errorMessage(err) });
    }
  });

  return router;
}

export default createModelsRouter;
