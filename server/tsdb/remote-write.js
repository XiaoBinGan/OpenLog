/**
 * Prometheus remote write —— 把 OpenLog 的时序数据推给远端。
 *
 * 用途：接 Thanos / VictoriaMetrics / Mimir / 自建 Prometheus 做长期存储。
 * 本地只保留 7 天原始 + 90 天降采样，更长周期靠远端。
 *
 * ## 为什么不用现成库
 *
 * 项目依赖里没有 protobuf 和 snappy，而为了一个可选功能引入两个原生依赖
 * （snappy 需要编译）代价太大。这里手写编码：
 *
 *   · **protobuf** 的 wire format 很简单：`(field<<3|wiretype) varint ...`，
 *     WriteRequest 只有三层嵌套、没有 oneof/map/递归，手写比引库更可控。
 *   · **snappy** 只实现 literal-only 编码。Snappy 允许整块不解压地存原文
 *     （tag 的低两位是 00 = literal），接收端用标准 snappy.Decode 能正确解出来。
 *     压缩率不如真 snappy，但胜在**绝对正确**且零依赖 ——
 *     推给远端的数据，错了比慢一点严重得多。
 *
 * ## 协议结构（prometheus/prompb/remote.proto）
 *
 *   WriteRequest { repeated TimeSeries timeseries = 1; }
 *   TimeSeries   { repeated Label labels = 1; repeated Sample samples = 2; }
 *   Label        { string name = 1; string value = 2; }
 *   Sample       { double value = 1; int64 timestamp = 2; }
 *
 * 时间戳是**毫秒**。标签里必须包含 `__name__`（放指标名）。
 */

/** protobuf wire type */
const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;

/**
 * 编码 varint（无符号）。
 * protobuf 的 varint 是小端 7 位一组，最高位表示「还有后续字节」。
 */
