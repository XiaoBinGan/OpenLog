import { describe, it, expect, vi } from 'vitest';

import {
  parseSchedulerMetrics,
  extractHamiDevices,
  pickKeySeries,
  fetchSchedulerMetrics,
  DEFAULT_METRICS_PORT,
  METRIC_CONTAINER_UTIL,
  METRIC_CONTAINER_MEMORY,
  METRIC_HOST_UTIL,
} from '../k8s/hami-metrics.js';

/* ────────────────────────── 样例文本 ────────────────────────── */

const EXPOSITION = `# HELP hami_container_device_utilization_ratio 容器占用设备的使用率
# TYPE hami_container_device_utilization_ratio gauge
hami_container_device_utilization_ratio{container="trainer",device_uuid="GPU-86d1a2b3",node="gpu-node-1"} 0.3781
hami_container_device_utilization_ratio{container="infer",device_uuid="GPU-86d1a2b3",node="gpu-node-1"} 0.6

# HELP hami_container_device_memory_bytes 容器占用设备显存
# TYPE hami_container_device_memory_bytes gauge
hami_container_device_memory_bytes{container="trainer",device_uuid="GPU-86d1a2b3",node="gpu-node-1"} 6.174e+09
hami_container_device_memory_bytes{container="infer",device_uuid="GPU-86d1a2b3",node="gpu-node-1"} 2147483648

# TYPE hami_host_gpu_utilization_ratio gauge
hami_host_gpu_utilization_ratio{device_uuid="GPU-86d1a2b3",node="gpu-node-1"} 0.52
# EOF
`;

const schedulerPodList = (pods) => ({ kind: 'PodList', items: pods });

const pod = ({ name, ip, phase = 'Running', deleting = false }) => ({
  metadata: { name, namespace: 'kube-system', ...(deleting ? { deletionTimestamp: '2026-01-01T00:00:00Z' } : {}) },
  status: { phase, podIP: ip },
});

const okClient = (items) => ({ getJson: vi.fn(async () => schedulerPodList(items)) });

/* ────────────────────────── parseSchedulerMetrics ────────────────────────── */

describe('parseSchedulerMetrics：正常文本', () => {
  it('按指标名分组，标签与数值都正确', () => {
    const parsed = parseSchedulerMetrics(EXPOSITION);
    expect(Object.keys(parsed).sort()).toEqual([
      METRIC_CONTAINER_MEMORY,
      METRIC_CONTAINER_UTIL,
      METRIC_HOST_UTIL,
    ]);
    expect(parsed[METRIC_CONTAINER_UTIL]).toHaveLength(2);
    expect(parsed[METRIC_CONTAINER_UTIL][0]).toEqual({
      labels: { container: 'trainer', device_uuid: 'GPU-86d1a2b3', node: 'gpu-node-1' },
      value: 0.3781,
    });
    expect(parsed[METRIC_HOST_UTIL][0].value).toBe(0.52);
  });

  it('忽略 # HELP / # TYPE / # EOF 与空行', () => {
    const parsed = parseSchedulerMetrics(EXPOSITION);
    // 三行注释带空格前缀的变体也不该产出指标
    expect(parsed['#']).toBeUndefined();
    expect(parsed.HELP).toBeUndefined();
    expect(parsed.TYPE).toBeUndefined();
    for (const name of Object.keys(parsed)) expect(name.startsWith('#')).toBe(false);
  });

  it('无标签指标返回空 labels 对象', () => {
    const parsed = parseSchedulerMetrics('hami_build_info 1\n');
    expect(parsed.hami_build_info).toEqual([{ labels: {}, value: 1 }]);
  });

  it('容忍 CRLF、行首尾空白与行尾无换行', () => {
    const parsed = parseSchedulerMetrics('  a_metric{a="1"} 3 \r\n\r\nb_metric 4');
    expect(parsed.a_metric).toEqual([{ labels: { a: '1' }, value: 3 }]);
    expect(parsed.b_metric).toEqual([{ labels: {}, value: 4 }]);
  });

  it('忽略值后面的毫秒时间戳', () => {
    const parsed = parseSchedulerMetrics('a_metric{a="x"} 5 1700000000000');
    expect(parsed.a_metric).toEqual([{ labels: { a: 'x' }, value: 5 }]);
  });
});

