/// <reference types="vite/client" />

// Vite 的环境变量类型。补上之后 `import.meta.env` 才有类型，
// 原先 AIShellTerminal.tsx 里的 `// @ts-ignore` 就是在压这个缺失。
interface ImportMetaEnv {
  /** 构建期内置的访问令牌（可选）。未设置时回退到 localStorage 与 /api/auth/token。 */
  readonly VITE_OPENLOG_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