export function encodeVarint(value) {
  let v = BigInt(Math.trunc(Number(value)));
  if (v < 0n) v = BigInt.asUintN(64, v); // int64 负数按补码编码
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

/** 编码 tag：字段号 + wire type */
function tag(field, wireType) {
  return encodeVarint((field << 3) | wireType);
}

/** 长度前缀消息 */
function lenDelimited(field, payload) {
  return Buffer.concat([tag(field, WIRE_LEN), encodeVarint(payload.length), payload]);
}

/** double（64 位小端，wire type 1） */
function doubleField(field, value) {
  const buf = Buffer.alloc(9);
  buf[0] = (field << 3) | WIRE_64BIT;
  buf.writeDoubleLE(Number(value), 1);
  return buf;
}

/** int64（varint，wire type 0） */
function varintField(field, value) {
  return Buffer.concat([tag(field, WIRE_VARINT), encodeVarint(value)]);
}

/** string 字段 */
function stringField(field, value) {
  return lenDelimited(field, Buffer.from(String(value), 'utf8'));
}

/**
 * 编码一个 Label。
 * @param {string} name
 * @param {string} value
 */
export function encodeLabel(name, value) {
  return Buffer.concat([stringField(1, name), stringField(2, value)]);
}

/**
 * 编码一个 Sample。
 * @param {number} value
 * @param {number} timestampMs
 */
export function encodeSample(value, timestampMs) {
  return Buffer.concat([doubleField(1, value), varintField(2, timestampMs)]);
}

/**
 * 编码一个 TimeSeries。
 *
 * 标签必须**按名字排序**：Prometheus 的时序身份是「排序后的标签集」，
 * 不排序会让同一条序列在远端被当成两条。
 *
 * @param {{name:string, labels?:Object, points:Array<{ts:number,value:number}>}} series
 */
export function encodeTimeSeries(series) {
  const labels = [{ name: '__name__', value: series.name }];
  for (const k of Object.keys(series.labels || {}).sort()) {
    const v = series.labels[k];
    if (v === null || v === undefined || v === '') continue;
    labels.push({ name: k, value: String(v) });
  }
  // __name__ 排最前，其余按字母序
  labels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const parts = [];
  for (const l of labels) parts.push(lenDelimited(1, encodeLabel(l.name, l.value)));
  for (const p of series.points || []) {
    const ts = Number(p.ts);
    const v = Number(p.value);
    if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
    parts.push(lenDelimited(2, encodeSample(v, ts)));
  }
  return Buffer.concat(parts);
}

/**
 * 编码整个 WriteRequest。
 *
 * @param {Array<{name:string, labels?:Object, points:Array<{ts:number,value:number}>}>} series
 * @returns {Buffer}
 */
export function encodeWriteRequest(series) {
  const parts = [];
  for (const s of Array.isArray(series) ? series : []) {
    if (!s || !s.name) continue;
    if (!Array.isArray(s.points) || s.points.length === 0) continue;
    parts.push(lenDelimited(1, encodeTimeSeries(s)));
  }
  return Buffer.concat(parts);
}

/**
 * snappy 编码（literal-only）。
 *
 * 格式：varint(解压后长度) + 若干个 literal 块。
 * literal tag 的低两位是 00，其余位编码长度：
 *   len-1 < 60        → tag = (len-1) << 2
 *   否则用 tag 的低位 60/61/62/63 表示后续 1/2/3/4 字节存长度
 *
 * 解码端（Prometheus 用的 golang/snappy）完全支持这种块 ——
 * 压缩率是 1.0，但正确性无争议。
 */
export function snappyEncode(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const out = [encodeVarint(src.length)];

  let offset = 0;
  while (offset < src.length) {
    const chunk = src.subarray(offset, offset + 65536);
    offset += chunk.length;
    const len = chunk.length;
    const n = len - 1;

    if (n < 60) {
      out.push(Buffer.from([n << 2]));
    } else if (n < 0x100) {
      out.push(Buffer.from([60 << 2, n]));
    } else if (n < 0x10000) {
      out.push(Buffer.from([61 << 2, n & 0xff, (n >> 8) & 0xff]));
    } else if (n < 0x1000000) {
      out.push(Buffer.from([62 << 2, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]));
    } else {
      const b = Buffer.alloc(5);
      b[0] = 63 << 2;
      b.writeUInt32LE(n, 1);
      out.push(b);
    }
    out.push(chunk);
  }

  return Buffer.concat(out);
}

/**
 * snappy 解码（仅用于测试与自检：验证我们编出来的东西能被读懂）。
 *
 * 只支持 literal 块 —— 我们自己的编码器只产出这种。
 * 接收外部真实 snappy 数据（含 copy 块）时这里会抛错，这是故意的：
 * 这个函数不用于生产路径，用于「推之前自检一遍」。
 */
export function snappyDecodeLiteral(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let i = 0;
  // 读解压后长度
  let expected = 0;
  let shift = 0;
  for (;;) {
    if (i >= src.length) throw new Error('snappy: 长度头不完整');
    const b = src[i]; i += 1;
    expected |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }

  const out = [];
  while (i < src.length) {
    const tag = src[i]; i += 1;
    const type = tag & 0x03;
    if (type !== 0) throw new Error(`snappy: 非 literal 块（type=${type}），本解码器不支持`);
    const code = tag >> 2;
    let len;
    if (code < 60) {
      len = code + 1;
    } else {
      const extra = code - 59; // 1..4 字节
      if (i + extra > src.length) throw new Error('snappy: 长度域不完整');
      len = 0;
      for (let k = 0; k < extra; k += 1) len |= src[i + k] << (8 * k);
      i += extra;
      len += 1;
    }
    if (i + len > src.length) throw new Error('snappy: literal 数据超出缓冲区');
    out.push(src.subarray(i, i + len));
    i += len;
  }

  const buf = Buffer.concat(out);
  if (buf.length !== expected) {
    throw new Error(`snappy: 长度不符（头 ${expected}，实际 ${buf.length}）`);
  }
  return buf;
}

/**
 * 简化版 protobuf 解码 —— 只解我们自己的 WriteRequest 形状，
 * 用于推送前自检「编码结果能被正确读回」。
 *
 * 不做通用 protobuf 解析：那不是这个模块的职责，
 * 而且通用解析器会把「编码器写错了字段号」这种 bug 掩盖成「解析成功」。
 *
 * @returns {{series: Array<{name:string, labels:Object, points:Array<{ts:number,value:number}>}>}}
 */
export function decodeWriteRequest(buf) {
  const out = [];
  let i = 0;
  const src = buf;

  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= src.length) throw new Error('protobuf: varint 越界');
      const b = src[i]; i += 1;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  };

  const readLen = () => {
    const n = Number(readVarint());
    const slice = src.subarray(i, i + n);
    if (slice.length !== n) throw new Error('protobuf: 长度域越界');
    i += n;
    return slice;
  };

  while (i < src.length) {
    const key = Number(readVarint());
    const field = key >>> 3;
    const wire = key & 0x07;
    if (field !== 1 || wire !== WIRE_LEN) throw new Error(`protobuf: 顶层只应有 field 1/LEN，实际 ${field}/${wire}`);
    out.push(decodeTimeSeries(readLen()));
  }

  return { series: out };

  function decodeTimeSeries(tsBuf) {
    let j = 0;
    const labels = [];
    const points = [];
    const readV = () => {
      let result = 0n; let shift = 0n;
      for (;;) {
        if (j >= tsBuf.length) throw new Error('protobuf: varint 越界');
        const b = tsBuf[j]; j += 1;
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      return result;
    };
    const readL = () => {
      const n = Number(readV());
      const s = tsBuf.subarray(j, j + n);
      if (s.length !== n) throw new Error('protobuf: 长度域越界');
      j += n;
      return s;
    };

    while (j < tsBuf.length) {
      const key = Number(readV());
      const field = key >>> 3;
      const wire = key & 0x07;
      if (field === 1 && wire === WIRE_LEN) {
        const lb = readL();
        let k = 0;
        let name = '';
        let value = '';
        const readLV = () => {
          let result = 0n; let shift = 0n;
          for (;;) {
            if (k >= lb.length) throw new Error('protobuf: varint 越界');
            const b = lb[k]; k += 1;
            result |= BigInt(b & 0x7f) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7n;
          }
          return result;
        };
        const readLL = () => {
          const n = Number(readLV());
          const s = lb.subarray(k, k + n);
          if (s.length !== n) throw new Error('protobuf: 长度域越界');
          k += n;
          return s;
        };
        while (k < lb.length) {
          const lk = Number(readLV());
          const lf = lk >>> 3;
          if (lf === 1) name = readLL().toString('utf8');
          else if (lf === 2) value = readLL().toString('utf8');
          else { const skip = lk & 0x07; if (skip === WIRE_LEN) readLL(); else throw new Error('protobuf: label 未知字段'); }
        }
        labels.push({ name, value });
      } else if (field === 2 && wire === WIRE_LEN) {
        const sb = readL();
        let k = 0;
        let value = 0;
        let ts = 0;
        const readSV = () => {
          let result = 0n; let shift = 0n;
          for (;;) {
            if (k >= sb.length) throw new Error('protobuf: varint 越界');
            const b = sb[k]; k += 1;
            result |= BigInt(b & 0x7f) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7n;
          }
          return result;
        };
        while (k < sb.length) {
          const sk = Number(readSV());
          const sf = sk >>> 3;
          const sw = sk & 0x07;
          if (sf === 1 && sw === WIRE_64BIT) {
            value = sb.readDoubleLE(k); k += 8;
          } else if (sf === 2 && sw === WIRE_VARINT) {
            ts = Number(readSV());
          } else {
            throw new Error(`protobuf: sample 未知字段 ${sf}/${sw}`);
          }
        }
        points.push({ ts, value });
      } else {
        throw new Error(`protobuf: timeseries 未知字段 ${field}/${wire}`);
      }
    }

    const nameLabel = labels.find((l) => l.name === '__name__');
    const otherLabels = {};
    for (const l of labels) if (l.name !== '__name__') otherLabels[l.name] = l.value;
    return { name: nameLabel ? nameLabel.value : '', labels: otherLabels, points };
  }
}

