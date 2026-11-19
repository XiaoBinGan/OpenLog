/**
 * 新增 / 编辑集群弹窗。
 *
 * 契约里「测试连接」是 `POST /api/k8s/clusters/:id/test` —— 必须有一个已存在的集群 id。
 * 所以新增场景下点「测试连接」会**先保存**（POST 创建），再用返回的 id 测试，
 * 之后点「保存」是对同一个 id 做 PUT。这一点在界面上直接写清楚，
 * 避免用户以为「取消」能撤销已经保存的 kubeconfig。
 */

import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Loader, Plug, X } from 'lucide-react';
import { apiJson } from '../../api/client';
import type { K8sClusterInput, K8sClusterView, K8sTestResponse, K8sTestState } from './types';
import { clusterApiPath, errorText } from './utils';

interface ClusterFormProps {
  /** null = 新增；否则是编辑该集群。 */
  cluster: K8sClusterView | null;
  onClose: () => void;
  /** 保存成功后回调（页面据此刷新列表并选中）。 */
  onSaved: (view: K8sClusterView) => void;
}

const inputClass =
  'w-full bg-dark-900 border border-dark-800 rounded-lg px-3 py-2 text-sm text-dark-200 ' +
  'placeholder:text-dark-600 focus:outline-none focus:border-accent-500/60';

function ClusterForm({ cluster, onClose, onSaved }: ClusterFormProps) {
  const [name, setName] = useState(cluster?.name ?? '');
  const [kubeconfig, setKubeconfig] = useState('');
  const [context, setContext] = useState(cluster?.context ?? '');
  const [savedId, setSavedId] = useState<string | null>(cluster?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<K8sTestState | null>(null);

  // Esc 关闭：弹窗里粘贴 kubeconfig 时手不会离开键盘
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const busy = saving || testing;

  /** 校验 + POST/PUT，返回服务端视图；失败时抛错由调用方决定怎么展示。 */
  async function persist(): Promise<K8sClusterView | null> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写集群名称');
      return null;
    }
    const text = kubeconfig.trim();
    if (!savedId && !text) {
      setError('请粘贴 kubeconfig');
      return null;
    }
    const payload: K8sClusterInput = {
      name: trimmedName,
      // 编辑时留空 = 沿用旧 kubeconfig（契约允许省略）
      ...(text ? { kubeconfig: text } : {}),
      ...(context.trim() ? { context: context.trim() } : {}),
    };
    const view = savedId
      ? await apiJson<K8sClusterView>(clusterApiPath(savedId, ''), 'PUT', payload)
      : await apiJson<K8sClusterView>('/api/k8s/clusters', 'POST', payload);
    if (view && view.id) {
      setSavedId(view.id);
      onSaved(view);
      return view;
    }
    throw new Error('服务端没有返回集群 id');
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const view = await persist();
      if (view) onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    setTest(null);
    let view: K8sClusterView | null = null;
    try {
      view = await persist();
    } catch (e) {
      setError(errorText(e));
      setTesting(false);
      return;
    }
    if (!view) {
      setTesting(false);
      return;
    }
    try {
      // 后端可能返回 200 + { ok:false }，也可能 502 + { error }（apiJson 会抛）
      const res = await apiJson<K8sTestResponse>(clusterApiPath(view.id, '/test'), 'POST');
      if (res && res.ok === false) {
        setTest({ ok: false, text: res.error || '连接失败' });
      } else {
        setTest({
          ok: true,
          text: `连接成功：v${res?.version || '?'} · ${res?.nodes ?? 0} 个节点`,
        });
      }
    } catch (e) {
      setTest({ ok: false, text: errorText(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative glass rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-dark-800/60">
          <div>
            <h2 className="text-base font-semibold text-dark-100">
              {cluster ? `编辑集群 · ${cluster.name}` : '添加 Kubernetes 集群'}
            </h2>
            <p className="text-xs text-dark-500 mt-0.5">
              kubeconfig 只在服务端保存，界面不会回显明文
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs text-dark-400 mb-1">名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 k3s-prod"
              className={inputClass}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs text-dark-400 mb-1">
              kubeconfig
              {cluster ? '（留空表示沿用已保存的内容）' : ''}
            </label>
            <textarea
              value={kubeconfig}
              onChange={(e) => setKubeconfig(e.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={'粘贴 kubeconfig 原文（YAML 或 JSON）\n支持客户端证书（client-certificate-data / client-key-data）、token 与 insecure-skip-tls-verify'}
              className={`${inputClass} font-mono text-xs leading-relaxed resize-y`}
            />
          </div>

          <div>
            <label className="block text-xs text-dark-400 mb-1">context（可选）</label>
            <input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="留空使用 current-context"
              className={inputClass}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <CircleAlert className="w-3.5 h-3.5 mt-px flex-shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {test && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                test.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-red-500/30 bg-red-500/10 text-red-300'
              }`}
            >
              {test.ok ? (
                <CircleCheck className="w-3.5 h-3.5 mt-px flex-shrink-0" />
              ) : (
                <CircleAlert className="w-3.5 h-3.5 mt-px flex-shrink-0" />
              )}
              <span className="break-words">{test.text}</span>
            </div>
          )}

          <p className="text-[11px] text-dark-600">
            「测试连接」会先保存配置（新增时即创建集群），再请求 apiserver 校验证书与 RBAC。
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-dark-800/60">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg bg-dark-800 text-dark-300 text-sm hover:bg-dark-700 transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => void handleTest()}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-dark-800 text-dark-200 text-sm hover:bg-dark-700 transition-colors disabled:opacity-50"
          >
            {testing ? <Loader className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
            测试连接
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={busy}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50"
          >
            {saving && <Loader className="w-4 h-4 animate-spin" />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default ClusterForm;
