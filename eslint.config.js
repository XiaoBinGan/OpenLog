// ESLint 扁平配置 —— 服务端（Node / ESM）
//
// 客户端（React + TS）有独立配置 client/eslint.config.js，由 `npm run lint:client` 调用。
// 这里通过 ignores 把 client/ 排除，避免两套规则互相干扰。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'client/**',
      'node_modules/**',
      'data/**',
      'coverage/**',
      'dist/**',
      '**/*.min.js',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 未使用的变量降为警告：这个代码库里有不少历史遗留，但值得逐步清理
      'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // 空 catch 块是有意为之（清理路径上"失败了也无所谓"），但空 if/for 不是
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // 允许 `cond ? a() : b()` 这类惯用短路写法
      'no-unused-expressions': ['warn', { allowShortCircuit: true, allowTernary: true }],
      // 生产代码里 console 是有意的日志输出，不禁止
      'no-console': 'off',
    },
  },

  // 测试文件：放宽断言相关的规则
  {
    files: ['**/*.test.js', '**/__tests__/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
    rules: {
      'no-unused-vars': 'off',
    },
  },
];
