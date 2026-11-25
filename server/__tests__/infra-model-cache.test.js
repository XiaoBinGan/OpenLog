/**
 * server/infra/model-cache.js 单测（B4）
 *
 * 覆盖四块：
 * 1. **校验**：合法配置、缺省推导（hostPath 自动共享 model.path）、路径穿越/相对路径/
 *    系统目录/readOnly=false/非法 mode/自相矛盾配置/PVC 各字段反例。
 * 2. **规划**：单节点多副本共享（shared:true + 「只读挂载，Pod 不写入」）、跨节点告警
 *    （「跨节点无法共享 hostPath，每节点各占 N GiB」）、RWX 才能跨节点共享、RWO 降级、
 *    nodeSelector 不匹配/部分匹配、空 nodes、已有缓存复用与冲突、整卡与切片两种资源形态。
 * 3. **估算**：给 sizeMiB / 给参数量+量化 / 都没给 三种假设、savedMiB 口径、
 *    nodeCount 夹取、67GB（strata Q2_0）真实量级。
 * 4. **渲染**：hostPath / pvc / none 三种产物、深拷贝隔离、畸形 plan 抛
 *    `INFRA_INVALID_CACHE_PLAN`、卷名对不上、readOnly 被改回 false。
 */
import { describe, it, expect } from 'vitest';

import {
  validateModelCache,
  planModelCache,
  estimateDiskUsage,
  renderCacheResources,
  CACHE_MODES,
  CACHE_STRATEGIES,
  CACHE_VOLUME_NAME,
  CACHE_MOUNT_PATH,
  DEFAULT_ASSUMED_SIZE_MIB,
  DISK_OVERHEAD_FACTOR,
  SHARED_ACCESS_MODE,
  ACCESS_MODES,
} from '../infra/model-cache.js';

// ---------------------------------------------------------------- 夹具

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 只在两边都是普通对象时递归合并；数组/原始值直接覆盖。 */
function deepMerge(base, patch) {
  if (!isPlain(patch) || !isPlain(base)) return patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = isPlain(patch[key]) && isPlain(base[key]) ? deepMerge(base[key], patch[key]) : patch[key];
  }
  return out;
}

/** 最小合法服务：hostPath 来源、单副本、单卡。 */
function minimal() {
  return {
    name: 'qwen3-8b',
    namespace: 'inference',
    model: { source: 'hostPath', path: '/models/Qwen3-8B' },
    engine: { type: 'vllm', image: 'vllm/vllm-openai:v0.11.0' },
    resources: { accelerators: 1, memoryMiB: 4096, coresPercent: 50 },
    replicas: 1,
    ports: [{ name: 'http', containerPort: 8000 }],
  };
}

function svc(patch = {}) {
  return deepMerge(minimal(), patch);
}

/** 单节点 + 4 副本 + 67GB 权重：真机踩坑的那个形状（strata Q2_0 = 67GB）。 */
function strataLike(patch = {}) {
  return svc({
    name: 'strata-q2',
    model: { source: 'hostPath', path: '/models/strata-Q2_0', sizeMiB: 68608 },
    replicas: 4,
    ...patch,
  });
}

function errorFields(validation) {
  return validation.errors.map((error) => error.field);
}

function errorText(validation) {
  return validation.errors.map((error) => error.message).join(' | ');
}

// ---------------------------------------------------------------- 1. 校验

