/**
 * 区块：Docker 连接配置（容器）——标题栏 + 添加按钮 + 数据源卡片列表 + 空态
 *
 * 负责什么：
 *   - 渲染外层 glass 卡片、合计的增删逻辑、每条 source 的「测试连接」请求（POST /api/docker/ping）
 *   - 按 source.id 保存测试状态（testing / ok / fail）与测试结果文案，以及主机地址下拉的展开态
 *
 * 为什么不放在父组件：
 *   dockerTestStatus / dockerTestMsg / hostDropdownOpen 三张 Map 只有 Docker 用得上；
 *   测试连接本身是一次网络请求 + toast，不该占用父组件的渲染函数。父组件只负责
 *   「dockerSources 数组放在哪」（保存时要一起 PUT），本区块负责这 500 行 UI。
 */
import { useCallback, useState } from 'react';
import { memo } from 'react';
import { Boxes, Plus } from 'lucide-react';
import { apiJson } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import type { DockerSource } from '../../types';
import DockerSourceCard from './DockerSourceCard';

export interface DockerSourcesSectionProps {
  dockerSources: DockerSource[];
  remoteServers: { id: string; host: string; name: string; port: number }[];
  /** 以 updater 形式写回 settings.dockerSources（保证卡片回调身份稳定，memo 才有效） */
  setDockerSources: (updater: (prev: DockerSource[]) => DockerSource[]) => void;
  onDirty: () => void;
}

function DockerSourcesSection({ dockerSources, remoteServers, setDockerSources, onDirty }: DockerSourcesSectionProps) {
  const sources = dockerSources || [];
  const toast = useToast();

  const [dockerTestStatus, setDockerTestStatus] = useState<Record<string, 'testing' | 'ok' | 'fail'>>({});
  const [dockerTestMsg, setDockerTestMsg] = useState<Record<string, string>>({});
  const [hostDropdownOpen, setHostDropdownOpen] = useState<Record<string, boolean>>({});

  const updateSource = useCallback((idx: number, patch: Partial<DockerSource>) => {
    setDockerSources(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
    onDirty();
  }, [setDockerSources, onDirty]);

  const removeSource = useCallback((idx: number) => {
    setDockerSources(prev => prev.filter((_, i) => i !== idx));
    onDirty();
  }, [setDockerSources, onDirty]);

  const addSource = useCallback(() => {
    const id = `docker-${Date.now()}`;
    setDockerSources(prev => [
      ...prev,
      { id, name: `Docker ${prev.length + 1}`, host: 'localhost', port: 2375, tls: false, enabled: true, autoAnalysis: true, projects: [] }
    ]);
    onDirty();
  }, [setDockerSources, onDirty]);

  const setOpenedHost = useCallback((id: string, open: boolean) => {
    setHostDropdownOpen(prev => ({ ...prev, [id]: open }));
  }, []);

  const testDocker = useCallback(async (ds: DockerSource) => {
    setDockerTestStatus(prev => ({ ...prev, [ds.id]: 'testing' }));
    try {
      const data = await apiJson<{ success?: boolean; name?: string; containers?: number; running?: number; error?: string }>('/api/docker/ping', 'POST', { sourceId: ds.id, config: ds.via?.serverId
          ? { via: { serverId: ds.via.serverId, socketPath: ds.via.socketPath || '/var/run/docker.sock' } }
          : {
              socketPath: ds.socketPath || undefined,
              host: ds.socketPath ? undefined : (ds.host || 'localhost'),
              port: ds.socketPath ? undefined : (ds.port || 2375),
              tls: ds.tls,
            } });
      if (data.success) {
        setDockerTestStatus(prev => ({ ...prev, [ds.id]: 'ok' }));
        setDockerTestMsg(prev => ({ ...prev, [ds.id]: `${data.name} ✅ ${data.containers} 容器 / ${data.running} 运行中` }));
        toast.success(`${ds.name} 连接成功 · ${data.running} 容器运行中`);
      } else {
        setDockerTestStatus(prev => ({ ...prev, [ds.id]: 'fail' }));
        setDockerTestMsg(prev => ({ ...prev, [ds.id]: data.error || '连接失败' }));
        toast.warning(`${ds.name} 连接失败`);
      }
    } catch (err: any) {
      setDockerTestStatus(prev => ({ ...prev, [ds.id]: 'fail' }));
      setDockerTestMsg(prev => ({ ...prev, [ds.id]: err.message }));
      toast.warning(`${ds.name} 连接失败: ${err.message}`);
    }
  }, [toast]);

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/20">
            <Boxes className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-dark-100">Docker 连接配置</h2>
            <p className="text-xs text-dark-500">每个配置项对应一个 Docker Server（守护进程），连接后自动发现其下所有容器</p>
          </div>
        </div>
        <button
          onClick={addSource}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-400 text-xs font-medium hover:bg-blue-500/25 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          添加 Docker
        </button>
      </div>

      <div className="space-y-3">
        {sources.map((ds, idx) => (
          <DockerSourceCard
            key={ds.id}
            ds={ds}
            idx={idx}
            count={sources.length}
            remoteServers={remoteServers}
            update={updateSource}
            remove={removeSource}
            onTest={testDocker}
            testStatus={dockerTestStatus[ds.id]}
            testMsg={dockerTestMsg[ds.id]}
            openedHost={!!hostDropdownOpen[ds.id]}
            setOpenedHost={setOpenedHost}
          />
        ))}
        {sources.length === 0 && (
          <div className="text-center py-8 text-dark-600 text-sm">
            <Boxes className="w-10 h-10 mx-auto mb-2 opacity-30" />
            暂未配置 Docker 连接，点击上方「添加 Docker」配置
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(DockerSourcesSection);