describe('parseSchedulerMetrics：数值形态', () => {
  it('科学计数法（大小写 E、负指数、省略整数位）', () => {
    const parsed = parseSchedulerMetrics([
      'm_a 6.174e+09',
      'm_b 2.5E-3',
      'm_c .5',
      'm_d 7.',
      'm_e +1.5',
      'm_f -0.25',
    ].join('\n'));
    expect(parsed.m_a[0].value).toBe(6174000000);
    expect(parsed.m_b[0].value).toBe(0.0025);
    expect(parsed.m_c[0].value).toBe(0.5);
    expect(parsed.m_d[0].value).toBe(7);
    expect(parsed.m_e[0].value).toBe(1.5);
    expect(parsed.m_f[0].value).toBe(-0.25);
  });

  it('NaN 保留为 NaN（不是字符串、也不是丢弃）', () => {
    const parsed = parseSchedulerMetrics('m_nan  NaN\nm_nan_lower nan');
    expect(parsed.m_nan).toHaveLength(1);
    expect(Number.isNaN(parsed.m_nan[0].value)).toBe(true);
    expect(Number.isNaN(parsed.m_nan_lower[0].value)).toBe(true);
  });

  it('+Inf / -Inf / Inf 映射成 ±Infinity', () => {
    const parsed = parseSchedulerMetrics('m_pinf +Inf\nm_ninf -Inf\nm_inf Inf\nm_infinity Infinity');
    expect(parsed.m_pinf[0].value).toBe(Infinity);
    expect(parsed.m_ninf[0].value).toBe(-Infinity);
    expect(parsed.m_inf[0].value).toBe(Infinity);
    expect(parsed.m_infinity[0].value).toBe(Infinity);
  });

  it('拒绝非数字值（含空值、单位混写、十六进制）', () => {
    const parsed = parseSchedulerMetrics('m_bad abc\nm_bad2 12GiB\nm_bad3 0x1f\nm_bad4');
    expect(parsed.m_bad).toBeUndefined();
    expect(parsed.m_bad2).toBeUndefined();
    expect(parsed.m_bad3).toBeUndefined();
    expect(parsed.m_bad4).toBeUndefined();
  });
});

describe('parseSchedulerMetrics：标签解析', () => {
  it('还原转义引号、反斜杠与换行', () => {
    const line = 'm_esc{a="he said \\"hi\\"",b="c:\\\\tmp",c="l1\\nl2"} 1';
    const parsed = parseSchedulerMetrics(line);
    expect(parsed.m_esc[0].labels).toEqual({ a: 'he said "hi"', b: 'c:\\tmp', c: 'l1\nl2' });
  });

  it('空标签值与下划线/数字标签名', () => {
    const parsed = parseSchedulerMetrics('m_lab{device_uuid="",node_2="n1"} 1');
    expect(parsed.m_lab[0].labels).toEqual({ device_uuid: '', node_2: 'n1' });
  });

  it('标签之间允许多余空白与逗号', () => {
    const parsed = parseSchedulerMetrics('m_ws{ a="1" ,  b="2" } 9');
    expect(parsed.m_ws[0].labels).toEqual({ a: '1', b: '2' });
  });

  it('坏行跳过，好行保留（未闭合标签 / 缺等号 / 缺引号）', () => {
    const text = [
      'm_ok{a="1"} 1',
      'm_closed{a="1" 2',
      'm_noeq{a"1"} 3',
      'm_noquote{a=1} 4',
      'm_ok2 5',
    ].join('\n');
    const parsed = parseSchedulerMetrics(text);
    expect(Object.keys(parsed).sort()).toEqual(['m_ok', 'm_ok2']);
  });

  it('名字非法的行（以数字/符号开头）被跳过', () => {
    const parsed = parseSchedulerMetrics('1m_bad 1\n-m_bad2 2\nm_good 3');
    expect(Object.keys(parsed)).toEqual(['m_good']);
  });
});

