import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Pencil, Trash2, Sparkles, ArrowRight,
  X, Check, BookOpen, ChevronDown, ChevronUp,
  Info, FileText, Target, ListChecks, Ban, FileOutput,
  Download, Upload,
} from 'lucide-react';

interface Skill {
  id: string;
  name: string;
  command: string;
  description: string;
  content: string;
  category: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}

const CATEGORIES = ['通用', 'Docker', '远程服务器', '系统', '日志', '数据库', '网络'];

// 新建技能时的 Markdown 模板
const SKILL_TEMPLATE = `## Purpose
描述这个技能的目标和适用场景。

## Workflow
1. 第一步：做什么
2. 第二步：检查什么
3. 第三步：分析什么
4. 第四步：给出结论

## Constraints
- 约束规则 1
- 约束规则 2
- 约束规则 3

## Output
1. 输出项 1
2. 输出项 2
3. 输出项 3`;

// 解析 Markdown 内容，提取 section 信息
function parseSections(content: string) {
  if (!content) return [];
  const sections: { heading: string; body: string }[] = [];
  const lines = content.split('\n');
  let currentHeading = '';
  let currentBody: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentHeading) sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
      currentHeading = line.replace('## ', '').trim();
      currentBody = [];
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }
  if (currentHeading) sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
  return sections;
}

// section heading → icon 映射
const sectionIcons: Record<string, React.ReactNode> = {
  'Purpose': <Target className="w-3.5 h-3.5" />,
  'Workflow': <ListChecks className="w-3.5 h-3.5" />,
  'Constraints': <Ban className="w-3.5 h-3.5" />,
  'Output': <FileOutput className="w-3.5 h-3.5" />,
};