/**
 * 把 store 的查询结果整理成 remote write 需要的形状。
 *
 * @param {Array<{name:string, labels:Object, points:Array<{ts:number,value:number}>}>} series
 */
export function toWriteSeries(series) {
  return (Array.isArray(series) ? series : [])
    .filter((s) => s && s.name && Array.isArray(s.points) && s.points.length > 0)
    .map((s) => ({ name: s.name, labels: s.labels || {}, points: s.points }));
}

/**
 * 创建 remote write 推送器。
 *
 * @param {object} deps
 * @param {() => Array<{url:string, enabled?:boolean, timeoutMs?:number, headers?:Object}>} deps.getTargets
 * @param {object} deps.store TSDB store
 * @param {() => number} [deps.now]
 * @param {Function} [deps.fetchImpl]
 * @param {(msg:string)=>void} [deps.log]
 */
export function createRemoteWriter(deps = {}) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((m) => console.log(`[TSDB/remote-write] ${m}`));
  const fetchImpl = deps.fetchImpl;
  const getTargets = deps.getTargets || (() => []);
  const store = deps.store;

  /** 每个 target 上次推送到哪个时刻，避免重复推 */
  const cursors = new Map();
  const stats = { sends: 0, failures: 0, series: 0, samples: 0, lastError: null, lastSendMs: null };

  /**
   * 推一轮。
   * @param {{sinceMs?:number, batchMs?:number}} [opts]
   */
  async function push(opts = {}) {
    const targets = (getTargets() || []).filter((t) => t && t.enabled !== false && t.url);
    if (targets.length === 0) return { skipped: true, reason: '未配置 remote write 目标' };
    if (!store) return { skipped: true, reason: 'store 未就绪' };

    const t = now();
    const batchMs = Number(opts.batchMs) > 0 ? Number(opts.batchMs) : 60_000;
    const results = [];

    for (const target of targets) {
      const key = target.url;
      const last = cursors.get(key);
      // 首次推送回看 5 分钟，避免重启后起点是空的
      const since = Number.isFinite(opts.sinceMs)
        ? Number(opts.sinceMs)
        : (last !== undefined ? last : t - 5 * 60_000);
      const until = Math.min(t, since + batchMs * 10);
      if (until <= since) continue;

      let read;
      try {
        read = await store.queryRange({ start: since, end: until, limit: 100_000 });
      } catch (err) {
        const msg = String(err?.message || err);
        stats.failures += 1; stats.lastError = msg;
        results.push({ url: key, ok: false, error: msg });
        continue;
      }
      if (read.error) {
        stats.failures += 1; stats.lastError = read.error;
        results.push({ url: key, ok: false, error: read.error });
        continue;
      }

      const series = toWriteSeries(read.series);
      if (series.length === 0) {
        cursors.set(key, until);
        results.push({ url: key, ok: true, series: 0 });
        continue;
      }

      // 编码 → 自检 → 压缩 → 推送。
      // 自检这一步不是多余的：protobuf 编码错了接收端只会回 400，
      // 而 400 的响应体通常只有一句 "snappy: corrupt input"，
      // 看不出是字段号错了还是长度域错了。本地解一遍能立刻定位。
      let body;
      try {
        const raw = encodeWriteRequest(series);
        const decoded = decodeWriteRequest(snappyDecodeLiteral(snappyEncode(raw)));
        if (decoded.series.length !== series.length) {
          throw new Error(`自检失败：编码 ${series.length} 条、解回 ${decoded.series.length} 条`);
        }
        body = snappyEncode(raw);
      } catch (err) {
        const msg = String(err?.message || err);
        stats.failures += 1; stats.lastError = msg;
        results.push({ url: key, ok: false, error: msg });
        log(`编码自检失败，本轮不推送: ${msg}`);
        continue;
      }

      const ok = await send(target, body);
      if (ok) {
        cursors.set(key, until);
        stats.samples += series.reduce((n, s) => n + s.points.length, 0);
        stats.series += series.length;
      }
      results.push({ url: key, ok, series: series.length, samples: body.length });
    }

    return { results, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }

  async function send(target, body) {
    const doFetch = fetchImpl || globalThis.fetch;
    if (!doFetch) { stats.failures += 1; return false; }
    const timeoutMs = Number(target.timeoutMs) > 0 ? Number(target.timeoutMs) : 30_000;
    try {
      const res = await doFetch(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-protobuf',
          'Content-Encoding': 'snappy',
          'X-Prometheus-Remote-Write-Version': '0.1.0',
          'User-Agent': 'OpenLog-RemoteWrite/1.0',
          ...(target.headers || {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      stats.sends += 1;
      stats.lastSendMs = now();
      if (!res.ok) {
        stats.failures += 1;
        let detail = '';
        try {
          const text = await res.text();
          detail = String(text).slice(0, 200);
        } catch { /* 忽略 */ }
        stats.lastError = `HTTP ${res.status} ${detail}`.trim();
        log(`推送失败 ${target.url}: HTTP ${res.status} ${detail}`.trim());
        return false;
      }
      return true;
    } catch (err) {
      stats.failures += 1;
      const msg = err?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : String(err?.message || err);
      stats.lastError = msg;
      log(`推送失败 ${target.url}: ${msg}`);
      return false;
    }
  }

  return {
    push,
    stats: () => ({ ...stats, targets: cursors.size }),
    reset() { cursors.clear(); },
  };
}