describe('parseSchedulerMetrics：边界与去重', () => {
  it('空文本返回空对象', () => {
    expect(parseSchedulerMetrics('')).toEqual({});
  });

  it('只有注释与空行返回空对象', () => {
    expect(parseSchedulerMetrics('# HELP x y\n# TYPE x gauge\n\n# EOF\n')).toEqual({});
  });

  it('非字符串输入返回空对象（不抛）', () => {
    for (const input of [null, undefined, 123, {}, [], true]) {
      expect(parseSchedulerMetrics(input)).toEqual({});
    }
  });

  it('重复样本（同名同标签）后者覆盖前者，只留一条', () => {
    const text = [
      'm_dup{a="1"} 1',
      'm_dup{a="1"} 2',
      'm_dup{a="1"} 3',
    ].join('\n');
    const parsed = parseSchedulerMetrics(text);
    expect(parsed.m_dup).toHaveLength(1);
    expect(parsed.m_dup[0].value).toBe(3);
  });

  it('同名不同标签顺序的重复样本也判定为重复', () => {
    const parsed = parseSchedulerMetrics('m_x{a="1",b="2"} 1\nm_x{b="2",a="1"} 2');
    expect(parsed.m_x).toHaveLength(1);
    expect(parsed.m_x[0].value).toBe(2);
  });

  it('同名不同标签集合保留多条', () => {
    const parsed = parseSchedulerMetrics('m_y{a="1"} 1\nm_y{a="2"} 2');
    expect(parsed.m_y).toHaveLength(2);
    expect(parsed.m_y.map((s) => s.value)).toEqual([1, 2]);
  });

  it('同样输入两次结果深度相等（确定性）', () => {
    expect(parseSchedulerMetrics(EXPOSITION)).toEqual(parseSchedulerMetrics(EXPOSITION));
  });
});

/* ────────────────────────── 抽取关键序列 ────────────────────────── */

