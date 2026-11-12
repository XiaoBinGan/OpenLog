/**
 * deploy/scripts/make-package.sh 与 README-offline.md 模板的一致性。
 *
 * 背景：离线包的 README 里写死过版本号 / 镜像文件名 / 架构，每打一个包就要手改四处。
 * 已经漏过两次：
 *   · x86 包文档写着上一版的文件名 → 照着 README 找不到文件
 *   · arm64 包文档写着「本包为 linux/amd64」→ 让人以为装错
 * 现在改成模板 + 渲染：文档内容一律从包内实际文件推导。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TEMPLATE = 'deploy/README-offline.md';
const MAKER = 'deploy/scripts/make-package.sh';

describe('README 模板 —— 不得写死与具体包相关的值', () => {
  const tpl = read(TEMPLATE);

  it('不写死版本号', () => {
    // 短 sha 一定是占位符。但不能用 /\b[0-9a-f]{7,40}\b/ —— 纯数字也会命中
    // （模板里有 max-age=31536000 这种缓存时长），必须要求至少含一个字母。
    expect(tpl).not.toMatch(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/);
  });

  it('不写死架构判定', () => {
    // 「本包为 linux/amd64」这种话必须由渲染填入
    expect(tpl).not.toMatch(/本包为 \*\*linux\/(amd64|arm64)/);
    expect(tpl).toContain('{{ARCH_LABEL}}');
  });

  it('不写死镜像归档文件名', () => {
    expect(tpl).not.toMatch(/openlog-[0-9a-f]{7,}-\d{8}-\d{6}\.tar\.gz/);
    expect(tpl).toContain('{{IMAGE_FILE}}');
  });

  it('不写死包目录名', () => {
    expect(tpl).not.toMatch(/openlog-deploy-[0-9a-f]{7,}/);
    expect(tpl).toContain('{{PKG_NAME}}');
    expect(tpl).toContain('{{SELF_TAR}}');
  });
});

describe('make-package.sh —— 渲染规则必须覆盖模板里所有占位符', () => {
  const tpl = read(TEMPLATE);
  const maker = read(MAKER);

  const tplVars = [...new Set((tpl.match(/\{\{[A-Z_]+\}\}/g) ?? []))];
  const makerVars = new Set(
    (maker.match(/\{\{[A-Z_]+\}\}/g) ?? []).filter((v) => v !== '{{[A-Z_]*}}'),
  );

  it('模板里有占位符（否则下面的检查没有意义）', () => {
    expect(tplVars.length).toBeGreaterThan(4);
  });

  it('每个模板占位符都有对应的 sed 替换', () => {
    const missing = tplVars.filter((v) => !makerVars.has(v));
    expect(missing, `未渲染的占位符: ${missing.join(', ')}`).toEqual([]);
  });

  it('渲染后要检查残留占位符并报错（否则发出去的就是带 {{}} 的文档）', () => {
    expect(maker).toMatch(/grep -q '\{\{\[A-Z_\]\*\}\}'/);
    expect(maker).toContain('残留占位符');
  });
});

describe('make-package.sh —— 装配行为的硬性约束', () => {
  const maker = read(MAKER);

  it('架构默认从归档里读，不是让用户填', () => {
    // 让用户填就会填错；能从镜像元数据推导的就不该问
    expect(maker).toMatch(/manifest\.json/);
    expect(maker).toMatch(/"architecture"/);
  });

  it('--arch 与归档实际架构不一致时拒绝', () => {
    // 变量加了花括号（bash 3.2 会把紧跟的多字节字符吞进变量名）
    expect(maker).toMatch(/归档架构是 \$\{ACTUAL_ARCH\}/);
  });

  it('包里不许出现 .deploy.json（含真实凭据）', () => {
    expect(maker).toContain("--exclude='.deploy.json'");
    // 两条防线：打包时排除 + 打完检查。
    // 检查用 case 而不是 `tar -tf | grep -q`：pipefail 下 grep 命中早退，
    // tar 吃 SIGPIPE(141)，管道被判失败 —— 文件在包里也会报「没有」。
    expect(maker).toMatch(/case "\$LIST" in\s*\n\s*\*\.deploy\.json\*\)\s*die/);
  });

  it('包里必须有 install.sh 且带架构自检', () => {
    expect(maker).toMatch(/case "\$LIST" in\s*\n\s*\*\/install\.sh\*\)/);
    expect(maker).toMatch(/grep -q 'check_arch'/);
  });

  it('镜像 tar 数量必须至少 2（应用 + postgres）', () => {
    expect(maker).toMatch(/N_TARS.*grep -c/);
    expect(maker).toMatch(/\[ "\$N_TARS" -ge 2 \]/);
  });

  it('包内 README-offline.md 与根 README.md 用同一份渲染结果', () => {
    // 两份各渲染一次可以，但必须同源，否则包内包外说法不一致
    const renders = (maker.match(/render "\$REPO_DIR\/deploy\/README-offline\.md"/g) ?? []).length;
    expect(renders).toBe(2);
  });
});