describe('validateModelCache：合法配置与缺省推导', () => {
  it('合法 hostPath：归一化尾斜杠、只读、同路径挂载', () => {
    const result = validateModelCache({
      service: svc(),
      cache: { mode: 'hostPath', hostPath: '/models/shared//Qwen3-8B/' },
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value.mode).toBe('hostPath');
    expect(result.value.hostPath).toBe('/models/shared/Qwen3-8B');
    expect(result.value.mountPath).toBe('/models/shared/Qwen3-8B');
    expect(result.value.readOnly).toBe(true);
    expect(result.value.pvc).toBeNull();
    expect(result.value.serviceKey).toBe('inference/qwen3-8b');
    expect(result.value.derived).toBe(false);
  });

  it('没给 cache 且 model.source=hostPath：自动按 hostPath 共享 model.path（derived）', () => {
    const result = validateModelCache({ service: svc() });

    expect(result.ok).toBe(true);
    expect(result.value.mode).toBe('hostPath');
    expect(result.value.hostPath).toBe('/models/Qwen3-8B');
    expect(result.value.mountPath).toBe('/models/Qwen3-8B');
    expect(result.value.derived).toBe(true);
  });

  it('没给 cache 且来自远端仓库：mode=none（不臆造挂载）', () => {
    const result = validateModelCache({
      service: svc({ model: { source: 'huggingface', path: 'Qwen/Qwen3-8B' } }),
    });

    expect(result.ok).toBe(true);
    expect(result.value.mode).toBe('none');
    expect(result.value.hostPath).toBe('');
    expect(result.value.mountPath).toBe('');
  });

  it('合法 RWX PVC：accessModes 去重排序并保留 ReadWriteMany', () => {
    const result = validateModelCache({
      service: svc({ model: { source: 'pvc', path: '/models/Qwen3-8B' } }),
      cache: {
        mode: 'pvc',
        pvc: { claimName: 'model-cache-rwx', accessModes: ['ReadWriteMany', 'ReadWriteOnce', 'ReadWriteMany'], size: '200Gi' },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.value.pvc.claimName).toBe('model-cache-rwx');
    expect(result.value.pvc.accessModes).toEqual(['ReadWriteMany', 'ReadWriteOnce']);
    expect(result.value.pvc.size).toBe('200Gi');
    expect(result.value.pvc.readOnly).toBe(true);
    expect(result.value.mountPath).toBe(CACHE_MOUNT_PATH);
  });
});

describe('validateModelCache：反例（路径与配置）', () => {
  it('拒绝目录穿越：hostPath 含 ".."', () => {
    const result = validateModelCache({
      service: svc(),
      cache: { mode: 'hostPath', hostPath: '/models/../../etc/shadow' },
    });

    expect(result.ok).toBe(false);
    expect(errorFields(result)).toContain('cache.hostPath');
    expect(errorText(result)).toContain('..');
    expect(result.value.hostPath).toBe('');
  });

  it('拒绝相对路径：hostPath 不以 / 开头', () => {
    const result = validateModelCache({
      service: svc(),
      cache: { mode: 'hostPath', hostPath: 'models/Qwen3-8B' },
    });

    expect(result.ok).toBe(false);
    expect(errorFields(result)).toContain('cache.hostPath');
    expect(errorText(result)).toContain('绝对路径');
  });

  it('拒绝宿主机系统目录：/ 与 /etc/passwd', () => {
    const root = validateModelCache({ service: svc(), cache: { mode: 'hostPath', hostPath: '/' } });
    const etc = validateModelCache({ service: svc(), cache: { mode: 'hostPath', hostPath: '/etc/passwd' } });

    expect(root.ok).toBe(false);
    expect(etc.ok).toBe(false);
    expect(errorText(root)).toContain('系统目录');
    expect(errorText(etc)).toContain('系统目录');
  });

  it('拒绝挂载点穿越与相对挂载点', () => {
    const traversal = validateModelCache({
      service: svc(),
      cache: { mode: 'hostPath', hostPath: '/models/Qwen3-8B', mountPath: '/models/../etc' },
    });
    const relative = validateModelCache({
      service: svc(),
      cache: { mode: 'hostPath', hostPath: '/models/Qwen3-8B', mountPath: 'models' },
    });

    expect(errorFields(traversal)).toContain('cache.mountPath');
    expect(errorText(relative)).toContain('绝对路径');
  });

  it('readOnly=false 直接拒绝：共享目录可写会写坏权重', () => {
    const result = validateModelCache({
      service: svc(),
      cache: { mode: 'hostPath', hostPath: '/models/Qwen3-8B', readOnly: false },
    });

    expect(result.ok).toBe(false);
    expect(errorFields(result)).toContain('cache.readOnly');
    expect(errorText(result)).toContain('只读');
  });

  it('非法 cache 配置：mode 未知 / cache 不是对象 / mode=none 又给 hostPath', () => {
    const badMode = validateModelCache({ service: svc(), cache: { mode: 'nfs', hostPath: '/models/x' } });
    const notObject = validateModelCache({ service: svc(), cache: 'hostPath' });
    const contradiction = validateModelCache({ service: svc(), cache: { mode: 'none', hostPath: '/models/x' } });

    expect(badMode.ok).toBe(false);
    expect(errorText(badMode)).toContain('cache.mode');
    expect(badMode.errors[0].message).toContain(CACHE_MODES.join(' / '));

    expect(notObject.ok).toBe(false);
    expect(errorFields(notObject)).toContain('cache');

    expect(contradiction.ok).toBe(false);
    expect(errorText(contradiction)).toContain('自相矛盾');
  });

  it('PVC 反例：缺 claimName / accessModes 空 / accessModes 非法 / subPath 穿越', () => {
    const pvcService = svc({ model: { source: 'pvc', path: '/models/Qwen3-8B' } });

    const noClaim = validateModelCache({ service: pvcService, cache: { mode: 'pvc', pvc: { accessModes: ['ReadWriteMany'] } } });
    const emptyModes = validateModelCache({ service: pvcService, cache: { mode: 'pvc', pvc: { claimName: 'c', accessModes: [] } } });
    const badMode = validateModelCache({ service: pvcService, cache: { mode: 'pvc', pvc: { claimName: 'c', accessModes: ['ReadWrite'] } } });
    const badSubPath = validateModelCache({
      service: pvcService,
      cache: { mode: 'pvc', pvc: { claimName: 'c', accessModes: ['ReadWriteMany'], subPath: '../etc' } },
    });

    expect(errorFields(noClaim)).toContain('cache.pvc.claimName');
    expect(errorFields(emptyModes)).toContain('cache.pvc.accessModes');
    expect(errorFields(badMode)).toContain('cache.pvc.accessModes[0]');
    expect(errorText(badMode)).toContain(ACCESS_MODES.join(' / '));
    expect(errorFields(badSubPath)).toContain('cache.pvc.subPath');
  });

  it('service 不合法时把错误归到 service.* 前缀下', () => {
    const result = validateModelCache({ service: svc({ namespace: 'kube-system' }), cache: { mode: 'hostPath', hostPath: '/models/x' } });

    expect(result.ok).toBe(false);
    expect(errorFields(result)).toContain('service.namespace');
    expect(errorText(result)).toContain('inference');
  });
});

// ---------------------------------------------------------------- 2. 规划

describe('planModelCache：同节点共享与跨节点告警', () => {
  it('单节点多副本 hostPath：shared=true，挂只读目录，warnings 说明 Pod 不写入', () => {
    const plan = planModelCache({
      service: strataLike(),
      nodes: [{ name: 'node1', labels: { 'gpu-type': '4090' } }],
    });

    expect(plan.ok).toBe(true);
    expect(plan.strategy).toBe('hostPath');
    expect(plan.shared).toBe(true);
    expect(plan.nodeCount).toBe(1);
    expect(plan.replicas).toBe(4);
    expect(plan.volumes).toEqual([
      { name: CACHE_VOLUME_NAME, hostPath: { path: '/models/strata-Q2_0', type: 'Directory' } },
    ]);
    expect(plan.volumeMounts).toEqual([
      { name: CACHE_VOLUME_NAME, mountPath: '/models/strata-Q2_0', readOnly: true },
    ]);
    expect(plan.warnings.join('\n')).toContain('只读挂载，Pod 不写入');
    // 4 副本 × 67 GiB 只占一份：省下 3 份
    expect(plan.estimate.savedMiB).toBe(68608 * 3);
    expect(plan.warnings.join('\n')).toContain('201.0 GiB');
  });

  it('跨节点 hostPath：shared=false + 「跨节点无法共享 hostPath，每节点各占 N GiB」', () => {
    const plan = planModelCache({
      service: strataLike(),
      nodes: ['node1', 'node2'],
    });

    expect(plan.strategy).toBe('hostPath');
    expect(plan.shared).toBe(false);
    expect(plan.nodeCount).toBe(2);
    expect(plan.downgraded).toBe(true);

    const text = plan.warnings.join('\n');
    expect(text).toContain('跨节点无法共享 hostPath，每节点各占');
    expect(text).toContain('67.0 GiB');
    expect(text).toContain('如需真共享请用 RWX PVC 或 NFS');
    // 共享后仍占 2 份，比每 Pod 各一份省 2 份
    expect(plan.estimate.totalMiB).toBe(68608 * 2);
    expect(plan.estimate.savedMiB).toBe(68608 * 2);
  });

  it('空 nodes：按单节点估算并明确告警（不静默假设）', () => {
    const plan = planModelCache({ service: strataLike(), nodes: [] });

    expect(plan.nodeCount).toBe(1);
    expect(plan.shared).toBe(true);
    expect(plan.warnings.join('\n')).toContain('未提供节点清单');
    expect(plan.warnings.join('\n')).toContain('单节点');
  });

  it('RWX PVC 才能跨节点共享：strategy=pvc-rwx、shared=true', () => {
    const plan = planModelCache({
      service: svc({
        model: { source: 'pvc', path: '/models/Qwen3-8B' },
        replicas: 3,
        cache: {
          mode: 'pvc',
          pvc: { claimName: 'model-cache-rwx', accessModes: ['ReadWriteMany'] },
        },
      }),
      nodes: ['node1', 'node2', 'node3'],
    });

    expect(plan.strategy).toBe('pvc-rwx');
    expect(plan.shared).toBe(true);
    expect(plan.nodeCount).toBe(3);
    expect(plan.volumes).toEqual([
      { name: CACHE_VOLUME_NAME, persistentVolumeClaim: { claimName: 'model-cache-rwx', readOnly: true } },
    ]);
    expect(plan.volumeMounts[0]).toEqual({ name: CACHE_VOLUME_NAME, mountPath: CACHE_MOUNT_PATH, readOnly: true });
    expect(plan.warnings.join('\n')).toContain(SHARED_ACCESS_MODE);
    expect(plan.warnings.join('\n')).toContain('只读挂载，Pod 不写入');
  });

  it('RWO PVC 跨节点降级：strategy=pvc-rwo、shared=false、告警指路 RWX', () => {
    const plan = planModelCache({
      service: svc({
        model: { source: 'pvc', path: '/models/Qwen3-8B' },
        replicas: 4,
        cache: { mode: 'pvc', pvc: { claimName: 'model-cache-rwo', accessModes: ['ReadWriteOnce'] } },
      }),
      nodes: ['node1', 'node2'],
    });

    expect(plan.strategy).toBe('pvc-rwo');
    expect(plan.shared).toBe(false);
    expect(plan.downgraded).toBe(true);
    const text = plan.warnings.join('\n');
    expect(text).toContain('不含 ReadWriteMany');
    expect(text).toContain('ReadWriteOnce');
    expect(text).toContain('跨节点无法共享');
    expect(plan.volumes[0].persistentVolumeClaim.claimName).toBe('model-cache-rwo');
  });

  it('RWO PVC 单节点：同节点多副本仍可共享（shared=true），但仍提示降级事实', () => {
    const plan = planModelCache({
      service: svc({
        model: { source: 'pvc', path: '/models/Qwen3-8B' },
        replicas: 3,
        cache: { mode: 'pvc', pvc: { claimName: 'model-cache-rwo', accessModes: ['ReadWriteOnce'] } },
      }),
      nodes: ['node1'],
    });

    expect(plan.strategy).toBe('pvc-rwo');
    expect(plan.shared).toBe(true);
    expect(plan.downgraded).toBe(true);
    expect(plan.warnings.join('\n')).toContain('不含 ReadWriteMany');
    expect(plan.warnings.join('\n')).toContain('单节点');
  });

  it('整卡与切片两种资源形态：缓存规划完全一致（策略只跟存储有关）', () => {
    const whole = planModelCache({
      service: strataLike({ resources: { accelerators: 1, memoryMiB: 0, coresPercent: 0 } }),
      nodes: ['node1'],
    });
    const slice = planModelCache({
      service: strataLike({ resources: { accelerators: 2, memoryMiB: 24000, coresPercent: 60 } }),
      nodes: ['node1'],
    });

    expect(whole.strategy).toBe('hostPath');
    expect(whole.shared).toBe(true);
    expect(whole.volumes).toEqual(slice.volumes);
    expect(whole.volumeMounts).toEqual(slice.volumeMounts);
    expect(whole.mountPath).toBe(slice.mountPath);
    expect(whole.replicas).toBe(slice.replicas);
  });

  it('nodeSelector 与缓存节点完全不匹配：告警（缓存与 Pod 会落在不同节点）', () => {
    const plan = planModelCache({
      service: strataLike({ placement: { nodeSelector: { 'gpu-type': '4090' } } }),
      nodes: [
        { name: 'node1', labels: { 'gpu-type': '3090' } },
        { name: 'node2', labels: {} },
      ],
    });

    expect(plan.warnings.join('\n')).toContain('nodeSelector 与缓存节点不匹配');
    expect(plan.warnings.join('\n')).toContain('gpu-type=4090');
    // 一个都不匹配时退回全量节点，避免把跨节点风险算漏 → shared=false
    expect(plan.nodeCount).toBe(2);
    expect(plan.shared).toBe(false);
  });

  it('nodeSelector 部分匹配：只按匹配节点算共享并告警', () => {
    const plan = planModelCache({
      service: strataLike({ placement: { nodeSelector: { 'gpu-type': '4090' } } }),
      nodes: [
        { name: 'node1', labels: { 'gpu-type': '4090' } },
        { name: 'node2', labels: { 'gpu-type': '3090' } },
      ],
    });

    expect(plan.nodes).toEqual(['node1']);
    expect(plan.nodeCount).toBe(1);
    expect(plan.shared).toBe(true);
    expect(plan.warnings.join('\n')).toContain('只匹配 1/2 个节点');
  });

  it('未配置缓存（远端模型）→ strategy=none 且算出「每 Pod 各一份」的盘', () => {
    const plan = planModelCache({
      service: svc({
        model: { source: 'huggingface', path: 'Qwen/Qwen3-8B', sizeMiB: 16384 },
        replicas: 3,
      }),
      nodes: ['node1', 'node2'],
    });

    expect(plan.strategy).toBe('none');
    expect(plan.shared).toBe(false);
    expect(plan.volumes).toEqual([]);
    expect(plan.volumeMounts).toEqual([]);
    const text = plan.warnings.join('\n');
    expect(text).toContain('各拷一份');
    expect(text).toContain('DiskPressure');
    expect(text).toContain('48.0 GiB'); // 3 × 16 GiB
  });

  it('缓存配置不合法：plan 不崩，ok=false 且 warnings 带中文原因', () => {
    const plan = planModelCache({
      service: strataLike(),
      nodes: ['node1'],
      cache: { mode: 'hostPath', hostPath: '/models/../etc' },
    });

    expect(plan.ok).toBe(false);
    expect(plan.strategy).toBe('none');
    expect(plan.volumes).toEqual([]);
    expect(plan.shared).toBe(false);
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.warnings.join('\n')).toContain('缓存配置不合法');
    expect(plan.warnings.join('\n')).toContain('..');
  });

  it('已有缓存：同路径提示复用，异路径提示会重复占盘', () => {
    const reuse = planModelCache({
      service: strataLike(),
      nodes: ['node1'],
      existingCaches: [{ node: 'node1', path: '/models/strata-Q2_0/', sizeMiB: 68608 }],
    });
    const conflict = planModelCache({
      service: strataLike(),
      nodes: ['node1'],
      existingCaches: [{ node: 'node1', path: '/models/strata-old', sizeMiB: 1024 }],
    });

    expect(reuse.reused).toHaveLength(1);
    expect(reuse.warnings.join('\n')).toContain('复用节点 node1 上已有缓存');
    expect(conflict.warnings.join('\n')).toContain('不一致');
    expect(conflict.warnings.join('\n')).toContain('/models/strata-old');
  });

  it('plan 是确定性的：同输入两次调用 deepEqual', () => {
    const input = {
      service: strataLike({ placement: { nodeSelector: { 'gpu-type': '4090' } } }),
      nodes: [{ name: 'node1', labels: { 'gpu-type': '4090' } }, 'node2'],
      existingCaches: [{ node: 'node2', path: '/models/strata-Q2_0', sizeMiB: 68608 }],
    };

    expect(JSON.stringify(planModelCache(input))).toBe(JSON.stringify(planModelCache(input)));
  });
});

// ---------------------------------------------------------------- 3. 估算

describe('estimateDiskUsage：三种假设与 savedMiB 口径', () => {
  it('假设一：给了 model.sizeMiB → 直接采用，source=sizeMiB', () => {
    const result = estimateDiskUsage({ model: { sizeMiB: 68608 }, replicas: 1, nodeCount: 1 });

    expect(result.perPodMiB).toBe(68608);
    expect(result.totalMiB).toBe(68608);
    expect(result.savedMiB).toBe(0);
    expect(result.source).toBe('sizeMiB');
    expect(result.assumption).toContain('model.sizeMiB');
    expect(result.assumption).toContain('67.0 GiB');
  });

  it('假设二：给了参数量+量化 → 按位宽推断，assumption 写清公式与误差', () => {
    const result = estimateDiskUsage({
      model: { parametersB: 8, quantization: 'fp16' },
      replicas: 2,
      nodeCount: 1,
    });

    // 8B × 16bit / 8 = 16 GB ≈ 15259 MiB，再乘 5% 余量 ≈ 16022 MiB
    expect(result.source).toBe('quantization');
    expect(result.bitsPerWeight).toBe(16);
    expect(result.parametersB).toBe(8);
    expect(result.perPodMiB).toBeGreaterThan(15000);
    expect(result.perPodMiB).toBeLessThan(16500);
    expect(result.perPodMiB).toBe(Math.round(((8 * 1e9 * 2) / (1024 * 1024)) * DISK_OVERHEAD_FACTOR));
    expect(result.assumption).toContain('bit/权重');
    expect(result.assumption).toContain('±10%');
  });

  it('假设二补充：Q2_0 量化能被识别（strata 那个 67GB 的档位）', () => {
    const result = estimateDiskUsage({ model: { parametersB: 224, quantization: 'Q2_0' }, replicas: 1 });

    expect(result.source).toBe('quantization');
    expect(result.bitsPerWeight).toBe(2.56);
    // 224B × 2.56bit ≈ 68.4 GiB 量级，与真机实测的 67GB 差 ~5%（±10% 口径内）
    expect(result.perPodMiB).toBeGreaterThan(60000);
    expect(result.perPodMiB).toBeLessThan(75000);
    const delta = Math.abs(result.perPodMiB - 68608) / 68608;
    expect(delta).toBeLessThan(0.1);
  });

  it('假设三：都没给 → 保守默认值，assumption 明确说误差可能极大', () => {
    const result = estimateDiskUsage({ model: {}, replicas: 3, nodeCount: 1 });

    expect(result.source).toBe('default');
    expect(result.perPodMiB).toBe(DEFAULT_ASSUMED_SIZE_MIB);
    expect(result.assumption).toContain('保守默认');
    expect(result.assumption).toContain('差数倍');
  });

  it('savedMiB：单节点 3 副本共享 = 省 2 份', () => {
    const result = estimateDiskUsage({ model: { sizeMiB: 8192 }, replicas: 3, nodeCount: 1 });

    expect(result.naiveMiB).toBe(8192 * 3);
    expect(result.totalMiB).toBe(8192);
    expect(result.savedMiB).toBe(8192 * 2);
  });

  it('savedMiB：跨 2 节点 4 副本 = 只省 2 份（每节点各占一份）', () => {
    const result = estimateDiskUsage({ model: { sizeMiB: 1024 }, replicas: 4, nodeCount: 2 });

    expect(result.perPodMiB).toBe(1024);
    expect(result.totalMiB).toBe(2048);
    expect(result.savedMiB).toBe(2048);
    expect(result.assumption).toContain('2 个节点');
  });

  it('参数夹取：nodeCount 不能超过 replicas，非法 replicas 回落到合法区间', () => {
    const clampedNodes = estimateDiskUsage({ model: { sizeMiB: 1024 }, replicas: 2, nodeCount: 9 });
    expect(clampedNodes.nodeCount).toBe(2);
    expect(clampedNodes.savedMiB).toBe(0);

    const clampedReplicas = estimateDiskUsage({ model: { sizeMiB: 1024 }, replicas: 99, nodeCount: 1 });
    expect(clampedReplicas.replicas).toBe(64);
    expect(clampedReplicas.assumption).toContain('replicas');
  });

  it('非法 sizeMiB（0 / 负数 / 非数字）不会被当成真值', () => {
    for (const sizeMiB of [0, -1, '68608', null]) {
      const result = estimateDiskUsage({ model: { sizeMiB, parametersB: 8, quantization: 'fp16' }, replicas: 1 });
      expect(result.source).toBe('quantization');
      expect(result.perPodMiB).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------- 4. 渲染

describe('renderCacheResources：产物与防护', () => {
  it('hostPath plan → volumes / volumeMounts 可直接塞进 Deployment', () => {
    const plan = planModelCache({ service: strataLike(), nodes: ['node1'] });
    const rendered = renderCacheResources({ plan });

    expect(rendered).toEqual({
      volumes: [{ name: CACHE_VOLUME_NAME, hostPath: { path: '/models/strata-Q2_0', type: 'Directory' } }],
      volumeMounts: [{ name: CACHE_VOLUME_NAME, mountPath: '/models/strata-Q2_0', readOnly: true }],
    });
  });

  it('pvc plan → persistentVolumeClaim 只读；subPath 透传', () => {
    const plan = planModelCache({
      service: svc({
        model: { source: 'pvc', path: '/models/Qwen3-8B' },
        cache: {
          mode: 'pvc',
          pvc: { claimName: 'model-cache-rwx', accessModes: ['ReadWriteMany'], subPath: 'Qwen3-8B' },
        },
      }),
      nodes: ['node1', 'node2'],
    });
    const rendered = renderCacheResources({ plan });

    expect(rendered.volumes).toEqual([
      { name: CACHE_VOLUME_NAME, persistentVolumeClaim: { claimName: 'model-cache-rwx', readOnly: true } },
    ]);
    expect(rendered.volumeMounts).toEqual([
      { name: CACHE_VOLUME_NAME, mountPath: CACHE_MOUNT_PATH, readOnly: true, subPath: 'Qwen3-8B' },
    ]);
  });

  it('strategy=none → 空数组（render.js 可以无条件赋值）', () => {
    const plan = planModelCache({
      service: svc({ model: { source: 'modelscope', path: 'Qwen/Qwen3-8B' } }),
      nodes: ['node1'],
    });

    expect(renderCacheResources({ plan })).toEqual({ volumes: [], volumeMounts: [] });
  });

  it('产物是深拷贝：改产物不影响 plan，也不影响下一次渲染', () => {
    const plan = planModelCache({ service: strataLike(), nodes: ['node1'] });
    const first = renderCacheResources({ plan });
    first.volumes[0].hostPath.path = '/models/hijacked';
    first.volumeMounts.length = 0;

    expect(plan.volumes[0].hostPath.path).toBe('/models/strata-Q2_0');
    expect(plan.volumeMounts).toHaveLength(1);
    expect(renderCacheResources({ plan }).volumes[0].hostPath.path).toBe('/models/strata-Q2_0');
  });

  it('也接受直接传 plan（不包 { plan }）', () => {
    const plan = planModelCache({ service: strataLike(), nodes: ['node1'] });

    expect(renderCacheResources(plan)).toEqual(renderCacheResources({ plan }));
  });

  it('畸形 plan 抛 INFRA_INVALID_CACHE_PLAN：缺 plan / 未知 strategy / 空 volumes', () => {
    const capture = (input) => {
      try {
        renderCacheResources(input);
      } catch (error) {
        return error;
      }
      return null;
    };

    const missing = capture({});
    expect(missing).toBeInstanceOf(Error);
    expect(missing.code).toBe('INFRA_INVALID_CACHE_PLAN');
    expect(missing.message).toContain('请先调用 planModelCache');

    const badStrategy = capture({ plan: { strategy: 'nfs', volumes: [], volumeMounts: [] } });
    expect(badStrategy.code).toBe('INFRA_INVALID_CACHE_PLAN');
    expect(badStrategy.message).toContain(CACHE_STRATEGIES.join(' / '));

    const emptyVolumes = capture({ plan: { strategy: 'hostPath', volumes: [], volumeMounts: [] } });
    expect(emptyVolumes.code).toBe('INFRA_INVALID_CACHE_PLAN');
    expect(emptyVolumes.message).toContain('volumes 是空的');
  });

  it('拒绝被改回可写的挂载、卷名对不上、穿越的宿主路径', () => {
    const volume = { name: CACHE_VOLUME_NAME, hostPath: { path: '/models/x', type: 'Directory' } };
    const base = { strategy: 'hostPath', volumes: [volume] };

    expect(() => renderCacheResources({
      plan: { ...base, volumeMounts: [{ name: CACHE_VOLUME_NAME, mountPath: '/models/x', readOnly: false }] },
    })).toThrow(/只读/);

    expect(() => renderCacheResources({
      plan: { ...base, volumeMounts: [{ name: 'other-cache', mountPath: '/models/x', readOnly: true }] },
    })).toThrow(/找不到对应的 volume/);

    expect(() => renderCacheResources({
      plan: {
        strategy: 'hostPath',
        volumes: [{ name: CACHE_VOLUME_NAME, hostPath: { path: '/models/../etc', type: 'Directory' } }],
        volumeMounts: [],
      },
    })).toThrow(/hostPath\.path/);

    expect(() => renderCacheResources({
      plan: {
        strategy: 'hostPath',
        volumes: [{ name: CACHE_VOLUME_NAME, hostPath: { path: '/etc/shadow', type: 'File' } }],
        volumeMounts: [{ name: CACHE_VOLUME_NAME, mountPath: '/etc/shadow', readOnly: true }],
      },
    })).toThrow(/系统目录/);
  });
});