describe('pickKeySeries / extractHamiDevices', () => {
  const parsed = parseSchedulerMetrics(EXPOSITION);

  it('pickKeySeries 只返回三条关键序列', () => {
    const picked = pickKeySeries(parsed);
    expect(picked.containerUtilization).toHaveLength(2);
    expect(picked.containerMemory).toHaveLength(2);
    expect(picked.hostUtilization).toHaveLength(1);
  });

  it('pickKeySeries 对空/非法输入返回三个空数组', () => {
    for (const input of [undefined, null, {}, 42]) {
      const picked = pickKeySeries(input);
      expect(picked).toEqual({ containerUtilization: [], containerMemory: [], hostUtilization: [] });
    }
  });

  it('按 node+device_uuid 归并成一行，取最大值并带上主机利用率', () => {
    const devices = extractHamiDevices(parsed);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      deviceUUID: 'GPU-86d1a2b3',
      node: 'gpu-node-1',
      containerUtil: 0.6,
      utilPercent: 60,
      memUsedBytes: 6174000000,
      hostUtil: 0.52,
      hostUtilPercent: 52,
    });
    // container 跟随利用率最大的那条序列
    expect(devices[0].container).toBe('infer');
  });

  it('转义引号过的 uuid 能正常还原（不丢设备）', () => {
    const devices = extractHamiDevices(parseSchedulerMetrics(
      'hami_container_device_utilization_ratio{container="c\\"x\\"",device_uuid="GPU-1",node="n1"} 0.5',
    ));
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceUUID).toBe('GPU-1');
    expect(devices[0].container).toBe('c"x"');
  });

  it('NaN / +Inf / 负数比例降级为 null，而不是 0', () => {
    const devices = extractHamiDevices(parseSchedulerMetrics([
      'hami_container_device_utilization_ratio{device_uuid="GPU-NaN",node="n1"} NaN',
      'hami_container_device_utilization_ratio{device_uuid="GPU-INF",node="n1"} +Inf',
      'hami_container_device_utilization_ratio{device_uuid="GPU-NEG",node="n1"} -1',
    ].join('\n')));
    expect(devices).toHaveLength(3);
    for (const d of devices) {
      expect(d.containerUtil).toBeNull();
      expect(d.utilPercent).toBeNull();
    }
  });

  it('缺 device_uuid 时用 node#device_index 兜底，索引也缺则跳过', () => {
    const devices = extractHamiDevices(parseSchedulerMetrics([
      'hami_container_device_utilization_ratio{node="n1",device_index="2"} 0.1',
      'hami_container_device_utilization_ratio{node="n1"} 0.9',
    ].join('\n')));
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceUUID).toBe('n1#2');
  });

  it('同一 uuid 在不同节点上是两条设备（不跨节点合并）', () => {
    const devices = extractHamiDevices(parseSchedulerMetrics([
      'hami_container_device_utilization_ratio{device_uuid="GPU-1",node="n2"} 0.1',
      'hami_container_device_utilization_ratio{device_uuid="GPU-1",node="n1"} 0.2',
    ].join('\n')));
    expect(devices.map((d) => d.node)).toEqual(['n1', 'n2']);
  });

  it('主机级指标缺 node 标签时，按 uuid 并入已有设备行', () => {
    const devices = extractHamiDevices(parseSchedulerMetrics([
      'hami_container_device_utilization_ratio{device_uuid="GPU-1",node="n1"} 0.4',
      'hami_host_gpu_utilization_ratio{device_uuid="GPU-1"} 0.7',
    ].join('\n')));
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ node: 'n1', containerUtil: 0.4, hostUtil: 0.7 });
  });

  it('有指标但无 device_uuid 标签的序列不会炸，返回空数组', () => {
    expect(extractHamiDevices(parseSchedulerMetrics('hami_container_device_utilization_ratio 1'))).toEqual([]);
  });

  it('输出按 node → deviceUUID 排序（确定性）', () => {
    const devices = extractHamiDevices(parsed);
    expect(devices.map((d) => `${d.node}/${d.deviceUUID}`)).toEqual(
      [...devices.map((d) => `${d.node}/${d.deviceUUID}`)].sort(),
    );
  });
});

/* ────────────────────────── fetchSchedulerMetrics ────────────────────────── */

