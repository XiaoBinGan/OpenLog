/**
 * 离线打包脚本的可移植性与管道安全。
 *
 * 这三条都是 macOS 上真实跑出来的 bug —— 我的环境（Linux 5.x / git-bash）
 * 完全没复现，因为：
 *   · bash 3.2 vs 5.x 对「变量后紧跟多字节字符」的处理不同
 *   · 包小时 tar 输出小于管道缓冲，grep -q 早退不产生 SIGPIPE
 * 所以必须用静态检查锁住，而不是靠"我这边跑通了"。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SCRIPTS = [
  'deploy/scripts/make-package.sh',
  'deploy/install.sh',
  'deploy/deploy.sh',
  'deploy/scripts/load-image.sh',
  'deploy/scripts/save-image.sh',
];

describe('shell 脚本 —— bash 3.2 兼容（macOS 自带）', () => {
  it('变量后紧跟非 ASCII 字符时必须用 ${VAR} 花括号', () => {
    // bash 3.2 会把多字节字符的首字节吞进变量名，报
    //   "PKG_NAME<乱码>: unbound variable"，脚本直接起不来。
    // Linux bash 5 不受影响 —— 所以只在 macOS 上炸，最难查的那种。
    const bad: string[] = [];
    for (const f of SCRIPTS) {
      read(f).split('\n').forEach((line, i) => {
        // $VAR 后面直接跟 >=0x80 的字节
        if (/\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/.test(line)) {
          bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    expect(bad, `需要加花括号:\n${bad.join('\n')}`).toEqual([]);
  });
});

describe('shell 脚本 —— pipefail 下的 SIGPIPE 假失败', () => {
  it('不要用 `cmd | grep -q` 做存在性判断', () => {
    // grep -q 命中即退出 → 上游命令收到 SIGPIPE 返回 141 → pipefail 判整条管道失败。
    // 于是"文件明明在包里"也会报"没有"。包越大越容易复现（tar 输出超过管道缓冲）。
    const bad: string[] = [];
    for (const f of SCRIPTS) {
      read(f).split('\n').forEach((line, i) => {
        // 跳过注释行：脚本里的注释恰恰在解释「为什么不能这么写」
        if (line.trim().startsWith('#')) return;
        if (/\|\s*grep\s+-[a-zA-Z]*q/.test(line)) {
          bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }
    expect(bad, `改用 case 匹配或 herestring:\n${bad.join('\n')}`).toEqual([]);
  });

  it('存在性判断用 case 字符串匹配（纯 bash，不起管道）', () => {
    const maker = read('deploy/scripts/make-package.sh');
    expect(maker).toMatch(/LIST="\$\(tar -tf "\$OUT"\)"/);
    expect(maker).toMatch(/case "\$LIST" in\s*\n\s*\*\/install\.sh\*\)/);
    expect(maker).toMatch(/case "\$LIST" in\s*\n\s*\*\.deploy\.json\*\)\s*die/);
  });

  it('计数用 grep -c（读完全部输入，不会早退）', () => {
    const maker = read('deploy/scripts/make-package.sh');
    expect(maker).toMatch(/printf '%s\\n' "\$LIST" \| grep -c '\\\.tar\\\.gz\$'/);
  });
});

describe('make-package.sh —— 成品 README 不该留模板说明', () => {
  const maker = read('deploy/scripts/make-package.sh');
  const tpl = read('deploy/README-offline.md');

  it('模板里的维护说明用 TEMPLATE-NOTE 标记', () => {
    expect(tpl).toContain('<!-- TEMPLATE-NOTE');
  });

  it('render() 会剥掉该注释块', () => {
    // 成品包里出现「本文件是模板」很怪 —— 它明明是成品
    expect(maker).toMatch(/\/<!-- TEMPLATE-NOTE\/ \{ skip=1 \}/);
    expect(maker).toMatch(/skip && \/-->\/\s*\{ skip=0; next \}/);
  });

  it('剥离逻辑在 sed 之后（否则占位符还没替换就丢内容）', () => {
    const renderBody = maker.slice(maker.indexOf('render() {'), maker.indexOf('\n}', maker.indexOf('render() {')));
    const sedIdx = renderBody.indexOf('sed');
    const awkIdx = renderBody.indexOf('awk');
    expect(sedIdx).toBeGreaterThan(-1);
    expect(awkIdx).toBeGreaterThan(sedIdx);
  });
});