/**
 * kubeconfig 解析 —— 只读 Kubernetes 监控的第一步。
 *
 * 设计约束（见 /tmp/k8s-contract.md）：
 *   - 不引入 yaml 依赖，自己实现 kubeconfig 需要的 YAML 子集；
 *   - 输入以 `{` 开头按 JSON 处理（有人会把 kubeconfig 存成 JSON）；
 *   - 返回 KubeConfigResolved：server / namespace / authType / token / cert / key / ca /
 *     insecureSkipTlsVerify / contextName，其中所有 `*-data` 字段都是 base64，解码成 PEM 文本；
 *   - 任何失败都抛**中文** Error，说明清楚是哪个 context / user / cluster 出了问题。
 *
 * 支持的 YAML 子集（足够了，kubeconfig 只有这几百字节的结构）：
 *   - 块状 mapping / sequence，`- ` 可以出现在父键的任意缩进层级（k3s 的写法是顶格 `-`）；
 *   - 单引号 / 双引号标量（含转义）、`|` `>` 块标量（含 `-` `+` chomp 与显式缩进）；
 *   - `#` 注释、`---` / `...` 文档分隔符、`[]` `{}` 空结构；
 *   - 锚点 / 别名 / 多行 flow 集合**不支持**——kubeconfig 里不会出现，出现即报错。
 */

import { errorMessage } from '../errors.js';

/** YAML 块标量指示符：|、|-、|+、|2、|2-、>、>- …… */
const BLOCK_INDICATOR = /^[|>](?:[+-]?[1-9]?|[1-9][+-]?)$/;

/** base64 字符集（允许结尾 padding）。kubeconfig 的 *-data 不会是别的编码。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// ────────────────────────────────────────────────────────────────────────────
// YAML 子集解析
// ────────────────────────────────────────────────────────────────────────────

/** 构造带行号的中文 YAML 错误。 */
function yamlError(token, message) {
  return new Error(`第 ${token.lineNo} 行：${message}`);
}

/** 是否是序列项起始行（`-` 或 `- xxx`）。注意 `-foo` 是普通标量。 */
function isSeqLine(text) {
  return text === '-' || text.startsWith('- ');
}

/**
 * 去掉行尾注释。`#` 只有在行首或前面是空白时才是注释，
 * 引号内的 `#` 一律当作内容（token 里可能有 `#`，虽然 k8s 不会）。
 */
function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === '\\') {
        i += 1;
        if (i < line.length) out += line[i];
        continue;
      }
      if (ch === quote) {
        // YAML 单引号里用 '' 表示一个单引号
        if (quote === "'" && line[i + 1] === "'") {
          out += line[i + 1];
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

/** 解码双引号字符串里的转义（引号本身已被去掉）。 */
function decodeDoubleQuoted(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= body.length) break;
    const esc = body[i];
    switch (esc) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case '0': out += '\0'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case 'e': out += '\u001b'; break;
      case ' ': out += ' '; break;
      case 'x':
      case 'u':
      case 'U': {
        const width = esc === 'x' ? 2 : esc === 'u' ? 4 : 8;
        const hex = body.slice(i + 1, i + 1 + width);
        if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) {
          out += '\\' + esc;
          break;
        }
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += width;
        break;
      }
      default:
        // 未知转义原样保留，宁可多一个字符也不要静默吞掉
        out += '\\' + esc;
    }
  }
  return out;
}

/**
 * 解析单个标量。
 * 只有 true/false/null 会被转换类型；数字保持字符串——
 * server 的端口、namespace 里的纯数字都不该因为类型转换而变形。
 */
function parseScalar(rawValue) {
  const s = rawValue.trim();
  if (s === '') return null;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return decodeDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  const lower = s.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || s === '~') return null;
  // flow 集合无法可靠解析，原样返回字符串（kubeconfig 不会用到）
  return s;
}