export default function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [formName, setFormName] = useState('');
  const [formCmd, setFormCmd] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formCat, setFormCat] = useState('通用');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 导入结果状态
  const [importResult, setImportResult] = useState<{ success: number; skipped: number; failed: number; errors: string[] } | null>(null);

  // 导出技能
  const handleExport = async () => {
    try {
      const res = await fetch('/api/skills');
      if (!res.ok) throw new Error('加载技能失败');
      const data = await res.json();
      const skills = data.skills || [];
      const exportData = JSON.stringify(skills, null, 2);
      const blob = new Blob([exportData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `openlog-skills-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError('导出失败: ' + e.message);
    }
  };

  // 导入技能
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      let skills: Skill[];
      try {
        skills = JSON.parse(text);
        if (!Array.isArray(skills)) throw new Error('JSON 格式不正确，应为技能数组');
      } catch (parseErr: any) {
        setError('导入失败: 文件格式不正确，请选择有效的 JSON 文件');
        return;
      }

      let success = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const s of skills) {
        // 跳过内置技能
        if (s.is_default === 1) {
          skipped++;
          continue;
        }

        try {
          const body = {
            name: s.name || '',
            command: s.command || '',
            description: s.description || '',
            content: s.content || '',
            category: s.category || '通用',
          };

          if (!body.name.trim() || !body.command.trim()) {
            failed++;
            errors.push(`「${s.name || '(无名)'}」: 名称或任务简述为空`);
            continue;
          }

          const res = await fetch('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          if (res.ok) {
            success++;
          } else {
            const errData = await res.json().catch(() => ({}));
            failed++;
            errors.push(`「${body.name}」: ${errData.error || '创建失败'}`);
          }
        } catch (fetchErr: any) {
          failed++;
          errors.push(`「${s.name || '(无名)'}」: ${fetchErr.message}`);
        }
      }

      setImportResult({ success, skipped, failed, errors });
      await loadSkills();
    } catch (e: any) {
      setError('导入失败: ' + e.message);
    } finally {
      // 重置 file input，允许重复导入同一文件
      e.target.value = '';
    }
  };

  const loadSkills = async () => {
    try {
      const res = await fetch('/api/skills');
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json();
      setSkills(data.skills || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSkills(); }, []);

  const grouped = skills.reduce((acc, s) => {
    (acc[s.category || '通用'] ??= []).push(s);
    return acc;
  }, {} as Record<string, Skill[]>);

  const openCreate = () => {
    setEditing(null);
    setFormName('');
    setFormCmd('');
    setFormDesc('');
    setFormContent(SKILL_TEMPLATE);
    setFormCat('通用');
    setFormError('');
    setShowModal(true);
  };

  const openEdit = (s: Skill) => {
    setEditing(s);
    setFormName(s.name);
    setFormCmd(s.command);
    setFormDesc(s.description || '');
    setFormContent(s.content || '');
    setFormCat(s.category || '通用');
    setFormError('');
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formCmd.trim()) {
      setFormError('名称和任务简述不能为空');
      return;
    }
    if (formName.trim().length > 20) {
      setFormError('名称不能超过20个字');
      return;
    }
    setSaving(true);
    setFormError('');

    try {
      const url = editing ? `/api/skills/${editing.id}` : '/api/skills';
      const method = editing ? 'PUT' : 'POST';
      const body = {
        name: formName.trim(),
        command: formCmd.trim(),
        description: formDesc.trim(),
        content: formContent.trim(),
        category: formCat,
      };
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('保存失败');
      await loadSkills();
      setShowModal(false);
    } catch (e: any) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (s: Skill) => {
    try {
      const res = await fetch(`/api/skills/${s.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('删除失败');
      setDeleteTarget(null);
      await loadSkills();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const navigateToAssistant = (s: Skill) => {
    const content = s.content || s.command;
    const params = new URLSearchParams({ skill: s.name, cmd: content });
    navigate(`/assistant?${params.toString()}`);
  };

  const catColors: Record<string, string> = {
    '通用': 'bg-dark-800 text-dark-300',
    'Docker': 'bg-blue-500/10 text-blue-400',
    '远程服务器': 'bg-purple-500/10 text-purple-400',
    '系统': 'bg-green-500/10 text-green-400',
    '日志': 'bg-yellow-500/10 text-yellow-400',
    '数据库': 'bg-cyan-500/10 text-cyan-400',
    '网络': 'bg-pink-500/10 text-pink-400',
  };

  return (
    <div className="max-w-6xl mx-auto">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <BookOpen className="w-6 h-6 text-accent-500" />
          <div>
            <h1 className="text-xl font-semibold text-dark-100">技能管理</h1>
            <p className="text-xs text-dark-400 mt-0.5">
              共 <span className="text-accent-400 font-medium">{skills.length}</span> 个技能
              — 每个技能包含 Purpose、Workflow、Constraints、Output 标准章节
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 border border-dark-700 hover:bg-dark-800 text-dark-300 rounded-lg text-sm font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            导出
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-2 border border-dark-700 hover:bg-dark-800 text-dark-300 rounded-lg text-sm font-medium transition-colors"
          >
            <Upload className="w-4 h-4" />
            导入
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-accent-500 hover:bg-accent-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            新建技能
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 hover:text-red-300"><X className="w-3.5 h-3.5 inline" /></button>
        </div>
      )}

      {loading ? (
        <div className="text-center py-20 text-dark-400">加载中...</div>
      ) : skills.length === 0 ? (
        <div className="text-center py-20 text-dark-400">
          <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>暂无技能，点击"新建技能"创建</p>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(grouped).map(([cat, items]) => (
            <div key={cat}>
              <h2 className="text-sm font-medium text-dark-400 mb-3 flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${catColors[cat] || 'bg-dark-800 text-dark-300'}`}>
                  {cat}
                </span>
                <span className="text-dark-500 text-xs">{items.length} 个</span>
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {items.map(s => {
                  const sections = parseSections(s.content);
                  const isExpanded = expandedId === s.id;
                  return (
                    <div
                      key={s.id}
                      className="group bg-dark-900 border border-dark-800 rounded-xl hover:border-dark-700 transition-all overflow-hidden"
                    >
                      {/* Card Header */}
                      <div className="p-4">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <h3 className="font-medium text-dark-100 text-sm truncate">{s.name}</h3>
                            {s.is_default === 1 && (
                              <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-500/10 text-yellow-500 border border-yellow-500/20">
                                内置
                              </span>
                            )}
                          </div>
                          {s.is_default !== 1 && (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 ml-2">
                              <button onClick={() => openEdit(s)} className="p-1 rounded hover:bg-dark-700 text-dark-400 hover:text-dark-200">
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => setDeleteTarget(s)} className="p-1 rounded hover:bg-red-500/10 text-dark-400 hover:text-red-400">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                        {s.description && (
                          <p className="text-xs text-dark-400 mb-2">{s.description}</p>
                        )}
                        {!s.description && <div className="mb-2" />}

                        {/* Section pills */}
                        {sections.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mb-3">
                            {sections.map(sec => (
                              <span key={sec.heading} className="inline-flex items-center gap-1 px-2 py-0.5 bg-dark-800 rounded text-[10px] text-dark-300">
                                {sectionIcons[sec.heading]}
                                {sec.heading}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Expand toggle */}
                        {s.content && (
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : s.id)}
                            className="flex items-center gap-1 text-xs text-dark-400 hover:text-dark-300 transition-colors mb-3"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            {isExpanded ? '收起详情' : '展开详情'}
                            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </button>
                        )}

                        {/* Expanded content */}
                        {isExpanded && s.content && (
                          <div className="mb-3 bg-dark-950 border border-dark-800 rounded-lg p-3 max-h-64 overflow-y-auto">
                            {sections.map(sec => (
                              <div key={sec.heading} className="mb-2 last:mb-0">
                                <h4 className="text-xs font-semibold text-accent-400 mb-1">## {sec.heading}</h4>
                                <div className="text-[11px] text-dark-300 leading-relaxed whitespace-pre-wrap">
                                  {sec.body}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Use button */}
                        <button
                          onClick={() => navigateToAssistant(s)}
                          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-accent-500/10 hover:bg-accent-500/20 text-accent-400 rounded-lg text-xs font-medium transition-colors"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          在运维助手中使用
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 创建/编辑弹窗 */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 overflow-y-auto py-8" onClick={() => setShowModal(false)}>
          <div
            className="bg-dark-900 border border-dark-800 rounded-xl w-full max-w-2xl mx-4 p-6 my-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-dark-100">
                {editing ? '编辑技能' : '新建技能'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-dark-400 hover:text-dark-200">
                <X className="w-5 h-5" />
              </button>
            </div>

            {!editing && (
              <div className="mb-5 p-3 bg-accent-500/5 border border-accent-500/15 rounded-lg">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-accent-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-accent-300 font-medium mb-1">技能标准格式</p>
                    <p className="text-[11px] text-dark-400 leading-relaxed">
                      每个技能包含 <span className="text-dark-300">Purpose</span>（目标）、<span className="text-dark-300">Workflow</span>（步骤）、
                      <span className="text-dark-300">Constraints</span>（约束）、<span className="text-dark-300">Output</span>（输出格式）四个标准章节。
                      下方已预填模板，直接修改即可。
                    </p>
                  </div>
                </div>
              </div>
            )}

            {formError && (
              <div className="mb-4 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">{formError}</div>
            )}

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-dark-300 font-medium mb-1.5">名称 <span className="text-red-400">*</span></label>
                  <input
                    type="text"
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                    placeholder="如：磁盘空间检查"
                    maxLength={20}
                    className="w-full px-3 py-2 bg-dark-950 border border-dark-700 rounded-lg text-sm text-dark-100 placeholder-dark-600 focus:outline-none focus:border-accent-500"
                  />
                  <p className="text-[11px] text-dark-500 mt-1">不超过20字</p>
                </div>
                <div>
                  <label className="block text-xs text-dark-300 font-medium mb-1.5">分类</label>
                  <select
                    value={formCat}
                    onChange={e => setFormCat(e.target.value)}
                    className="w-full px-3 py-2 bg-dark-950 border border-dark-700 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-accent-500"
                  >
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-dark-300 font-medium mb-1.5">任务简述 <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={formCmd}
                  onChange={e => setFormCmd(e.target.value)}
                  placeholder="一句话概括这个技能做什么，如：排查磁盘空间不足问题，定位大文件并给出清理方案"
                  className="w-full px-3 py-2 bg-dark-950 border border-dark-700 rounded-lg text-sm text-dark-100 placeholder-dark-600 focus:outline-none focus:border-accent-500"
                />
              </div>

              <div>
                <label className="block text-xs text-dark-300 font-medium mb-1.5">用途说明</label>
                <input
                  type="text"
                  value={formDesc}
                  onChange={e => setFormDesc(e.target.value)}
                  placeholder="可选，一句话说明适用场景"
                  className="w-full px-3 py-2 bg-dark-950 border border-dark-700 rounded-lg text-sm text-dark-100 placeholder-dark-600 focus:outline-none focus:border-accent-500"
                />
              </div>

              <div>
                <label className="block text-xs text-dark-300 font-medium mb-1.5">
                  技能内容 <span className="text-red-400">*</span>
                  <span className="text-dark-500 font-normal ml-2">— Markdown 格式，支持 ## 标题</span>
                </label>
                <textarea
                  value={formContent}
                  onChange={e => setFormContent(e.target.value)}
                  rows={16}
                  className="w-full px-3 py-2 bg-dark-950 border border-dark-700 rounded-lg text-sm text-dark-100 placeholder-dark-600 focus:outline-none focus:border-accent-500 resize-none font-mono leading-relaxed"
                />
                <p className="text-[11px] text-dark-500 mt-1">
                  标准章节：<span className="text-dark-400">## Purpose → ## Workflow → ## Constraints → ## Output</span>。
                  每个章节描述做什么、怎么做、有什么约束、输出什么。
                </p>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2 border border-dark-700 rounded-lg text-sm text-dark-300 hover:bg-dark-800 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-accent-500 hover:bg-accent-600 disabled:opacity-50 rounded-lg text-sm font-medium text-white transition-colors flex items-center justify-center gap-1.5"
              >
                {saving ? (
                  '保存中...'
                ) : (
                  <><Check className="w-4 h-4" /> {editing ? '保存修改' : '创建技能'}</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDeleteTarget(null)}>
          <div className="bg-dark-900 border border-dark-800 rounded-xl w-full max-w-sm mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-dark-100 mb-2">确认删除</h2>
            <p className="text-sm text-dark-400 mb-5">
              确定要删除技能 <span className="text-dark-200 font-medium">「{deleteTarget.name}」</span> 吗？此操作不可恢复。
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)} className="flex-1 px-4 py-2 border border-dark-700 rounded-lg text-sm text-dark-300 hover:bg-dark-800 transition-colors">取消</button>
              <button onClick={() => handleDelete(deleteTarget)} className="flex-1 px-4 py-2 bg-red-500 hover:bg-red-600 rounded-lg text-sm font-medium text-white transition-colors">删除</button>
            </div>
          </div>
        </div>
      )}

      {/* 导入结果弹窗 */}
      {importResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setImportResult(null)}>
          <div className="bg-dark-900 border border-dark-800 rounded-xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-dark-100">导入结果</h2>
              <button onClick={() => setImportResult(null)} className="text-dark-400 hover:text-dark-200">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-2 mb-4">
              <div className="flex items-center justify-between p-2.5 bg-green-500/10 border border-green-500/20 rounded-lg">
                <span className="text-sm text-dark-300">成功导入</span>
                <span className="text-sm font-semibold text-green-400">{importResult.success} 个</span>
              </div>
              <div className="flex items-center justify-between p-2.5 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                <span className="text-sm text-dark-300">跳过（内置技能）</span>
                <span className="text-sm font-semibold text-yellow-400">{importResult.skipped} 个</span>
              </div>
              {importResult.failed > 0 && (
                <div className="flex items-center justify-between p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
                  <span className="text-sm text-dark-300">导入失败</span>
                  <span className="text-sm font-semibold text-red-400">{importResult.failed} 个</span>
                </div>
              )}
            </div>
            {importResult.errors.length > 0 && (
              <div className="mb-4 p-3 bg-dark-950 border border-dark-800 rounded-lg max-h-40 overflow-y-auto">
                <p className="text-xs text-dark-400 mb-2 font-medium">失败详情：</p>
                {importResult.errors.map((err, i) => (
                  <p key={i} className="text-xs text-red-400 leading-relaxed">{err}</p>
                ))}
              </div>
            )}
            <button
              onClick={() => setImportResult(null)}
              className="w-full px-4 py-2 bg-accent-500 hover:bg-accent-600 rounded-lg text-sm font-medium text-white transition-colors"
            >
              确定
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
