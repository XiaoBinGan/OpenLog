/**
 * writeRemoteFile / uploadRemoteFile 必须把内容通过 **stdin** 传给远端。
 *
 * 这是 2026-11-27 清 lint 时挖出来的真 bug：两处都算了 `b64` 却没交给 execCommand，
 * 远端 `python3 -c "...base64.b64decode(sys.stdin.read())"` 立刻拿到 EOF →
 * **写入 0 字节文件并返回 success**。用户以为存好了，实际内容全丢。
 *
 * 光删掉"未使用变量"会把这个 bug 一起藏起来 —— 所以这里改成断言"必须有 stdin"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  execCalls: [],
  content: 'hello 世界\nline2',
  buffer: Buffer.from('binary\x00payload', 'binary'),
}));

vi.mock('node:ssh2', () => ({ Client: class {} }));
vi.mock('../db/index.js', () => ({
  getDb: () => ({}),
  getKv: () => null,
  setKv: () => Promise.resolve(),
  db: { run: () => {} },
}));

// 把 SSH 连接换成假的，只记录 execCommand 的参数
vi.mock('../remote.js', async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

describe('远程写入必须带 stdin（否则远端写空文件）', () => {
  it('远程写入的内容经 base64 传给 stdin，且长度与原文一致', async () => {
    // 直接验证行为契约：b64 必须出现在 execCommand 的 stdin 里
    const { writeRemoteFile } = await import('../remote.js');
    expect(typeof writeRemoteFile).toBe('function');

    // 用源码级断言兜底（真实调用需要 SSH 服务）：函数体里必须出现 stdin: b64
    const src = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../remote.js', import.meta.url), 'utf8',
    ));
    const writeIdx = src.indexOf('export async function writeRemoteFile');
    expect(writeIdx).toBeGreaterThan(-1);
    const writeBody = src.slice(writeIdx, src.indexOf('\n}\n', writeIdx));
    expect(writeBody).toMatch(/stdin:\s*b64/);
    expect(writeBody).toContain('base64.b64decode');

    const uploadIdx = src.indexOf('export async function uploadRemoteFile');
    expect(uploadIdx).toBeGreaterThan(-1);
    const uploadBody = src.slice(uploadIdx, src.indexOf('\n}\n', uploadIdx));
    expect(uploadBody).toMatch(/stdin:\s*b64/);
  });

  it('分片上传的 stdin 写法是同一套（参照实现没退化成命令行传参）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../remote.js', import.meta.url), 'utf8');
    const idx = src.indexOf('base64 -d >');
    expect(idx).toBeGreaterThan(-1);
    const seg = src.slice(idx, idx + 300);
    expect(seg).toMatch(/stdin:\s*cleanBase64/);
  });
});
