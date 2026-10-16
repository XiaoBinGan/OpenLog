/**
 * routes/models.js — 可用模型列表（Ollama）
 *
 * 从 server/index.js 抽出。需要读取当前配置里的 openaiBaseUrl，
 * 而 settings 在 index.js 中是可被重新赋值的模块级绑定，
 * 因此通过工厂注入 ensureSettings() 取值函数，而不是直接注入值。
 */
import express from 'express';

import { errorMessage } from '../errors.js';
export function createModelsRouter({ ensureSettings }) {
  const router = express.Router();

  // 获取可用的 Ollama 模型
  router.get('/api/models/ollama', async (req, res) => {
    try {
      const baseUrl = ensureSettings().openaiBaseUrl || 'http://localhost:11434/v1';

      // 仅支持本地 Ollama 端点
      if (!baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
        return res.json({ models: [], error: '仅支持本地 Ollama' });
      }

      const response = await fetch(`${baseUrl.replace('/v1', '')}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const models = data.models?.map(m => m.name) || [];
      res.json({ models });
    } catch (err) {
      res.json({ models: [], error: errorMessage(err) });
    }
  });

  return router;
}

export default createModelsRouter;