describe('fetchSchedulerMetrics：成功路径', () => {
  it('找到 scheduler Pod → available:true，端口/端点正确', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: EXPOSITION }));

    const result = await fetchSchedulerMetrics({ client, cluster: {}, httpGet, now: '2026-01-02T03:04:05Z' });

    expect(result.available).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.scrapedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(result.metricsPort).toBe(DEFAULT_METRICS_PORT);
    expect(result.endpoint).toBe(`http://10.0.0.7:${DEFAULT_METRICS_PORT}/metrics`);
    expect(result.podName).toBe('hami-scheduler-0');
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].deviceUUID).toBe('GPU-86d1a2b3');
  });

  it('用官方标签选择器与 kube-system 命名空间查 Pod', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: 'm_a 1' }));

    await fetchSchedulerMetrics({ client, httpGet });

    expect(client.getJson).toHaveBeenCalledTimes(1);
    const [path, options] = client.getJson.mock.calls[0];
    expect(path).toBe('/api/v1/namespaces/kube-system/pods');
    expect(options.query.labelSelector).toBe('app=hami-scheduler');
  });

  it('优先选 Running 且有 podIP 的 Pod，跳过正在删除的与 Pending 的', async () => {
    const client = okClient([
      pod({ name: 'hami-scheduler-a', ip: '10.0.0.1', deleting: true }),
      pod({ name: 'hami-scheduler-b', ip: '', phase: 'Pending' }),
      pod({ name: 'hami-scheduler-c', ip: '10.0.0.3' }),
    ]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: 'm_a 1' }));

    const result = await fetchSchedulerMetrics({ client, httpGet });

    expect(result.available).toBe(true);
    expect(result.endpoint).toContain('10.0.0.3');
  });

  it('端口可被 metricsPort 覆盖（数字字符串也接受）', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: 'm_a 1' }));

    const result = await fetchSchedulerMetrics({ client, httpGet, metricsPort: '9999' });

    expect(result.metricsPort).toBe(9999);
    expect(httpGet.mock.calls[0][0]).toBe('http://10.0.0.7:9999/metrics');
  });

  it('端口可被 cluster.metricsPort 覆盖，且 metricsPort 参数优先级更高', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: 'm_a 1' }));

    const fromCluster = await fetchSchedulerMetrics({ client, httpGet, cluster: { metricsPort: 32000 } });
    expect(fromCluster.metricsPort).toBe(32000);

    const overridden = await fetchSchedulerMetrics({
      client, httpGet, cluster: { metricsPort: 32000 }, metricsPort: 33000,
    });
    expect(overridden.metricsPort).toBe(33000);
  });

  it('非法端口静默退回默认 31993', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: 'm_a 1' }));

    for (const bad of [0, 70000, -1, 'abc', null, 3.5]) {
      const result = await fetchSchedulerMetrics({ client, httpGet, metricsPort: bad });
      expect(result.metricsPort).toBe(DEFAULT_METRICS_PORT);
    }
  });

  it('IPv6 podIP 自动加方括号', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: 'fd00::7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: 'm_a 1' }));

    const result = await fetchSchedulerMetrics({ client, httpGet });

    expect(result.endpoint).toBe(`http://[fd00::7]:${DEFAULT_METRICS_PORT}/metrics`);
  });

  it('httpGet 直接返回字符串也能解析', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const result = await fetchSchedulerMetrics({ client, httpGet: async () => EXPOSITION });
    expect(result.available).toBe(true);
    expect(result.devices).toHaveLength(1);
  });

  it('默认不带原始映射；includeParsed:true 时才附带（供 A2 自行聚合）', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = async () => ({ statusCode: 200, body: EXPOSITION });

    const plain = await fetchSchedulerMetrics({ client, httpGet });
    expect(plain.parsed).toBeUndefined();

    const withRaw = await fetchSchedulerMetrics({ client, httpGet, includeParsed: true });
    expect(withRaw.available).toBe(true);
    expect(withRaw.parsed[METRIC_CONTAINER_UTIL]).toHaveLength(2);
    // 原始映射可再走一遍纯函数，结果与 devices 一致
    expect(extractHamiDevices(withRaw.parsed)).toEqual(withRaw.devices);
  });
});

