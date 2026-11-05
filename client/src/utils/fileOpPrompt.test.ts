/**
 * client/src/utils/fileOpPrompt.test.ts
 *
 * 远程文件右键菜单的输入校验（与后端 server/remote-file-ops.js 规则保持一致）。
 */
import { describe, it, expect } from 'vitest';
import {
  validateFileName, validateRemotePathInput, validateMode,
  joinPath, baseName, parentDir, deleteConfirmText,
} from './fileOpPrompt';

describe('validateFileName —— 重命名 / 新建文件夹', () => {
  it('正常名字通过并 trim', () => {
    expect(validateFileName('  app.log.1  ')).toEqual({ ok: true, value: 'app.log.1' });
    expect(validateFileName('中文目录')).toEqual({ ok: true, value: '中文目录' });
  });
  it('空 / 点 / 双点 被拒绝', () => {
    expect(validateFileName('').ok).toBe(false);
    expect(validateFileName('   ').ok).toBe(false);
    expect(validateFileName('.').ok).toBe(false);
    expect(validateFileName('..').ok).toBe(false);
  });
  it('带路径分隔符被拒绝（防止越权移动到别的目录）', () => {
    expect(validateFileName('a/b').ok).toBe(false);
    expect(validateFileName('..\\b').ok).toBe(false);
  });
  it('换行/NUL 被拒绝，超长被拒绝', () => {
    expect(validateFileName('a\nb').ok).toBe(false);
    expect(validateFileName('a\u0000b').ok).toBe(false);
    expect(validateFileName('x'.repeat(256)).ok).toBe(false);
  });
});

describe('validateRemotePathInput —— 复制/移动目标路径', () => {
  it('绝对路径通过并折叠多余斜杠', () => {
    expect(validateRemotePathInput('/var//log/x.log')).toEqual({ ok: true, value: '/var/log/x.log' });
  });
  it('相对路径被拒绝', () => {
    expect(validateRemotePathInput('var/log/x').ok).toBe(false);
    expect(validateRemotePathInput('').ok).toBe(false);
  });
  it('换行/NUL 被拒绝', () => {
    expect(validateRemotePathInput('/tmp/a\nb').ok).toBe(false);
    expect(validateRemotePathInput('/tmp/a\u0000').ok).toBe(false);
  });
});

describe('validateMode —— chmod', () => {
  it('八进制通过', () => {
    expect(validateMode('755')).toEqual({ ok: true, value: '755' });
    expect(validateMode('0644')).toEqual({ ok: true, value: '0644' });
  });
  it('非八进制/带命令的输入被拒绝', () => {
    expect(validateMode('u+x').ok).toBe(false);
    expect(validateMode('777; rm -rf /').ok).toBe(false);
    expect(validateMode('').ok).toBe(false);
    expect(validateMode('99').ok).toBe(false);
  });
});

describe('joinPath / baseName / parentDir', () => {
  it('joinPath 处理根目录与普通目录', () => {
    expect(joinPath('/', 'a.log')).toBe('/a.log');
    expect(joinPath('/var/log', 'a.log')).toBe('/var/log/a.log');
    expect(joinPath('/var/log/', 'a.log')).toBe('/var/log/a.log');
  });
  it('baseName 取文件名', () => {
    expect(baseName('/var/log/app.log')).toBe('app.log');
    expect(baseName('/var/log/')).toBe('log');
    expect(baseName('/app.log')).toBe('app.log');
  });
  it('parentDir 取父目录（根目录兜底）', () => {
    expect(parentDir('/var/log/app.log')).toBe('/var/log');
    expect(parentDir('/app.log')).toBe('/');
    expect(parentDir('/var/log/')).toBe('/var');
  });
});

describe('deleteConfirmText —— 删除确认要写清路径', () => {
  it('文件与目录的文案不同', () => {
    expect(deleteConfirmText('file', 'a.log', '/tmp/a.log')).toContain('文件');
    expect(deleteConfirmText('dir', 'dir1', '/tmp/dir1')).toContain('目录及其全部内容');
  });
  it('包含完整路径和不可撤销提示', () => {
    const t = deleteConfirmText('file', 'a.log', '/tmp/a.log');
    expect(t).toContain('/tmp/a.log');
    expect(t).toContain('不可撤销');
  });
});
