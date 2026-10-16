/**
 * better-sqlite3 原生模块安装守卫。
 *
 * 背景：better-sqlite3 官方为各受支持 Node 版本发布预编译产物，安装时由其
 * 自身的 install 脚本（prebuild-install）下载。旧实现无条件 `npm rebuild
 * better-sqlite3`，强制走 node-gyp 源码编译 —— 每次 `npm ci` 都要额外耗时
 * 约 8 分钟，且 CI（GitHub Actions，Node 20 + npm 10.8.2）曾在此阶段异常
 * 退出（npm "Exit handler never called!"），留下残缺的 node_modules。
 *
 * 这里先探测预编译产物能否直接加载：可以就直接用（快、稳）；只有预编译
 * 不可用（自编译 Node、罕见平台、ABI 不匹配等）时才回落到源码编译，
 * 行为与旧实现等价。
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);

try {
  require('better-sqlite3');
  console.log('[postinstall] better-sqlite3 预编译产物可用，跳过源码编译');
} catch (err) {
  console.warn(
    `[postinstall] better-sqlite3 预编译不可用（${err.message}），回落到源码编译`,
  );
  execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });
}