/**
 * 把一行拆成 `key: value`。只认「冒号后面是空格或行尾」的冒号，
 * 这样 `server: https://127.0.0.1:6443` 的 key 才是 server。
 *
 * @returns {{ key: string, rest: string } | null}
 */
function splitKeyValue(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      const rawKey = text.slice(0, i).trim();
      if (rawKey === '') return null;
      const key = parseScalar(rawKey);
      return { key: typeof key === 'string' ? key : String(key), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

/**
 * 读取块标量（`|` / `>` 及其 chomp、缩进指示符）。
 *
 * @param {string[]} rawLines 原始行（未去注释）
 * @param {number} start 块内容起始行索引
 * @param {number} parentIndent 指示符所在行的缩进
 * @param {string} indicator 例如 `|-`
 * @returns {{ value: string, next: number }} next 为块结束后第一行的索引
 */
function readBlockScalar(rawLines, start, parentIndent, indicator) {
  const style = indicator[0];
  const chomp = indicator.includes('-') ? 'strip' : indicator.includes('+') ? 'keep' : 'clip';
  const explicit = /[1-9]/.exec(indicator);
  const lines = [];
  let i = start;

  while (i < rawLines.length) {
    const line = rawLines[i];
    if (line.trim() === '') {
      lines.push({ blank: true, text: '' });
      i += 1;
      continue;
    }
    const indent = /^[ \t]*/.exec(line)[0].length;
    if (indent <= parentIndent) break;
    lines.push({ blank: false, text: line, indent });
    i += 1;
  }

  let minIndent = explicit ? parentIndent + Number(explicit[0]) : Infinity;
  if (!explicit) {
    for (const l of lines) {
      if (!l.blank && l.indent < minIndent) minIndent = l.indent;
    }
    if (minIndent === Infinity) minIndent = parentIndent + 1;
  }

  const contents = lines.map((l) => (l.blank ? '' : l.text.slice(minIndent)));
  let text;
  if (style === '|') {
    text = contents.join('\n');
  } else {
    // 折叠：连续非空行用空格连起来，空行保留成换行
    text = '';
    for (const line of contents) {
      if (line === '') {
        text += '\n';
        continue;
      }
      if (text === '' || text.endsWith('\n')) text += line;
      else text += ` ${line}`;
    }
  }

  const stripped = text.replace(/\n+$/, '');
  let value;
  if (chomp === 'strip') value = stripped;
  else if (chomp === 'keep') value = stripped + text.slice(stripped.length);
  else value = stripped === '' ? '' : `${stripped}\n`;

  return { value, next: i };
}

/**
 * 词法：把文本整理成带缩进的 token 序列。
 *
 * token 形状：
 *   { indent, lineNo, seq: true }                    序列项标记
 *   { indent, lineNo, text }                         普通行（key: value 或标量）
 *   { indent, lineNo, key, blockValue }              块标量形式的 key
 *   { indent, lineNo, blockValue }                   块标量（序列项的值）
 */
function tokenize(text) {
  const rawLines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const tokens = [];
  let i = 0;

  while (i < rawLines.length) {
    const lineNo = i + 1;
    let line = rawLines[i];
    if (i === 0) line = line.replace(/^\uFEFF/, ''); // 去掉可能存在的 BOM
    i += 1;

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '---') continue;
    if (trimmed === '...') break;

    const leading = /^[ \t]*/.exec(line)[0];
    if (leading.includes('\t')) {
      throw new Error(`第 ${lineNo} 行：缩进不能使用 Tab，请改成空格`);
    }
    const indent = leading.length;
    const content = stripComment(line.slice(indent));
    if (content === '') continue;

    // `- ` 前缀逐层展开：`- name: x` → 序列标记 + 缩进更深的 `name: x`。
    // 这样后面的解析只需要处理「一行一个条目」的简单形态。
    const marks = [];
    let curIndent = indent;
    let rest = content;
    while (isSeqLine(rest)) {
      marks.push({ indent: curIndent, seq: true, lineNo });
      const after = rest.slice(1);
      const body = after.replace(/^[ \t]+/, '');
      if (body === '') {
        rest = '';
        break;
      }
      curIndent += 1 + (after.length - body.length);
      rest = body;
    }

    if (rest === '') {
      tokens.push(...marks);
      continue;
    }

    if (BLOCK_INDICATOR.test(rest)) {
      const { value, next } = readBlockScalar(rawLines, i, curIndent, rest);
      i = next;
      tokens.push(...marks, { indent: curIndent, lineNo, blockValue: value });
      continue;
    }

    const kv = splitKeyValue(rest);
    if (kv && BLOCK_INDICATOR.test(kv.rest)) {
      const { value, next } = readBlockScalar(rawLines, i, curIndent, kv.rest);
      i = next;
      tokens.push(...marks, { indent: curIndent, lineNo, key: kv.key, blockValue: value });
      continue;
    }

    tokens.push(...marks, { indent: curIndent, lineNo, text: rest });
  }

  return tokens;
}

/** 解析一个节点（mapping / sequence / 标量 / 块标量），入口缩进由调用方给。 */
function parseNode(state, indent) {
  const tok = state.tokens[state.pos];
  if (!tok) return null;
  // 注意顺序：`key: |` 的 token 同时带 key 与 blockValue，
  // 必须先当 mapping 行处理，否则会被误当成上一条键的标量值吞掉。
  if (tok.key !== undefined) return parseMapping(state, indent);
  if (tok.blockValue !== undefined) {
    state.pos += 1;
    return tok.blockValue;
  }
  if (tok.seq) return parseSequence(state, indent);
  if (!splitKeyValue(tok.text)) {
    // 序列项里的裸标量（kubeconfig 用不到，但语法上合法）
    state.pos += 1;
    return parseScalar(tok.text);
  }
  return parseMapping(state, indent);
}

function parseSequence(state, indent) {
  const arr = [];
  while (state.pos < state.tokens.length) {
    const tok = state.tokens[state.pos];
    if (!tok.seq || tok.indent !== indent) {
      if (tok.indent > indent) {
        throw yamlError(tok, `缩进不合法（序列项期望 ${indent} 个空格，实际 ${tok.indent} 个）`);
      }
      break;
    }
    state.pos += 1;
    const next = state.tokens[state.pos];
    if (!next || next.indent <= indent) {
      arr.push(null);
      continue;
    }
    arr.push(parseNode(state, next.indent));
  }
  return arr;
}

function parseMapping(state, indent) {
  const obj = {};
  while (state.pos < state.tokens.length) {
    const tok = state.tokens[state.pos];
    if (tok.seq || tok.indent < indent) break;
    if (tok.indent > indent) {
      throw yamlError(tok, `缩进不合法（键期望 ${indent} 个空格，实际 ${tok.indent} 个）`);
    }
    if (tok.key !== undefined) {
      state.pos += 1;
      obj[tok.key] = tok.blockValue;
      continue;
    }
    const kv = splitKeyValue(tok.text);
    if (!kv) throw yamlError(tok, '不是合法的 "key: value" 行');
    state.pos += 1;
    obj[kv.key] = parseAfterKey(state, indent, kv.rest);
  }
  return obj;
}

/** 解析 `key:` 后面的内容：同行的标量，或下一层缩进里的块。 */
function parseAfterKey(state, indent, rest) {
  if (rest !== '') return parseScalar(rest);
  const next = state.tokens[state.pos];
  if (!next) return null;
  if (next.indent > indent) return parseNode(state, next.indent);
  // k3s 风格：sequence 与父键同缩进
  if (next.indent === indent && next.seq) return parseSequence(state, indent);
  return null;
}

/** 解析整个 YAML 文本，返回 JS 值。 */
function parseYamlSubset(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  const state = { tokens, pos: 0 };
  const value = parseNode(state, tokens[0].indent);
  if (state.pos < state.tokens.length) {
    throw yamlError(state.tokens[state.pos], '无法归入文档结构，请检查缩进是否一致');
  }
  return value;
}

// ────────────────────────────────────────────────────────────────────────────
// kubeconfig 语义
// ────────────────────────────────────────────────────────────────────────────

/** 把任意值归一成「非空 trim 字符串」，数字/布尔按字面量转。 */
function toNonEmptyString(value) {
  if (typeof value === 'string') {
    const s = value.trim();
    return s === '' ? null : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const s = toNonEmptyString(value);
  return s ? s.toLowerCase() === 'true' : false;
}

/** 统一 server 写法：去空白与结尾斜杠，避免 client 拼出 `//api`。 */
function normalizeServer(value) {
  const s = toNonEmptyString(value);
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\/$/i.test(s)) return s;
  return s.replace(/\/+$/, '') || null;
}

/**
 * base64 → PEM 文本。`*-data` 在 kubeconfig 里一定是 base64。
 *
 * @param {unknown} value 原始字段值
 * @param {string} label 中文标签，用于报错文案
 * @returns {string | undefined}
 */
function decodeBase64(value, label) {
  const raw = toNonEmptyString(value);
  if (!raw) return undefined;
  const compact = raw.replace(/\s+/g, '');
  if (!BASE64_PATTERN.test(compact) || compact.length % 4 === 1) {
    throw new Error(`${label} 不是合法的 base64，无法解码成 PEM`);
  }
  const buf = Buffer.from(compact, 'base64');
  if (buf.length === 0) throw new Error(`${label} 解码后为空，不是合法的 base64`);
  return buf.toString('utf8');
}

/** 按 name 建索引；重复 name 取第一个（kubectl 也是先命中先用）。 */
function indexByName(list) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = toNonEmptyString(item.name);
    if (name && !map.has(name)) map.set(name, item);
  }
  return map;
}

