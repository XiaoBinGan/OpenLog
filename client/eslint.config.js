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

      // 显式 any：**已知技术债，显式关闭而不是留着 190 条噪音**。
      //
      // 为什么不用 warn：190 行告警会让 `npm run lint` 长期刷屏，真正的新问题被淹没；
      // 团队实际行为是「滚过去不看」，等于这条规则不存在。
      // 为什么不当场修：190 处里 94 处是回调参数、45 处是跨边界断言（API 返回、第三方库），
      // 逐一换成 unknown + 类型守卫是独立重构（估 2-3 天），不该夹在发版里做。
      //
      // 收敛路径（也已写进 CHANGELOG 的「已知债」）：
      //   1. api/client.ts 的响应边界 → zod 或手写守卫收敛成具体类型
      //   2. catch (e: any) → catch (e) + e instanceof Error（35 处，机械但要看 body）
      //   3. 回调参数 → 从签名推导，最差用 unknown
      // 在这条规则被重新打开之前，新增 any 不会被发现 —— PR review 需人工盯。
      '@typescript-eslint/no-explicit-any': 'off',
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

  // Context 文件同时导出 Provider 组件与 useXxx hook —— 这是 React 惯用写法，
// react-refresh 想避免的是「组件文件混入非组件导出」，而 hook 与 Provider 必须同模块。
{
  files: ['src/contexts/**/*.tsx', 'src/components/monitor/TsdbSection.tsx', 'src/pages/settings/ModelSection.tsx'],
  rules: {
    'react-refresh/only-export-components': 'off',
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
