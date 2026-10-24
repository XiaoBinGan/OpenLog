import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { getToken, onAuthError, setToken } from '../api/auth';

/**
 * 访问令牌入口（生产模式必需）。
 *
 * 背景：服务端 NODE_ENV=production 时 /api 与 /ws 强制鉴权；而自动取令牌端点
 * GET /api/auth/token 只允许回环地址（非 localhost 一律 403）。因此用浏览器从
 * 其它机器访问时，客户端拿不到令牌 → 所有请求 401「Unauthorized — 需要有效的访问令牌」。
 *
 * 这里提供一个令牌输入门：输入后写入 localStorage（只在本机浏览器），后续访问
 * 免输入；令牌失效（401/403）时自动再次弹出。
 *
 * 令牌来源：服务端 data/.auth_token，或部署时设置的 OPENLOG_TOKEN 环境变量。
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  // 启动时 token 为空 → 直接要求输入（远端浏览器拿不到自动令牌）
  const [required, setRequired] = useState<boolean>(() => getToken() === null);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');

  useEffect(() => onAuthError(() => {
    // 已存在的令牌无效（服务端令牌变更/容器重建等）
    setRequired(true);
    setError('访问令牌无效或已变更，请重新输入');
  }), []);

  if (!required) return <>{children}</>;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (!token) {
      setError('请输入访问令牌');
      return;
    }
    setToken(token);
    // 重新加载：让所有已发起的请求与 WebSocket 用新令牌重新建立，
    // 避免页面上残留 401 状态。
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-950 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-dark-800 bg-dark-900 p-6 shadow-xl"
      >
        <h1 className="text-lg font-semibold text-dark-100">需要访问令牌</h1>
        <p className="mt-2 text-sm leading-relaxed text-dark-400">
          服务端已开启鉴权。请输入访问令牌（保存在本机浏览器，只需输入一次）。
        </p>
        <p className="mt-1 text-xs leading-relaxed text-dark-600">
          令牌位置：服务端 <code className="text-dark-400">data/.auth_token</code>，或
          部署时设置的 <code className="text-dark-400">OPENLOG_TOKEN</code> 环境变量。
        </p>

        <input
          type="password"
          value={value}
          onChange={e => { setValue(e.target.value); setError(null); }}
          placeholder="粘贴访问令牌"
          autoFocus
          autoComplete="off"
          className="mt-4 w-full rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2 text-sm text-dark-100 placeholder-dark-600 outline-none focus:border-emerald-500/60"
        />

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          className="mt-4 w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
        >
          进入 OpenLog
        </button>
      </form>
    </div>
  );
}