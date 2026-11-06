/**
 * 接口文档入口。
 *
 * 为什么不能直接 `<a href="/api/docs">`：本项目鉴权只认 `Authorization: Bearer`，
 * 浏览器地址栏导航带不了这个头，点过去只会看到 `{"error":"Unauthorized"}`。
 * （这是坚持不接受 `?token=` 的代价 —— 但把长期凭据写进 URL/历史/Referer 的代价更大，
 *  取舍写在 server/index.js 的 authMiddleware 注释里。）
 *
 * 做法：用原生 `fetch` 取回文档 HTML。注意：**不能**用 `apiFetch` —— 它固定按 JSON 解析，
 * 而这里要的是 HTML 文本。鉴权由 `api/auth.ts` 的全局 fetch 拦截器注入，这里不重复处理。
 */

/** 取回一份文本资源（非 2xx 抛错，带状态码与响应片段便于排障） */
async function fetchText(path: string): Promise<string> {
  const res = await fetch(path, { headers: { Accept: '*/*' } });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* 读不到就算了 */ }
    throw new Error(`${path} 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }
  return res.text();
}

/** 取回文档 HTML 并在新标签打开；返回是否成功打开（被弹窗拦截时为 false） */
export async function openApiDocs(): Promise<boolean> {
  const html = await fetchText('/api/docs');
  return openHtmlInNewTab(html);
}

/** 取回 OpenAPI JSON 并作为文件下载（给 Postman / Apifox 导入用）；返回大小描述 */
export async function downloadOpenApiJson(): Promise<string> {
  const text = await fetchText('/api/openapi.json');
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'openlog-openapi.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return text ? `${Math.round(text.length / 1024)} KB` : '';
}

/**
 * 把 HTML 字符串放进新标签页。
 * 用 Blob URL 而不是 document.write（后者在部分浏览器会丢样式表）。
 */
export function openHtmlInNewTab(html: string): boolean {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  // 5 分钟后回收；太早 revoke 会让新标签页白屏
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  return Boolean(win);
}
