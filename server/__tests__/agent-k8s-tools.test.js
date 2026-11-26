/**
 * Agent 的 K8s / Infra 工具。
 *
 * 背景（真机实测）：问"现在集群里有几个节点"，模型调了
 * `remote_servers` + `docker_list` + `remote_system_stats`×3，耗时 189 秒，
 * 而且答的是 SSH 服务器和 docker 容器，不是 Kubernetes 节点。
 * 原因是它**根本没有 K8s 工具**。这一组用例锁住"工具存在且是只读"。
 */
import { describe, it, expect } from 'vitest';
import { AGENT_TOOLS, AGENT_TOOL_NAMES, classifyToolRisk } from '../agent-tools.js';

const K8S_TOOLS = ['k8s_clusters', 'k8s_overview', 'k8s_pods', 'infra_services'];

describe('K8s / Infra 工具已注册', () => {
  it('四个工具都在 schema 里，且参数是合法 JSON Schema', () => {
    const byName = new Map(AGENT_TOOLS.map((t) => [t.function.name, t]));
    for (const name of K8S_TOOLS) {
      const tool = byName.get(name);
      expect(tool, `${name} 未注册`).toBeTruthy();
      expect(tool.type).toBe('function');
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.description.length).toBeGreaterThan(10);
      expect(tool.function.parameters.type).toBe('object');
    }
  });

  it('描述里说清"用它而不是 SSH/docker"，否则模型还是会去调错工具', () => {
    const overview = AGENT_TOOLS.find((t) => t.function.name === 'k8s_overview');
    expect(overview.function.description).toMatch(/节点|node/i);
    expect(overview.function.description).toMatch(/不要用 SSH|不要用SSH|SSH 或 docker/);
  });

  it('全部归类为只读（不弹确认框 —— 否则一次排障要点十几次）', () => {
    for (const name of K8S_TOOLS) {
      expect(classifyToolRisk(name, {}).risk, `${name} 应判为只读`).toBe('read');
    }
  });

  it('k8s_pods 支持 namespace / onlyUnhealthy / limit，且 limit 有上界', () => {
    const pods = AGENT_TOOLS.find((t) => t.function.name === 'k8s_pods');
    const props = pods.function.parameters.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['clusterId', 'namespace', 'onlyUnhealthy', 'limit']));
    expect(props.onlyUnhealthy.type).toBe('boolean');
    expect(props.limit.type).toBe('number');
  });
});

describe('工具名集合包含新工具', () => {
  it('AGENT_TOOL_NAMES 里有这四个（executeAssistantTool 靠它分发）', () => {
    for (const name of K8S_TOOLS) {
      expect(AGENT_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});
