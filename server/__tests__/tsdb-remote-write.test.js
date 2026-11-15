/**
 * remote write 的编码正确性测试。
 *
 * 重点不是「函数能跑」，而是**编出来的字节符合 Prometheus 协议**。
 * 手写 protobuf/snappy 最容易错的是：字段号、wire type、varint 边界、
 * 长度域字节序。这些错在真推给 Thanos 时只表现为一句
 * "snappy: corrupt input"，根本定位不到。
 *
 * 所以这里逐字节断言：
 *   · varint 的边界值（1/127/128/16383/16384）
 *   · protobuf 的 tag = (field<<3)|wireType
 *   · double 是 64 位小端
 *   · snappy literal 的 4 档长度编码
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  encodeVarint, encodeLabel, encodeSample, encodeTimeSeries, encodeWriteRequest,
  snappyEncode, snappyDecodeLiteral, decodeWriteRequest, toWriteSeries, createRemoteWriter,
} from '../tsdb/remote-write.js';

const T0 = 1_700_000_000_000;

describe('varint 编码', () => {
  it('单字节边界', () => {
    expect([...encodeVarint(0)]).toEqual([0x00]);
    expect([...encodeVarint(1)]).toEqual([0x01]);
    expect([...encodeVarint(127)]).toEqual([0x7f]);
  });

  it('两字节边界', () => {
    // 128 = 0b10000000 → 低 7 位 0，续位 1；高位 1
    expect([...encodeVarint(128)]).toEqual([0x80, 0x01]);
    expect([...encodeVarint(300)]).toEqual([0xac, 0x02]);
  });

  it('三字节边界', () => {
    expect([...encodeVarint(16383)]).toEqual([0xff, 0x7f]);
    expect([...encodeVarint(16384)]).toEqual([0x80, 0x80, 0x01]);
  });

  it('毫秒时间戳（约 41 位）能正常编码', () => {
    const b = encodeVarint(T0);
    expect(b.length).toBeGreaterThanOrEqual(5);
    expect(b.length).toBeLessThanOrEqual(7);
  });
});

describe('protobuf 编码', () => {
  it('Label 的字段号与 wire type 正确', () => {
    const b = encodeLabel('__name__', 'up');
    // field 1 (name) → tag 0x0a, len 8, "__name__"
    expect(b[0]).toBe(0x0a);
    expect(b[1]).toBe(8);
    expect(b.subarray(2, 10).toString()).toBe('__name__');
    // field 2 (value) → tag 0x12, len 2, "up"
    expect(b[10]).toBe(0x12);
    expect(b[11]).toBe(2);
    expect(b.subarray(12, 14).toString()).toBe('up');
  });

  it('Sample 的值是 64 位小端 double，时间戳是 varint', () => {
    const b = encodeSample(1.5, T0);
    // field 1, wire 1 (64bit) → tag 0x09
    expect(b[0]).toBe(0x09);
    expect(b.readDoubleLE(1)).toBe(1.5);
    // field 2, wire 0 (varint) → tag 0x10
    expect(b[9]).toBe(0x10);
  });

  it('TimeSeries 的标签按名字排序，__name__ 在前', () => {
    const ts = encodeTimeSeries({ name: 'm', labels: { z: '1', a: '2' }, points: [{ ts: T0, value: 1 }] });
    const decoded = decodeWriteRequest(Buffer.concat([
      Buffer.from([0x0a]), encodeVarint(ts.length), ts,
    ]));
    const names = Object.keys(decoded.series[0].labels);
    // __name__ 归到 name 字段，其余按字母序
    expect(decoded.series[0].name).toBe('m');
    expect(names).toEqual(['a', 'z']);
  });

  it('空标签值被跳过', () => {
    const ts = encodeTimeSeries({ name: 'm', labels: { a: '', b: null, c: 'x' }, points: [{ ts: T0, value: 1 }] });
    const decoded = decodeWriteRequest(Buffer.concat([Buffer.from([0x0a]), encodeVarint(ts.length), ts]));
    expect(decoded.series[0].labels).toEqual({ c: 'x' });
  });

  it('非有限值被跳过（不写坏点）', () => {
    const ts = encodeTimeSeries({
      name: 'm', labels: {}, points: [{ ts: T0, value: NaN }, { ts: T0 + 1, value: 2 }],
    });
    const decoded = decodeWriteRequest(Buffer.concat([Buffer.from([0x0a]), encodeVarint(ts.length), ts]));
    expect(decoded.series[0].points).toHaveLength(1);
    expect(decoded.series[0].points[0].value).toBe(2);
  });

  it('WriteRequest 跳过空序列', () => {
    const buf = encodeWriteRequest([
      { name: 'a', labels: {}, points: [{ ts: T0, value: 1 }] },
      { name: 'b', labels: {}, points: [] },
      null,
    ]);
    const decoded = decodeWriteRequest(buf);
    expect(decoded.series).toHaveLength(1);
    expect(decoded.series[0].name).toBe('a');
  });
});

describe('snappy 编码', () => {
  it('长度头是 varint', () => {
    const enc = snappyEncode(Buffer.from('abc'));
    expect(enc[0]).toBe(3); // 解压后长度 3
  });

  it('短数据用 code<60 的 literal', () => {
    const enc = snappyEncode(Buffer.from('abcd'));
    // 长度 4 → n=3 → tag = 3<<2 = 0x0c
    expect(enc[1]).toBe(0x0c);
    expect(enc.subarray(2).toString()).toBe('abcd');
  });

  it('60 字节仍在短形式（n=59 < 60）', () => {
    const data = Buffer.alloc(60, 0x41);
    const enc = snappyEncode(data);
    // 60 < 128 → 长度头 1 字节
    expect(enc[0]).toBe(60);
    expect(enc[1]).toBe(59 << 2);
  });

  it('61 字节走 1 字节长度域（code=60）', () => {
    const data = Buffer.alloc(61, 0x41);
    const enc = snappyEncode(data);
    // 61 < 128，长度头占 1 字节
    expect(enc[0]).toBe(61);
    expect(enc[1]).toBe(60 << 2);
    expect(enc[2]).toBe(60); // n = len-1 = 60
  });

  it('大块走 2 字节长度域', () => {
    const data = Buffer.alloc(300, 0x41);
    const enc = snappyEncode(data);
    // 注意：300 的长度头本身是 2 字节 varint（0xac 0x02），
    // tag 从第 3 个字节开始 —— 之前按 1 字节算偏移，断言位置错了
    let p = 0;
    let header = 0;
    let shift = 0;
    for (;;) {
      const b = enc[p]; p += 1;
      header |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    expect(header).toBe(300);
    expect(enc[p]).toBe(61 << 2); // code=61 → 2 字节长度域
    expect(enc.readUInt16LE(p + 1)).toBe(299);
  });

  it('块内长度域用 4 档编码，解码都能还原', () => {
    // 覆盖 n<60、n<0x100、n<0x10000、>=0x10000 四种
    for (const size of [1, 61, 300, 70000]) {
      const data = Buffer.alloc(size, 0x41);
      expect(snappyDecodeLiteral(snappyEncode(data)).length).toBe(size);
    }
  });

  it('超过 65536 会分块', () => {
    const data = Buffer.alloc(70000, 0x42);
    const enc = snappyEncode(data);
    expect(snappyDecodeLiteral(enc)).toEqual(data);
  });

  it('空输入', () => {
    const enc = snappyEncode(Buffer.alloc(0));
    expect([...enc]).toEqual([0x00]);
    expect(snappyDecodeLiteral(enc).length).toBe(0);
  });
});

describe('往返（编码 → 解码）', () => {
  it('snappy 往返', () => {
    for (const size of [0, 1, 59, 60, 61, 100, 299, 300, 65535, 65536, 70000]) {
      const data = Buffer.alloc(size, 0x5a);
      expect(snappyDecodeLiteral(snappyEncode(data)).equals(data)).toBe(true);
    }
  });

  it('WriteRequest 往返', () => {
    const series = [
      { name: 'http_requests_total', labels: { method: 'GET', status: '200' }, points: [{ ts: T0, value: 1027 }] },
      { name: 'cpu', labels: { host: 'a' }, points: [{ ts: T0, value: 0.5 }, { ts: T0 + 15_000, value: 0.7 }] },
    ];
    const buf = encodeWriteRequest(series);
    const decoded = decodeWriteRequest(snappyDecodeLiteral(snappyEncode(buf)));

    expect(decoded.series).toHaveLength(2);
    expect(decoded.series[0].name).toBe('http_requests_total');
    expect(decoded.series[0].labels).toEqual({ method: 'GET', status: '200' });
    expect(decoded.series[0].points[0]).toEqual({ ts: T0, value: 1027 });
    expect(decoded.series[1].points).toHaveLength(2);
  });

  it('浮点精度不丢', () => {
    const v = 0.123456789012345;
    const buf = encodeWriteRequest([{ name: 'm', labels: {}, points: [{ ts: T0, value: v }] }]);
    const decoded = decodeWriteRequest(snappyDecodeLiteral(snappyEncode(buf)));
    expect(decoded.series[0].points[0].value).toBe(v);
  });

  it('中文标签值', () => {
    const buf = encodeWriteRequest([{ name: 'm', labels: { desc: '磁盘使用率' }, points: [{ ts: T0, value: 1 }] }]);
    const decoded = decodeWriteRequest(snappyDecodeLiteral(snappyEncode(buf)));
    expect(decoded.series[0].labels.desc).toBe('磁盘使用率');
  });

  it('负数值', () => {
    const buf = encodeWriteRequest([{ name: 'm', labels: {}, points: [{ ts: T0, value: -42.5 }] }]);
    const decoded = decodeWriteRequest(snappyDecodeLiteral(snappyEncode(buf)));
    expect(decoded.series[0].points[0].value).toBe(-42.5);
  });
});

describe('toWriteSeries', () => {
  it('过滤空序列', () => {
    const r = toWriteSeries([
      { name: 'a', labels: {}, points: [{ ts: 1, value: 1 }] },
      { name: 'b', labels: {}, points: [] },
      null,
      { labels: {}, points: [{ ts: 1, value: 1 }] },
    ]);
    expect(r).toHaveLength(1);
  });
});

describe('推送器', () => {
  let fetchMock, store;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    store = {
      queryRange: vi.fn(async () => ({
        series: [{ name: 'm', labels: {}, points: [{ ts: T0, value: 1 }] }],
        error: null,
      })),
    };
  });

  const mkWriter = (targets, over = {}) => createRemoteWriter({
    store,
    getTargets: () => targets,
    fetchImpl: fetchMock,
    now: () => T0,
    log: () => {},
    ...over,
  });

  it('未配置目标时跳过', async () => {
    const w = mkWriter([]);
    const r = await w.push();
    expect(r.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('推送成功的请求头正确', async () => {
    const w = mkWriter([{ url: 'http://vm/api/v1/write' }]);
    await w.push();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://vm/api/v1/write');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-protobuf');
    expect(init.headers['Content-Encoding']).toBe('snappy');
    expect(init.headers['X-Prometheus-Remote-Write-Version']).toBe('0.1.0');
  });

  it('**推送前自检编码结果能解回**', async () => {
    const w = mkWriter([{ url: 'http://vm' }]);
    await w.push();
    const body = fetchMock.mock.calls[0][1].body;
    // 解出来的内容必须与源数据一致
    const decoded = decodeWriteRequest(snappyDecodeLiteral(body));
    expect(decoded.series).toHaveLength(1);
    expect(decoded.series[0].name).toBe('m');
    expect(decoded.series[0].points[0].value).toBe(1);
  });

  it('HTTP 失败只记录不抛', async () => {
    const failFetch = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'snappy: corrupt input' }));
    const w = createRemoteWriter({
      store, getTargets: () => [{ url: 'http://x' }], fetchImpl: failFetch, now: () => T0, log: () => {},
    });
    const r = await w.push();
    expect(r.failed).toBe(1);
    expect(w.stats().lastError).toContain('400');
  });

  it('网络异常不抛', async () => {
    const throwFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const w = createRemoteWriter({
      store, getTargets: () => [{ url: 'http://x' }], fetchImpl: throwFetch, now: () => T0, log: () => {},
    });
    await expect(w.push()).resolves.toBeTruthy();
    expect(w.stats().failures).toBe(1);
  });

  it('没有数据时不发请求', async () => {
    const emptyStore = { queryRange: async () => ({ series: [], error: null }) };
    const w = createRemoteWriter({
      store: emptyStore, getTargets: () => [{ url: 'http://x' }], fetchImpl: fetchMock, now: () => T0, log: () => {},
    });
    await w.push();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功推进水位线（下一轮不重复推同一段）', async () => {
    let clock = T0;
    const w = createRemoteWriter({
      store, getTargets: () => [{ url: 'http://x' }], fetchImpl: fetchMock, now: () => clock, log: () => {},
    });
    await w.push();
    const firstSince = store.queryRange.mock.calls[0][0].start;
    clock = T0 + 60_000;
    await w.push();
    const secondSince = store.queryRange.mock.calls[1][0].start;
    expect(secondSince).toBeGreaterThan(firstSince);
  });

  it('enabled=false 的目标被跳过', async () => {
    const w = mkWriter([{ url: 'http://x', enabled: false }]);
    const r = await w.push();
    expect(r.skipped).toBe(true);
  });

  it('多个目标都推', async () => {
    const w = mkWriter([{ url: 'http://a' }, { url: 'http://b' }]);
    await w.push();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('自定义 headers 带上', async () => {
    const w = mkWriter([{ url: 'http://x', headers: { Authorization: 'Bearer t' } }]);
    await w.push();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer t');
  });
});

describe('解码器拒绝坏输入（验证它能发现真问题）', () => {
  it('非 literal 的 snappy 块报错', () => {
    // tag 低两位 = 01（copy 块）
    const bad = Buffer.from([3, 0x01]);
    expect(() => snappyDecodeLiteral(bad)).toThrow(/非 literal/);
  });

  it('长度不符报错', () => {
    const enc = snappyEncode(Buffer.from('abc'));
    enc[0] = 99; // 篡改长度头
    expect(() => snappyDecodeLiteral(enc)).toThrow(/长度不符/);
  });

  it('protobuf 顶层字段号错报错', () => {
    // field 2 而不是 1
    const bad = Buffer.concat([Buffer.from([0x12]), encodeVarint(0)]);
    expect(() => decodeWriteRequest(bad)).toThrow(/field 1/);
  });
});