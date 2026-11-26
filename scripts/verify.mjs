#!/usr/bin/env node
/**
 * 提交前门禁 —— 用一条命令跑完 CI 会跑的所有检查。
 *
 * 为什么需要它：本地只用 `npx eslint <改的文件>` 检查过、CI 却跑 `eslint .`，
 * 结果一次 `no-constant-binary-expression` 让 CI 红了（2026-11-26）。
 * 这个脚本的唯一目的就是：**本地和 CI 用同一套判据**，顺序也一致。
 *
 * 与 .github/workflows/ci.yml 的对应关系（改 CI 时请同步改这里）：
 *   npm run lint         → ① lint(server)
 *   npm run lint:client  → ② lint(client)
 *   npm run build        → ③ build（client 的 tsc -b && vite build，含类型检查）
 *   npm test             → ④ test（vitest run，含 server + docs + client）
 *
 * 用法：
 *   node scripts/verify.mjs              # 全量（默认）
 *   node scripts/verify.mjs --fast       # 跳过 build（改后端时够用）
 *   node scripts/verify.mjs --only=test  # 只跑某一项（lint|lint-client|build|test）
 *   node scripts/verify.mjs --quiet      # 只打印结论与失败详情
 *
 * 退出码：全部通过 0；任一步失败 1（并在最后汇总失败项）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;
const QUICK = has('--fast');
const QUIET = has('--quiet');

/** @type {{key:string,label:string,cmd:string,cmdArgs:string[],cwd?:string,skip?:string}[]} */
const STEPS = [
  {
    key: 'lint',
    label: 'lint(server)',
    cmd: 'npm',
    cmdArgs: ['run', 'lint'],
  },
  {
    key: 'lint-client',
    label: 'lint(client)',
    cmd: 'npm',
    cmdArgs: ['run', 'lint', '--prefix', 'client'],
  },
  {
    key: 'build',
    label: 'build(tsc + vite)',
    cmd: 'npm',
    cmdArgs: ['run', 'build'],
    skip: QUICK ? '--fast 已跳过' : null,
  },
  {
    key: 'test',
    label: 'test(vitest run)',
    cmd: 'npm',
    cmdArgs: ['test'],
  },
];

const color = process.stdout.isTTY
  ? { gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { gray: '', red: '', green: '', yellow: '', bold: '', reset: '' };

function log(line = '') {
  if (!QUIET) console.log(line);
}

/** 跑一个命令，把输出转发到当前进程（保留颜色），返回退出码 */
function run({ cmd, cmdArgs, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: cwd || ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? '1' : '0' },
    });
    const forward = (stream, target) => {
      stream.on('data', (chunk) => {
        // --quiet 时只在失败后回放（先缓存）
        if (QUIET) {
          buf.push(chunk);
        } else {
          target.write(chunk);
        }
      });
    };
    const buf = [];
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('error', (err) => {
      console.error(`${color.red}启动失败：${err.message}${color.reset}`);
      resolve({ code: 127, output: '' });
    });
    child.on('close', (code) => {
      if (QUIET && code !== 0) process.stdout.write(Buffer.concat(buf).toString());
      resolve({ code: code ?? 1, output: Buffer.concat(buf).toString() });
    });
  });
}

const startedAt = Date.now();
const results = [];

// 前置自检：node_modules 存在吗（否则报错信息会很难懂）
if (!existsSync(path.join(ROOT, 'node_modules'))) {
  console.error(`${color.red}✖ 缺少 node_modules，请先 npm install${color.reset}`);
  process.exit(1);
}
if (!existsSync(path.join(ROOT, 'client', 'node_modules'))) {
  console.error(`${color.red}✖ 缺少 client/node_modules，请先 npm install --prefix client${color.reset}`);
  process.exit(1);
}

log(`${color.bold}OpenLog 提交前门禁${color.reset}  ${color.gray}(与 CI 同一套判据)${color.reset}`);
log(`${color.gray}仓库：${ROOT}${color.reset}`);
if (QUICK) log(`${color.yellow}--fast：跳过 build${color.reset}`);
if (only) log(`${color.yellow}--only=${only}${color.reset}`);
log('');

for (const step of STEPS) {
  if (only && step.key !== only) continue;
  if (step.skip) {
    log(`${color.gray}⊘ ${step.label} —— ${step.skip}${color.reset}`);
    results.push({ label: step.label, ok: true, skipped: true, ms: 0 });
    continue;
  }
  const t0 = Date.now();
  log(`${color.bold}▶ ${step.label}${color.reset}`);
  const { code } = await run(step);
  const ms = Date.now() - t0;
  const ok = code === 0;
  results.push({ label: step.label, ok, skipped: false, ms });
  log(`${ok ? color.green + '✓' : color.red + '✖'} ${step.label}${color.reset} ${color.gray}(${(ms / 1000).toFixed(1)}s)${color.reset}`);
  log('');
  if (!ok) break; // 失败即停：后面的步骤通常也过不了，先修第一个
}

const failed = results.filter((r) => !r.ok);
const totalMs = Date.now() - startedAt;

log(`${color.gray}────────────────────────────────────────${color.reset}`);
if (failed.length === 0) {
  const ran = results.filter((r) => !r.skipped).length;
  log(`${color.green}${color.bold}✓ 全部通过${color.reset} —— ${ran} 项，共 ${(totalMs / 1000).toFixed(1)}s`);
  process.exit(0);
}
log(`${color.red}${color.bold}✖ 门禁未通过${color.reset} —— 失败项：`);
for (const f of failed) log(`  ${color.red}·${color.reset} ${f.label}`);
log(`${color.gray}提示：CI 与本脚本跑同一套命令（见 .github/workflows/ci.yml），本地过了 CI 一般也会过${color.reset}`);
process.exit(1);
