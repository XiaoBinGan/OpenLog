/**
 * routes/skills.js — 技能、机器列表与告警配置
 *
 * 从 server/index.js 抽出。只依赖 db 层与 uuid，不引用 index.js 的内部状态。
 */
import express from 'express';
import { errorMessage } from '../errors.js';
import { v4 as uuidv4 } from 'uuid';
import {
  listSkills, createSkill, getSkill, updateSkill, deleteSkill,
  listMachines, listAlertConfigs, getAlertConfig, upsertAlertConfig,
} from '../db/index.js';

const router = express.Router();

// 获取所有技能
router.get('/api/skills', (req, res) => {
  try {
    const skills = listSkills();
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 创建技能
router.post('/api/skills', (req, res) => {
  const { name, command, description, content, category, is_default } = req.body;
  if (!name || !command) return res.status(400).json({ error: 'name and command required' });

  try {
    const skill = { id: uuidv4(), name, command, description, content, category, is_default };
    createSkill(skill);
    res.json({ success: true, skill });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 更新技能
router.put('/api/skills/:id', (req, res) => {
  const { name, command, description, content, category } = req.body;
  if (!name || !command) return res.status(400).json({ error: 'name and command required' });

  try {
    const existing = getSkill(req.params.id);
    if (!existing) return res.status(404).json({ error: '技能不存在' });
    if (existing.is_default) return res.status(403).json({ error: '内置技能不允许修改' });

    updateSkill(req.params.id, { name, command, description, content, category });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 删除技能
router.delete('/api/skills/:id', (req, res) => {
  try {
    const existing = getSkill(req.params.id);
    if (!existing) return res.status(404).json({ error: '技能不存在' });
    if (existing.is_default) return res.status(403).json({ error: '内置技能不允许删除' });

    deleteSkill(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 获取所有机器列表
router.get('/api/machines', (req, res) => {
  try {
    const machines = listMachines();
    res.json({ machines });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 获取所有告警配置
router.get('/api/alerts', (req, res) => {
  try {
    const configs = listAlertConfigs();
    res.json({ configs });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// 保存/更新告警配置
router.put('/api/alerts', (req, res) => {
  const { machine_id, enabled, patterns, severity_filter, cooldown_minutes, webhook_url } = req.body;
  if (!machine_id) return res.status(400).json({ error: 'machine_id is required' });

  try {
    const existing = getAlertConfig(machine_id);
    const config = {
      id: existing?.id || uuidv4(),
      machine_id,
      enabled: enabled !== undefined ? enabled : true,
      patterns: patterns || '',
      severity_filter: severity_filter || 'ERROR',
      cooldown_minutes: cooldown_minutes !== undefined ? cooldown_minutes : 5,
      webhook_url: webhook_url || '',
    };
    upsertAlertConfig(config);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;