describe('fetchSchedulerMetrics：失败路径（一律 available:false，不抛）', () => {
  it('没有 scheduler Pod → available:false + 中文原因', async () => {
    const result = await fetchSchedulerMetrics({ client: okClient([]), httpGet: vi.fn() });
    expect(result.available).toBe(false);
    expect(result.devices).toEqual([]);
    expect(result.reason).toContain('未找到 hami-scheduler Pod');
    expect(result.reason).toMatch(/kube-system/);
  });

  it('items 缺失/不是数组也不抛', async () => {
    const client = { getJson: vi.fn(async () => ({ kind: 'PodList' })) };
    const result = await fetchSchedulerMetrics({ client, httpGet: vi.fn() });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('未找到 hami-scheduler Pod');
  });

  it('Pod 有但没分配 podIP → available:false', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '', phase: 'Pending' })]);
    const result = await fetchSchedulerMetrics({ client, httpGet: vi.fn() });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('podIP');
  });

  it('抓取超时（ETIMEDOUT）→ available:false，原因带超时秒数', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const timeout = Object.assign(new Error('请求超时（10s）'), { code: 'ETIMEDOUT' });
    const httpGet = vi.fn(async () => { throw timeout; });

    const result = await fetchSchedulerMetrics({ client, httpGet });

    expect(result.available).toBe(false);
    expect(result.reason).toContain('超时');
    expect(result.reason).toContain('10s');
  });

  it('自定义 timeoutMs 会透传给 httpGet', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: 'm_a 1' }));

    await fetchSchedulerMetrics({ client, httpGet, timeoutMs: 1500 });

    expect(httpGet.mock.calls[0][1].timeoutMs).toBe(1500);
  });

  it('HTTP 500 → available:false，原因带状态码', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 500, body: 'boom' }));

    const result = await fetchSchedulerMetrics({ client, httpGet });

    expect(result.available).toBe(false);
    expect(result.reason).toContain('HTTP 500');
  });

  it('连接被拒绝 → 中文原因区分端口未监听', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const refuse = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const result = await fetchSchedulerMetrics({
      client,
      httpGet: async () => { throw refuse; },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('连接被拒绝');
  });

  it('查询 Pod 失败（403）→ available:false，不抛', async () => {
    const client = { getJson: vi.fn(async () => { throw new Error('Kubernetes API 权限不足（HTTP 403）'); }) };
    const result = await fetchSchedulerMetrics({ client, httpGet: vi.fn() });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('查询 hami-scheduler Pod 失败');
    expect(result.reason).toContain('403');
  });

  it('没有 client → available:false', async () => {
    for (const client of [undefined, null, {}, { getJson: 'nope' }]) {
      const result = await fetchSchedulerMetrics({ client, httpGet: vi.fn() });
      expect(result.available).toBe(false);
      expect(result.reason).toContain('未提供 Kubernetes 客户端');
    }
  });

  it('options 非法（null / 字符串）也不抛', async () => {
    for (const bad of [null, 'x', 0]) {
      const result = await fetchSchedulerMetrics(bad);
      expect(result.available).toBe(false);
      expect(typeof result.reason).toBe('string');
    }
  });

  it('httpGet 抛非 Error（字符串 / undefined）也不抛', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    for (const thrown of ['kaboom', undefined, 42]) {
      const result = await fetchSchedulerMetrics({
        client,
        httpGet: async () => { throw thrown; },
      });
      expect(result.available).toBe(false);
      expect(result.reason).toContain('HAMi 指标接口请求失败');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('空响应体 → available:false（区分「可达但没开指标」）', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const result = await fetchSchedulerMetrics({
      client,
      httpGet: async () => ({ statusCode: 200, body: '  \n# EOF\n' }),
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('空内容');
  });

  it('指标可达但无设备序列 → available:true、devices 为空', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const result = await fetchSchedulerMetrics({
      client,
      httpGet: async () => ({ statusCode: 200, body: 'go_goroutines 42' }),
    });
    expect(result.available).toBe(true);
    expect(result.devices).toEqual([]);
  });

  it('失败结果里的 scrapedAt 恒为合法 ISO 字符串', async () => {
    const result = await fetchSchedulerMetrics({ client: null, httpGet: vi.fn() });
    expect(Number.isNaN(Date.parse(result.scrapedAt))).toBe(false);
    expect(result.scrapedAt.endsWith('Z')).toBe(true);
  });
});

describe('fetchSchedulerMetrics：不发真实网络请求', () => {
  it('注入 httpGet 时调用次数恰好 1 次，且不会被默认实现顶替', async () => {
    const client = okClient([pod({ name: 'hami-scheduler-0', ip: '10.0.0.7' })]);
    const httpGet = vi.fn(async () => ({ statusCode: 200, body: 'm_a 1' }));

    await fetchSchedulerMetrics({ client, httpGet });

    expect(httpGet).toHaveBeenCalledTimes(1);
    expect(httpGet.mock.calls[0][0]).toBe(`http://10.0.0.7:${DEFAULT_METRICS_PORT}/metrics`);
  });

  it('未注入 httpGet 时，Pod 查询失败即返回，根本走不到网络层', async () => {
    const client = { getJson: vi.fn(async () => { throw new Error('Kubernetes API 连接失败：ECONNREFUSED'); }) };
    const result = await fetchSchedulerMetrics({ client });
    expect(result.available).toBe(false);
    expect(result.endpoint).toBeUndefined();
  });
});
