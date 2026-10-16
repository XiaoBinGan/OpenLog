// ESLint 扁平配置 —— 客户端（React 18 + TypeScript，严格模式）
//
// 由 `npm run lint`（在 client/ 下）或根目录的 `npm run lint:client` 调用。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.config.js', '*.config.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // 这个代码库里显式 any 较多（历史遗留），降为警告以便逐步收敛，
      // 但保留 no-unused-vars 以避免死代码堆积。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unused-expressions': ['warn', {
        allowShortCircuit: true,
        allowTernary: true,
      }],
      // 空 catch 是有意的清理路径
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },

  // 终端组件：这两个文件的核心工作是解析 ANSI 转义序列，
  // 控制字符（\x1b \x07 \x08 …）正是要被匹配的内容，
  // 不是「意外写进正则的控制字符」。因此在该作用域内关闭 no-control-regex。
  {
    files: [
      'src/components/ShellTerminal.tsx',
      'src/components/AIShellTerminal.tsx',
    ],
    rules: {
      'no-control-regex': 'off',
    },
  },

  // 测试 / 工具脚本
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