/** 取嵌套子对象（`entry.cluster` / `entry.user` / `entry.context`），非对象当空对象。 */
function subObject(entry, key) {
  const v = entry && typeof entry === 'object' ? entry[key] : undefined;
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** 把 kubeconfig 文本解析成文档对象；JSON 与 YAML 两条路径。 */
function parseKubeconfigDocument(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('kubeconfig 内容为空，请粘贴完整的 kubeconfig 文本');
  }
  const trimmed = text.trim();
  let doc;
  if (trimmed.startsWith('{')) {
    try {
      doc = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`kubeconfig 不是合法的 JSON：${errorMessage(err)}`);
    }
  } else {
    try {
      doc = parseYamlSubset(trimmed);
    } catch (err) {
      throw new Error(`kubeconfig 不是合法的 YAML：${errorMessage(err)}`);
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('kubeconfig 顶层必须是对象（应包含 clusters / contexts / users）');
  }
  return doc;
}

/** 报错时附上可选项，用户一眼能看出拼错了哪个名字。 */
function availableHint(kind, names) {
  const list = [...names];
  return list.length ? `；可用的 ${kind}：${list.join('、')}` : `；kubeconfig 里没有任何 ${kind}`;
}

/**
 * 解析 kubeconfig，返回直连 kube-apiserver 所需的全部凭据。
 *
 * @param {string} text kubeconfig 原文（YAML 或 JSON）
 * @param {string} [contextName] 指定 context；为空则用 current-context
 * @returns {{
 *   server: string, namespace?: string, authType: 'cert' | 'token',
 *   token?: string, cert?: string, key?: string, ca?: string,
 *   insecureSkipTlsVerify: boolean, contextName: string
 * }}
 */
