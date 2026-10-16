/**
 * routes/analysis.js — 日志分析队列状态与历史
 *
 * 从 server/index.js 抽出。三处模块级状态通过工厂函数注入：
 *   analysisQueues  —— Map<sourceId, {running, pending[]}>
 *   analysisHistory —— 分析记录数组
 *   enqueueAnalysis —— 把 {log, source} 排入分析队列（定义在 index.js）
 */
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

export default function createAnalysisRouter({ analysisQueues, analysisHistory, enqueueAnalysis }) {
  const router = express.Router();

// 查询所有服务分析队列状态
router.get('/api/analysis/status', (req, res) => {
  const result = {};
  analysisQueues.forEach((q, sourceId) => {
    result[sourceId] = {
      pending: q.pending.length,
      running: q.running
    };
  });
  res.json({ queues: result, totalPending: [...analysisQueues.values()].reduce((s, q) => s + q.pending.length, 0) });
});

// 主动触发某服务的分析（POST body: { message, sourceId }）
router.post('/api/analysis/trigger', async (req, res) => {
  const { message, sourceId = 'manual', sourceName = '手动触发' } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const log = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    level: 'ERROR',
    message,
    source: sourceName,
    sourceId,
    metadata: JSON.stringify({ manual: true })
  };

  const source = { id: sourceId, name: sourceName, autoAnalysis: true };
  enqueueAnalysis(log, source);

  res.json({ success: true, message: '已加入分析队列', log });
});

// 获取分析历史记录
router.get('/api/analysis/history', (req, res) => {
  const { sourceId, status, limit = 50, offset = 0 } = req.query;
  let result = [...analysisHistory];
  if (sourceId) result = result.filter(r => r.sourceId === sourceId);
  if (status) result = result.filter(r => r.status === status);
  const total = result.length;
  result = result.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  res.json({ records: result, total });
});

// 分析历史摘要（供 @ 提及选择）
router.get('/api/analysis/history/brief', (_req, res) => {
  const brief = analysisHistory.slice(0, 30).map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    type: r.type || 'log',
    sourceName: r.sourceName,
    summary: (r.summary || r.log?.message || '').slice(0, 120),
    status: r.status,
    model: r.model,
  }));
  res.json({ records: brief });
});

// 删除单条分析历史
router.delete('/api/analysis/history/:id', (req, res) => {
  const idx = analysisHistory.findIndex(r => r.id === req.params.id);
  if (idx !== -1) { analysisHistory.splice(idx, 1); res.json({ success: true }); }
  else { res.status(404).json({ error: '记录不存在' }); }
});

// 清空分析历史
router.delete('/api/analysis/history', (req, res) => {
  analysisHistory.length = 0;
  res.json({ success: true });
});
  return router;
}
