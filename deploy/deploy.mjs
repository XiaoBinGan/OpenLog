/**
 * deploy/deploy.mjs — 从开发机一键部署到远端服务器（Windows / macOS / Linux 通用）。
 *
 * 解决的问题：之前「部署」是手工 6 步（打 bundle → SFTP 上传 → git reset → docker build
 * → docker rm/run 一长串 -e → 肉眼确认），既容易漏参数，也没法回滚。
 *
 * 现在一条命令：
 *     node scripts/deploy.mjs
 *
 * 它做的事：
 *   1. 打 git bundle（服务器通常连不上 GitHub，用 bundle 中转）
 *   2. SFTP 上传到服务器 /tmp
 *   3. 远程 git fetch + reset（代码更新）
 *   4. 调用服务器上的 deploy/deploy.sh → 备份 / 构建 / 启动 / 健康检查 / 失败回滚
 *
 * 依赖配置文件 `.deploy.json`（开发机本地，已 gitignore）：
 * {
 *   "host": "203.0.113.10",
 *   "port": 40022,
 *   "username": "deploy",
 *   "password": "…",            // 或用 "privateKeyPath": "C:\\path\\id_rsa"
 *   "appDir": "/workspace/Openlog-new",
 *   "branch": "node"
 * }
 *
 * 用法：
 *   node deploy/deploy.mjs                    # 完整部署
 *   node deploy/deploy.mjs --no-build         # 只同步代码+重启（改 deploy.env 后）
 *   node deploy/deploy.mjs --skip-backup      # 跳过数据库备份
 *   node deploy/deploy.mjs --dry-run          # 只打印远程将执行的命令
 *   node deploy/deploy.mjs --logs             # 只看服务状态/日志，不部署
 *   node deploy/deploy.mjs --save-image [tag] # 归档镜像到服务器 deploy/images/（默认 openlog:latest）
 *   node deploy/deploy.mjs --load-image <归档> [新tag]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// 配置优先 deploy/.deploy.json，兼容旧的根目录 .deploy.json
const CONFIG_PATH = fs.existsSync(path.join(ROOT, 'deploy', '.deploy.json'))
  ? path.join(ROOT, 'deploy', '.deploy.json')
  : path.join(ROOT, '.deploy.json');

const argv = new Set(process.argv.slice(2));
const has = (flag) => argv.has(flag);

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`缺少部署配置 ${CONFIG_PATH}\n   复制 scripts/deploy.config.example.json 为 .deploy.json 并填写服务器信息`);
  }
  let cfg;
  try {
    // ?? Windows ??? / PowerShell ??? UTF-8 BOM
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    fail(`解析 .deploy.json 失败: ${err.message}`);
  }
  for (const key of ['host', 'username', 'appDir']) {
    if (!cfg[key]) fail(`.deploy.json 缺少字段 ${key}`);
  }
  return cfg;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

async function main() {
  const cfg = loadConfig();
  const branch = cfg.branch || 'node';

  // 依赖：node-ssh 是项目依赖，直接用
  const { NodeSSH } = await import('node-ssh');

  const ssh = new NodeSSH();
  console.log(`\n▶ 连接 ${cfg.username}@${cfg.host}:${cfg.port || 22}`);
  await ssh.connect({
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.username,
    ...(cfg.privateKeyPath
      ? { privateKeyPath: cfg.privateKeyPath }
      : { password: cfg.password }),
    readyTimeout: 25_000,
  });
  console.log('  ✅ 已连接');

  const appDir = cfg.appDir;
  const remote = (cmd, opts = {}) => ssh.execCommand(cmd, { execTimeout: 1_200_000, ...opts });

  try {
    // ── 镜像归档（服务器上执行 save-image.sh）──
    if (has('--save-image')) {
      // 可选镜像 tag：node deploy/deploy.mjs --save-image openlog:<sha>
      // 带 tag 归档出来的文件名是 openlog-<sha>-<时间>.tar.gz，install.sh 靠文件名
      // 反推 IMAGE_TAG（openlog-<sha>-…），所以离线包要用带 sha 的 tag，别用 :latest。
      const idx = process.argv.indexOf('--save-image');
      const imageTag = process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--') ? process.argv[idx + 1] : '';
      console.log(`\n▶ 归档服务器上的镜像${imageTag ? ` ${imageTag}` : ''}`);
      const r = await remote(`cd ${appDir} && bash deploy/scripts/save-image.sh ${imageTag} 2>&1`);
      console.log(r.stdout || r.stderr);
      if (r.code !== 0) fail('镜像归档失败');
      return;
    }

    // ── 从归档恢复镜像 ──
    if (has('--load-image')) {
      const idx = process.argv.indexOf('--load-image');
      const archive = process.argv[idx + 1];
      if (!archive) fail('用法: node deploy/deploy.mjs --load-image deploy/images/<file>.tar.gz [新tag]');
      console.log(`\n▶ 恢复镜像 ${archive}`);
      const newTag = process.argv[idx + 2] && !process.argv[idx + 2].startsWith('--') ? process.argv[idx + 2] : '';
      const r = await remote(`cd ${appDir} && bash deploy/scripts/load-image.sh ${archive} ${newTag} 2>&1`);
      console.log(r.stdout || r.stderr);
      if (r.code !== 0) fail('镜像恢复失败');
      return;
    }

    // ── 只查看状态 ──
    if (has('--logs')) {
      const r = await remote(`
cd ${appDir}
echo "--- 容器 ---"
docker ps --filter name=openlog --format '{{.Names}} {{.Status}}'
echo "--- 部署状态 ---"
cat backups/.last-deploy.json 2>/dev/null || echo '(还没有部署记录)'
echo "--- 最近日志 ---"
docker logs --tail 40 openlog 2>&1 | tail -40
`);
      console.log(r.stdout || r.stderr);
      return;
    }

    // ── 1. 打 bundle 并上传 ──
    const localHead = git('rev-parse', '--short', 'HEAD');
    const dirty = git('status', '--porcelain');
    if (dirty) {
      console.log('\n⚠️  工作区有未提交改动，部署的是已提交内容（先 commit 更稳妥）：');
      console.log(dirty.split('\n').slice(0, 8).map(l => `   ${l}`).join('\n'));
    }

    const bundlePath = path.join(os.tmpdir(), `openlog-deploy-${Date.now()}.bundle`);
    console.log(`\n▶ 打包 ${branch} @ ${localHead}`);
    git('bundle', 'create', bundlePath, branch);
    const bundleSize = (fs.statSync(bundlePath).size / 1024).toFixed(0);
    console.log(`  ✅ ${bundleSize} KB`);

    const remoteBundle = '/tmp/openlog-deploy.bundle';
    console.log(`▶ 上传到 ${remoteBundle}`);
    await ssh.putFile(bundlePath, remoteBundle);
    console.log('  ✅ 上传完成');
    fs.rmSync(bundlePath, { force: true });

    // ── 2. 远程更新代码 ──
    console.log('▶ 更新远端代码');
    const fetch = await remote(`cd ${appDir} && git fetch ${remoteBundle} ${branch} 2>&1 | tail -2 && git reset --hard FETCH_HEAD 2>&1 | tail -1 && git log --oneline -1`);
    if (fetch.code !== 0) fail(`远端更新代码失败:\n${fetch.stdout}\n${fetch.stderr}`);
    console.log(`  ${fetch.stdout.trim().split('\n').pop()}`);

    // ── 3. 调用部署脚本 ──
    const passthrough = [];
    if (has('--no-build')) passthrough.push('--no-build');
    if (has('--skip-backup')) passthrough.push('--skip-backup');
    if (has('--dry-run')) passthrough.push('--dry-run');

    console.log(`\n▶ 执行远端部署${passthrough.length ? ` (${passthrough.join(' ')})` : ''}\n`);
    const deploy = await remote(`cd ${appDir} && bash deploy/deploy.sh ${passthrough.join(' ')}`);
    // 流式输出远端脚本结果
    console.log(deploy.stdout || '');
    if (deploy.stderr) console.log(deploy.stderr);

    if (deploy.code !== 0) {
      fail('部署失败（远端脚本已尝试回滚）。详细日志：ssh 上去执行 cd ${appDir} && docker logs --tail 80 openlog');
    }

    // ── 4. 汇总 ──
    const port = cfg.port_http || 3001;
    // 令牌从容器里读回来一并打印：省得部署完再 SSH 上去 cat data/.auth_token。
    // 读不到（旧部署/容器没起）就退回提示路径，不影响部署结论。
    let token = '';
    try {
      const r = await remote(`docker exec ${cfg.containerName || 'openlog'} cat /app/data/.auth_token 2>/dev/null || true`);
      token = (r.stdout || '').trim();
    } catch { /* 读令牌失败不影响部署结果 */ }
    console.log(`\n✅ 部署完成：http://${cfg.host}:${port}/`);
    console.log(`   访问令牌: ${token || `（见 ${appDir}/data/.auth_token）`}`);
    console.log(`   部署前工作区: ${dirty ? '有未提交改动' : '干净'}`);
  } finally {
    try { await ssh.dispose(); } catch { /* 忽略 */ }
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err?.message || err}`);
  process.exit(1);
});