export function parseKubeconfig(text, contextName) {
  const doc = parseKubeconfigDocument(text);
  const clusters = indexByName(doc.clusters);
  const users = indexByName(doc.users);
  const contexts = indexByName(doc.contexts);

  const wanted = toNonEmptyString(contextName) ?? toNonEmptyString(doc['current-context']);
  if (!wanted) {
    throw new Error('kubeconfig 既没有指定 context，也没有 current-context 字段，无法确定要连接哪个集群');
  }

  const contextEntry = contexts.get(wanted);
  if (!contextEntry) {
    throw new Error(`找不到 context "${wanted}"${availableHint('context', contexts.keys())}`);
  }
  const ctx = subObject(contextEntry, 'context');

  const clusterName = toNonEmptyString(ctx.cluster);
  if (!clusterName) throw new Error(`context "${wanted}" 没有指定 cluster 字段`);
  const clusterEntry = clusters.get(clusterName);
  if (!clusterEntry) {
    throw new Error(
      `context "${wanted}" 指向的 cluster "${clusterName}" 不存在${availableHint('cluster', clusters.keys())}`,
    );
  }
  const cluster = subObject(clusterEntry, 'cluster');

  const server = normalizeServer(cluster.server);
  if (!server) {
    throw new Error(`cluster "${clusterName}" 的 server 为空，kubeconfig 缺少 clusters[].cluster.server`);
  }

  const ca = decodeBase64(
    cluster['certificate-authority-data'],
    `cluster "${clusterName}" 的 certificate-authority-data`,
  );
  const insecureSkipTlsVerify = toBoolean(cluster['insecure-skip-tls-verify']);

  const userName = toNonEmptyString(ctx.user);
  if (!userName) {
    throw new Error(
      `context "${wanted}" 没有指定 user，既没有 token 也没有客户端证书，无法认证`,
    );
  }
  const userEntry = users.get(userName);
  if (!userEntry) {
    throw new Error(
      `context "${wanted}" 指向的 user "${userName}" 不存在${availableHint('user', users.keys())}`,
    );
  }
  const user = subObject(userEntry, 'user');

  const token = toNonEmptyString(user.token);
  const cert = decodeBase64(
    user['client-certificate-data'],
    `user "${userName}" 的 client-certificate-data`,
  );
  const key = decodeBase64(user['client-key-data'], `user "${userName}" 的 client-key-data`);

  // 认证方式的选择顺序与 kube-apiserver 的认证器顺序一致：
  // x509 客户端证书先于 bearer token 被执行，所以两套凭据都在时以证书为准
  // （kubectl 也是两套一起发给服务端，由服务端按同样顺序裁决）。
  // 证书残缺（只有一半）时不影响可用的 token —— 宁可连上，也不要因为别人的笔误卡死。
  const hasCertPair = Boolean(cert && key);
  let authType;
  if (hasCertPair) {
    authType = 'cert';
  } else if (token) {
    authType = 'token';
  } else if (cert || key) {
    const missing = cert ? 'client-key-data' : 'client-certificate-data';
    throw new Error(
      `user "${userName}" 的客户端证书不完整：缺少 ${missing}，无法建立 mTLS 连接`,
    );
  } else {
    throw new Error(
      `context "${wanted}" 对应的 user "${userName}" 既没有 token 也没有客户端证书`
      + `（client-certificate-data / client-key-data），无法认证`,
    );
  }

  const namespace = toNonEmptyString(ctx.namespace);

  return {
    server,
    ...(namespace ? { namespace } : {}),
    authType,
    ...(token ? { token } : {}),
    ...(hasCertPair ? { cert, key } : {}),
    ...(ca ? { ca } : {}),
    insecureSkipTlsVerify,
    contextName: wanted,
  };
}

/**
 * 列表展示用的摘要。**绝不包含** token / 证书 / base64 原文，
 * 只回答「连哪、用哪个 context、怎么认证、默认命名空间是什么」。
 *
 * @param {string} text kubeconfig 原文
 * @param {string} [contextName] 指定 context；为空则用 current-context
 * @returns {{ server: string, contextName: string, authType: 'cert' | 'token', namespace: string | null }}
 */
export function describeKubeconfig(text, contextName) {
  const resolved = parseKubeconfig(text, contextName);
  return {
    server: resolved.server,
    contextName: resolved.contextName,
    authType: resolved.authType,
    namespace: resolved.namespace ?? null,
  };
}
