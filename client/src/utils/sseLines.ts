/**
 * SSE 行切分器。
 *
 * 背景（真实 bug）：原来前端直接 `chunk.split('\n')`，没有跨 chunk 保留残行。
 * 一次 `reader.read()` 拿到的可能是半行（尤其 `tool_result` 这类较大的 JSON），
 * 被切开的 `data: {...}` 解析失败后被 `catch {}` 静默吞掉 —— 结果就是顶部
 * 工具 chip 永远停在「运行中」转圈，用户以为助手还没干完。
 *
 * 用法：
 *   const splitter = createSSELineSplitter();
 *   for each chunk: splitter.push(chunk) → 返回这次能确定的完整行
 *   流结束时：splitter.flush() → 返回最后残留的半行（通常为空）
 */
export function createSSELineSplitter() {
  let buffer = '';

  return {
    /** 喂一段文本，返回其中所有完整行（不含换行符） */
    push(chunk: string): string[] {
      if (!chunk) return [];
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      return lines;
    },
    /** 流结束：把残留内容当作最后一行返回（没有则返回空数组） */
    flush(): string[] {
      if (!buffer) return [];
      const rest = buffer;
      buffer = '';
      return [rest];
    },
    /** 当前残留（仅调试/测试用） */
    peek(): string {
      return buffer;
    },
  };
}

/** 从一行 `data: ...` 里取出 payload；不是 data 行返回 null */
export function parseSSEDataLine(line: string): string | null {
  const text = String(line || '').replace(/\r$/, '');
  if (!text.startsWith('data:')) return null;
  return text.slice(5).trimStart();
}
