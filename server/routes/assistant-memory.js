/**
 * routes/assistant-memory.js — 运维助手知识库（内存文件）API
 *
 * 从 server/index.js 抽出。只依赖 fs/path 与自身管理的目录常量，
 * 不引用 index.js 的内部状态，因此直接导出 router。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();

export const ASSISTANT_MEMORY_DIR = path.join(__dirname, '..', '..', 'assistant_memory');
if (!fs.existsSync(ASSISTANT_MEMORY_DIR)) fs.mkdirSync(ASSISTANT_MEMORY_DIR, { recursive: true });

/**
 * 把用户提供的名字消毒成安全的文件名。
 *
 * 只允许字母、数字、下划线、中划线、中文；其余一律替换成 '-'，
 * 再去掉首尾连字符（避免产生 "---.md" 这类垃圾名，也避免文件名以
 * '-' 开头被误当成命令行参数）。
 *
 * 这既用于写入，也必须用于删除 —— 否则 `../../foo` 之类的名字会
 * 穿越出 ASSISTANT_MEMORY_DIR，删掉目录外的文件。
 *
 * @returns 安全的文件名（不含 .md 后缀），或 null 表示该名字不可用。
 */
export function sanitizeMemoryName(name) {
  const cleaned = String(name ?? '')
    .replace(/\.md$/, '')
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return null;
  return cleaned;
}

// 获取知识库文件列表
router.get('/api/assistant/memory', (req, res) => {
  try {
    const files = fs.readdirSync(ASSISTANT_MEMORY_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = path.join(ASSISTANT_MEMORY_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          name: f.replace(/\.md$/, ''),
          path: filePath,
          content: fs.readFileSync(filePath, 'utf8'),
          updatedAt: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: errorMessage(e) });
  }
});

// 写入知识库文件
router.post('/api/assistant/memory', (req, res) => {
  const { name, content } = req.body;
  if (!name || content === undefined) return res.status(400).json({ error: 'name and content required' });
  const safeName = sanitizeMemoryName(name);
  if (!safeName) return res.status(400).json({ error: 'invalid name' });
  const fileName = safeName + '.md';
  const filePath = path.join(ASSISTANT_MEMORY_DIR, fileName);
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ success: true, name: fileName });
  } catch (e) {
    res.status(500).json({ error: errorMessage(e) });
  }
});

// 删除知识库文件
router.delete('/api/assistant/memory/:name', (req, res) => {
  const safeName = sanitizeMemoryName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'invalid name' });
  const filePath = path.join(ASSISTANT_MEMORY_DIR, safeName + '.md');
  // 双保险：确认解析后的路径仍在知识库目录内
  if (path.dirname(path.resolve(filePath)) !== path.resolve(ASSISTANT_MEMORY_DIR)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: errorMessage(e) });
  }
});

export default router;
