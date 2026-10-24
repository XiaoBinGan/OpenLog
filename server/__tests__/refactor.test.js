/**
 * 抽取重构的不变量。
 *
 * 这些测试不检查业务行为，而是守住「把代码从 index.js 搬到 routes/ 时
 * 容易静默踩坏」的几类问题 —— 它们都能通过 `node --check`，
 * 也常常能通过浅层的 HTTP 冒烟测试，只在特定代码路径上才炸。
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

/**
 * 剥掉整个注释行与块注释后再做标识符扫描。
 *
 * 不这么做就会把文档注释里提到的符号当成真实调用 —— 例如修复
 * docker.getContainer 时，注释里为了说明问题写了一句
 * 「原实现调用 docker.getContainer(...)」，测试便把它当成仍在调用。
 * 只剥「整行注释」与「块注释」，不动行尾的字符串字面量，
 * 以免误伤 'http://...' 这类内容。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

describe('抽取重构不变量', () => {
  /**
   * 事故背景：抽出 remote 路由时用了
   *     import remote from '../remote.js'
   * 这是**默认导出对象**。而 `execShellCommand` 只有命名导出、
   * 没有被收进 default 对象里，于是 `remote.execShellCommand` 是 undefined ——
   * 只有当 AI Shell 真的走到执行那一步时才会抛 "is not a function"。
   *
   * 检查必须区分导入方式，否则会误报：
   *     import * as remote ...   → 拿到全部命名导出
   *     import remote ...        → 只拿到 default 对象里的成员
   * index.js 用的是前者，所以它引用 execShellCommand 是安全的；
   * 路由文件当初用的是后者，于是炸了。
   */
  it('每个 remote.* 引用都能通过该文件的导入方式解析', async () => {
    const remoteMod = await import('../remote.js');
    const namedKeys = new Set(Object.keys(remoteMod).filter((k) => k !== 'default'));
    const defaultKeys = new Set(Object.keys(remoteMod.default ?? {}));

    const callers = jsFiles(SERVER_DIR).filter(
      (f) => f !== path.join(SERVER_DIR, 'remote.js') && !f.includes('__tests__'),
    );

    const problems = [];
    let checked = 0;
    for (const f of callers) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const rel = path.relative(SERVER_DIR, f);
      const asNamespace = /import\s+\*\s+as\s+remote\s+from/.test(src);
      const asDefault = /import\s+remote\s+from/.test(src);
      if (!asNamespace && !asDefault) continue;

      for (const m of src.matchAll(/\bremote\.([A-Za-z_$][\w$]*)\b/g)) {
        const member = m[1];
        if (member === 'js') continue; // 匹配到 './remote.js' 字符串的误报
        checked++;
        const ok = asNamespace ? namedKeys.has(member) : defaultKeys.has(member);
        if (!ok) {
          problems.push(
            `${rel} 用 ${asNamespace ? '命名空间' : '默认'}导入，但 remote.${member} 不可用`,
          );
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  /**
   * 同类问题的另一处：`/api/docker/containers/:sourceId/:containerId` 调用了
   * `docker.getContainer(...)`，而 docker.js 从未导出过这个名字 ——
   * 该路由对任何请求都返回 500 "docker.getContainer is not a function"。
   * 这是抽取之前就存在的，不是重构引入的，但同一个检查可以顺带守住它。
   */
  it('每个 docker.* 引用都能通过该文件的导入方式解析', async () => {
    const dockerMod = await import('../docker.js');
    const namedKeys = new Set(Object.keys(dockerMod).filter((k) => k !== 'default'));
    const defaultKeys = new Set(Object.keys(dockerMod.default ?? {}));
    const available = new Set([...namedKeys, ...defaultKeys]);

    const callers = jsFiles(SERVER_DIR).filter((f) => f !== path.join(SERVER_DIR, 'docker.js'));
    const problems = [];
    let checked = 0;
    for (const f of callers) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/\bdocker\.([A-Za-z_$][\w$]*)/g)) {
        const member = m[1];
        if (member === 'js' || member === 'sock') continue; // './docker.js' 与 '/var/run/docker.sock'
        checked++;
        if (!available.has(member)) {
          problems.push(`${path.relative(SERVER_DIR, f)} 引用了不存在的 docker.${member}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  /** 反向确认：确实存在「有命名导出但不在 default 对象里」的成员 —— 这正是当初的坑。 */
  it('default 对象不是全部命名导出的超集（所以导入方式必须匹配）', async () => {
    const remoteMod = await import('../remote.js');
    // 下划线前缀是「仅供测试的内部导出」（如 _cryptoInternals），
    // 不属于运行时 API 面，不参与这条不变量检查。
    const namedKeys = [...Object.keys(remoteMod)].filter((k) => k !== 'default' && !k.startsWith('_'));
    const defaultKeys = new Set(Object.keys(remoteMod.default ?? {}));
    const notInDefault = namedKeys.filter((k) => !defaultKeys.has(k));
    // 如果哪天有人把 default 对象补全了，这条断言会失败 —— 那时可以放宽，
    // 但在那之前，用默认导入引用这些成员一定会炸。
    expect(notInDefault.length).toBeGreaterThan(0);
    for (const m of notInDefault) {
      expect(typeof remoteMod[m]).toBe('function');
    }
  });

  /**
   * 事故背景：抽出 remote 路由后，`stripThinking` 被漏掉了 ——
   * 它定义在 index.js 顶层，只在 AI Shell 拿到 LLM 回复后才调用。
   * `node --check` 查不出，浅层冒烟也查不出（请求提前返回了）。
   * 这里用 eslint 的 no-undef 思路做静态兜底：抽取出来的路由文件里
   * 不能出现「既没 import、也没在本文件或参数里定义」的自由标识符。
   *
   * 这里只做一个聚焦检查：路由模块必须能被 import 且能构造出 router，
   * 且 index.js 传给它的依赖键必须都在 index.js 里有定义。
   */
  it('index.js 注入给路由工厂的依赖都在 index.js 中有定义', () => {
    const indexSrc = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
    const definedAtTop = new Set();
    for (const m of indexSrc.matchAll(/^(?:async )?function\s+([A-Za-z_$][\w$]*)/gm)) definedAtTop.add(m[1]);
    for (const m of indexSrc.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) definedAtTop.add(m[1]);

    // 支持两种写法：
    //   { ensureSettings, broadcast }        → 简写，名字即来源
    //   { authToken: AUTH_TOKEN }            → 带值，来源是冒号右边的标识符
    //   { getLastPatrolResults, setLastPatrolResults } → 混合（上面两行 inject 跨行）
    const injections = [];
    for (const call of indexSrc.matchAll(/app\.use\(\s*create\w*Router\(\{([\s\S]*?)\}\s*\)\s*\)/g)) {
      for (const part of call[1].split(',')) {
        const text = part.trim();
        if (!text) continue;
        const [left, right] = text.split(':').map((s) => s.trim());
        const source = right || left; // 有冒号取右边，否则取名字本身
        if (/^[A-Za-z_$][\w$]*$/.test(source)) injections.push(source);
      }
    }

    expect(injections.length).toBeGreaterThan(0);
    const unknown = injections.filter((name) => !definedAtTop.has(name));
    expect(unknown, `这些注入名在 index.js 顶层找不到定义: ${unknown.join(', ')}`).toEqual([]);
  });

  it('路由文件不再把内部辅助逻辑留在 index.js 之外引用', () => {
    // 安全辅助函数曾被 remote 区块使用、却定义在区块内，
    // 而 docker 的 /exec 路由在区块外也要用它。现在它必须住在 security/ 下。
    const policy = path.join(SERVER_DIR, 'security', 'shell-command-policy.js');
    expect(fs.existsSync(policy)).toBe(true);
    const indexSrc = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
    // index.js 里不能再有这些符号的定义（只能是 import）
    for (const name of ['READONLY_COMMANDS', 'hasShellMetaChars', 'commandBaseName', 'rejectUnlessRemoteExecEnabled']) {
      expect(
        new RegExp(`^(?:const|function|let)\\s+${name}\\b`, 'm').test(indexSrc),
        `${name} 不该在 index.js 里被定义`,
      ).toBe(false);
    }
  });
});
