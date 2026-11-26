/**
 * Agent 的 K8s / Infra 工具。
 *
 * 背景（真机实测）：问"现在集群里有几个节点"，模型调了
 * `remote_servers` + `docker_list` + `remote_system_stats`×3，耗时 189 秒，
 * 而且答的是 SSH 服务器和 docker 容器，不是 Kubernetes 节点 —— 它当时没有 K8s 工具。
 *
 * 第二个坑（也踩了）：把 schema 放进 agent-tools.js 的 AGENT_TOOLS 后，
 * AGENT_TOOL_NAMES 收走了它们，index.js 抢先分发给 agent-tools 执行器，
 * 而那个执行器不认识它们 → 恒返回「未知 agent 工具」。表现为"工具出现了，但一句答案都没有"。
 *
 * 所以这组用例的核心是**锁住工具放在正确的位置**。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_TOOL_NAMES, classifyToolRisk } from '../agent-tools.js';

const K8S_TOOLS = ['k8s_clusters', 'k8s_overview', 'k8s_pods', 'infra_services'];
const root = path.resolve(import.meta.dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'routes/chat.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

describe('K8s / Infra 工具的 schema 在 ASSISTANT_TOOLS 里（不是 AGENT_TOOLS）', () => {
  it('四个工具的 schema 都能在 routes/chat.js 里找到', () => {
    for (const name of K8S_TOOLS) {
      expect(chatSrc, `${name} 的 schema 缺失`).toContain(`name: '${name}'`);
    }
  });

  it('绝不能进 AGENT_TOOL_NAMES —— 否则会被 agent-tools 执行器抢走并返回"未知工具"', () => {
    for (const name of K8S_TOOLS) {
      expect(AGENT_TOOL_NAMES.has(name), `${name} 不应在 AGENT_TOOL_NAMES 里`).toBe(false);
    }
  });

  it('执行器在 index.js 的 switch 里（四个 case 都在）', () => {
    for (const name of K8S_TOOLS) {
      expect(indexSrc, `${name} 缺少执行分支`).toContain(`case '${name}':`);
    }
  });

  it('描述里明确写"不要用 SSH / docker 查集群"，否则模型会挑错工具', () => {
    const overview = chatSrc.slice(chatSrc.indexOf("name: 'k8s_overview'"), chatSrc.indexOf("name: 'k8s_overview'") + 400);
    expect(overview).toMatch(/不要用 SSH|SSH 或 docker/);
    const clusters = chatSrc.slice(chatSrc.indexOf("name: 'k8s_clusters'"), chatSrc.indexOf("name: 'k8s_clusters'") + 400);
    expect(clusters).toMatch(/不要用 remote_exec 跑 kubectl/);
  });

  it('k8s_pods 支持 namespace / onlyUnhealthy / limit', () => {
    const seg = chatSrc.slice(chatSrc.indexOf("name: 'k8s_pods'"), chatSrc.indexOf("name: 'k8s_pods'") + 500);
    expect(seg).toContain('namespace');
    expect(seg).toContain('onlyUnhealthy');
    expect(seg).toContain('limit');
  });
});

describe('只读分类（不弹确认框）', () => {
  it('四个工具都判 read —— 否则一次排障要点十几次确认', () => {
    for (const name of K8S_TOOLS) {
      expect(classifyToolRisk(name, {}).risk, `${name} 应为只读`).toBe('read');
    }
  });
});

describe('kubectl 必须被引导到 k8s_* 工具', () => {
  const KUBECTL_RE = /^\s*(sudo\s+)?(kubectl|k(ubectl)?\s+get)\b/;

  it('识别各种写法，不误伤普通命令', () => {
    for (const cmd of ['kubectl get nodes', 'sudo kubectl get pods -A', '  kubectl describe pod x', 'kubectl']) {
      expect(KUBECTL_RE.test(cmd), cmd).toBe(true);
    }
    for (const cmd of ['ls -l', 'docker ps', 'systemctl status nginx', 'k6 run x.js']) {
      expect(KUBECTL_RE.test(cmd), cmd).toBe(false);
    }
  });

  it('index.js 的引导文案点名正确工具（模型会照抄这句）', () => {
    const idx = indexSrc.indexOf('不要用 remote_exec 跑 kubectl');
    expect(idx).toBeGreaterThan(-1);
    const seg = indexSrc.slice(idx, idx + 400);
    expect(seg).toContain('k8s_clusters');
    expect(seg).toMatch(/k8s_overview|k8s_pods/);
  });
});
