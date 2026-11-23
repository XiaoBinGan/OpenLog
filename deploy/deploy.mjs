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
 *   3. 远程 git fetch → 漂移检测 → reset（代码更新）
 *   4. 调用服务器上的 deploy/deploy.sh → 备份 / 构建 / 启动 / 健康检查 / 失败回滚
 *
 * 漂移检测（防止静默覆盖服务端本地提交）：
 *   reset 之前先比对「服务端当前 HEAD」与「待部署提交（FETCH_HEAD）」：
 *     git merge-base --is-ancestor <服务器HEAD> <FETCH_HEAD>
 *   · 是祖先  → 正常部署（快进，不丢东西）
 *   · 不是祖先 → 服务端有未进仓库的本地提交，**中止部署**并列出这些提交
 *     （git log --oneline <FETCH_HEAD>..<服务器HEAD>，最多 20 条）
 *   · 加 --force 才允许覆盖，且覆盖前自动建备份分支 backup/predeploy-<sha>，输出里给回滚命令
 *   · 探测不出来（appDir 不存在 / 没有 HEAD / 连不上等）会明确说明跳过原因，不静默放行
 *
 * 依赖配置文件 `.deploy.json`（开发机本地，已 gitignore），可用 `--init` 生成模板：
 * {
 *   "host": "203.0.113.10",
 *   "port": 40022,
 *   "username": "your-ssh-user",
 *   "password": "…",            // 或用 "privateKeyPath": "C:\\path\\id_rsa"
 *   "appDir": "/workspace/Openlog-new",
 *   "branch": "node"
 * }
 *
 * 用法：
 *   node deploy/deploy.mjs                    # 完整部署
 *   node deploy/deploy.mjs --no-build         # 只同步代码+重启（改 deploy.env 后）
 *   node deploy/deploy.mjs --skip-backup      # 跳过数据库备份
 *   node deploy/deploy.mjs --dry-run          # 只打印远程将执行的命令（含漂移检查结果）
 *   node deploy/deploy.mjs --logs             # 只看服务状态/日志，不部署
 *   node deploy/deploy.mjs --init             # 生成 .deploy.json 模板（纯本地，不联网）
 *   node deploy/deploy.mjs --force            # 服务端有未推送提交时仍允许覆盖（先自动备份分支）
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
// `--init` 的固定落点与模板：始终写 deploy/.deploy.json（优先级高于根目录旧文件）
const DEPLOY_CONFIG_PATH = path.join(__dirname, '.deploy.json');
const CONFIG_EXAMPLE_PATH = path.join(__dirname, 'deploy.config.example.json');
const LEGACY_CONFIG_PATH = path.join(ROOT, '.deploy.json');

const argv = new Set(process.argv.slice(2));
const has = (flag) => argv.has(flag);

// --help：只打印用法并退出，不读配置、不连服务器（之前会直接去 SSH 握手）
if (has('--help') || has('-h')) {
  console.log(`
OpenLog 一键部署（开发机 → 服务器）

用法：
  node deploy/deploy.mjs                   完整部署（拉 bundle → 上传 → 远端 reset → 构建 → 健康检查 → 失败回滚）
  node deploy/deploy.mjs --dry-run         只打印将要执行的远端命令（含漂移检查结果），不改动线上
  node deploy/deploy.mjs --logs            只看服务状态/日志，不部署
  node deploy/deploy.mjs --no-build        只同步代码 + 重启（改过 deploy.env 后用）
  node deploy/deploy.mjs --skip-backup     跳过数据库备份（不建议）
  node deploy/deploy.mjs --force           允许覆盖服务端本地提交（会先建 backup/predeploy-<sha> 备份分支）
  node deploy/deploy.mjs --init            生成 deploy/.deploy.json 配置模板（--force 覆盖已有）
  node deploy/deploy.mjs --save-image [tag]   归档镜像到服务器 deploy/images/
  node deploy/deploy.mjs --load-image <归档> [新tag]

配置：deploy/.deploy.json（已 gitignore，首次用 --init 生成）
  { host, port, username, password | privateKeyPath, appDir, branch, port_http }
  注意：branch 填开发分支 node；main 只用于发版。
`);
  process.exit(0);
}
// 允许覆盖服务端本地提交（仍需显式 --force）
const FORCE = has('--force');

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

/** POSIX shell 单引号转义（appDir / 分支名进远端命令前必须过一遍） */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(
      `缺少部署配置 ${CONFIG_PATH}\n   ` +
        '生成模板：node deploy/deploy.mjs --init\n   ' +
        '然后填写 host / port / username / privateKeyPath / appDir / branch'
    );
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

// ─────────────────────────── --init：生成配置模板 ───────────────────────────

/** 纯本地操作：不 import node-ssh、不建连接、不碰网络 */
function runInit() {
  console.log('\n▶ 生成部署配置模板');
  if (!fs.existsSync(CONFIG_EXAMPLE_PATH)) {
    fail(`缺少模板文件 ${CONFIG_EXAMPLE_PATH}（仓库不完整？）`);
  }

  const exists = fs.existsSync(DEPLOY_CONFIG_PATH);
  if (exists && !FORCE) {
    fail(
      `配置已存在：${DEPLOY_CONFIG_PATH}\n   ` +
        '未做任何修改。确认要覆盖请加 --force（会丢掉当前配置，建议先 cp 备份）'
    );
  }
  if (exists) console.log(`  ⚠️  已存在，按 --force 覆盖：${DEPLOY_CONFIG_PATH}`);

  let template;
  try {
    template = fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf8').replace(/^\uFEFF/, '');
    JSON.parse(template); // 先验证模板本身是合法 JSON，别生成个坏文件
  } catch (err) {
    fail(`模板 ${CONFIG_EXAMPLE_PATH} 不是合法 JSON: ${err.message}`);
  }

  fs.mkdirSync(path.dirname(DEPLOY_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(DEPLOY_CONFIG_PATH, template, { encoding: 'utf8', mode: 0o600 });
  console.log(`  ✅ 已写入 ${path.relative(ROOT, DEPLOY_CONFIG_PATH)}（权限 600）`);

  console.log('\n下一步：编辑 deploy/.deploy.json，把占位值换成真实信息');
  console.log('   host             目标服务器 IP 或域名（如 100.100.152.243）');
  console.log('   port             SSH 端口，默认 22（非标端口务必填，如 40022）');
  console.log('   username         SSH 用户名（如 smai）');
  console.log('   privateKeyPath   私钥绝对路径（如 ~/.ssh/id_ed25519）；填了它就不用 password');
  console.log('   password         改用密码登录时才填（二选一，别两个都留）');
  console.log('   appDir           服务器上的仓库目录（如 /workspace/Openlog-new），必须是 git 仓库');
  console.log(`   branch           要部署的分支，默认 node（示例里是 main，按需改）`);
  console.log('   port_http        应用端口，默认 3001，仅用于打印访问地址');

  console.log('\n说明');
  console.log('   · deploy/.deploy.json 已在 .gitignore 里，不会提交进仓库');
  console.log('   · 校验配置：node deploy/deploy.mjs --dry-run');
  console.log('   · 服务端有未推送的提交时，部署会被拦下并列出这些提交；');
  console.log('     确认要丢弃再加 --force（覆盖前会自动建 backup/predeploy-<sha> 备份分支）');
  if (fs.existsSync(LEGACY_CONFIG_PATH)) {
    console.log(`   ⚠️  检测到旧的根目录配置 ${path.relative(ROOT, LEGACY_CONFIG_PATH)}，它会被 deploy/ 下的同名文件覆盖，可删除`);
  }
}

// ───────────────────── 漂移检测：服务端本地提交保护 ─────────────────────

/**
 * 远端探测脚本：一次 SSH 往返拿到所有判断依据。
 * 输出用 KEY=VALUE 行 + ---COMMITS--- 段，便于本地纯函数解析（也方便 /tmp 里直接 bash 验证）。
 */
function buildDriftProbe(appDir) {
  return [
    `cd ${shq(appDir)} 2>/dev/null || { echo "DRIFT_ERR=appdir"; exit 0; }`,
    'git rev-parse --git-dir >/dev/null 2>&1 || { echo "DRIFT_ERR=appdir"; exit 0; }',
    'if ! RH=$(git rev-parse --verify HEAD 2>/dev/null); then echo "DRIFT_ERR=nobase"; exit 0; fi',
    'if ! TG=$(git rev-parse --verify FETCH_HEAD 2>/dev/null); then echo "DRIFT_ERR=notarget"; exit 0; fi',
    'SH=$(git rev-parse --short=8 "$RH" 2>/dev/null); [ -n "$SH" ] || SH=$(printf %s "$RH" | cut -c1-8)',
    'echo "DRIFT_HEAD=$RH"',
    'echo "DRIFT_HEAD_SHORT=$SH"',
    'echo "DRIFT_TARGET=$TG"',
    'git merge-base --is-ancestor "$RH" "$TG" >/dev/null 2>&1',
    'MC=$?',
    'if [ "$MC" -eq 0 ]; then',
    '  echo "DRIFT_STATE=ancestor"',
    'elif [ "$MC" -eq 1 ]; then',
    '  echo "DRIFT_STATE=diverged"',
    '  echo "---COMMITS---"',
    '  git log --oneline -20 "$TG..$RH" 2>&1',
    'else',
    '  echo "DRIFT_STATE=unknown"',
    '  echo "DRIFT_MERGEBASE=$MC"',
    'fi',
  ].join('\n');
}

/**
 * 解析探测输出 → 结构化结论。
 * status: ancestor | diverged | nobase | notarget | unreachable | unknown
 */
function parseDriftProbe(output) {
  const text = String(output ?? '');
  const pick = (key) => (text.match(new RegExp(`^${key}=(\\S+)$`, 'm')) || [])[1] || '';
  const base = {
    status: 'unknown',
    head: pick('DRIFT_HEAD'),
    headShort: pick('DRIFT_HEAD_SHORT'),
    target: pick('DRIFT_TARGET'),
    commits: [],
    detail: '',
  };

  let commits = [];
  const marker = text.indexOf('---COMMITS---');
  if (marker >= 0) {
    commits = text
      .slice(marker + '---COMMITS---'.length)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const err = pick('DRIFT_ERR');
  if (err === 'appdir') {
    return { ...base, status: 'unreachable', detail: '服务器上找不到 appDir，或它不是 git 仓库' };
  }
  if (err === 'nobase') {
    return { ...base, status: 'nobase', detail: '服务端仓库还没有任何提交（首次部署），没有可丢的东西' };
  }
  if (err === 'notarget') {
    return { ...base, status: 'notarget', detail: '远端解析不到 FETCH_HEAD（fetch 没写进去？）' };
  }

  const state = pick('DRIFT_STATE');
  if (state === 'ancestor') return { ...base, status: 'ancestor' };
  if (state === 'diverged') {
    if (!base.headShort) base.headShort = base.head.slice(0, 8);
    return { ...base, status: 'diverged', commits: commits.slice(0, 20) };
  }
  return {
    ...base,
    status: 'unknown',
    detail: text.trim().split('\n').slice(-3).join(' | ') || '探测脚本没有输出',
  };
}

/** 打印漂移检查结论（dry-run 与真实部署共用） */
function printDriftReport(drift) {
  const short = (sha) => (sha ? sha.slice(0, 8) : '?');
  if (drift.status === 'ancestor') {
    console.log(
      `  ✅ 漂移检查通过：服务端 HEAD ${short(drift.head)} 是待部署提交 ${short(drift.target)} 的祖先，无本地提交会被覆盖`
    );
    return;
  }
  if (drift.status === 'diverged') {
    console.log('  ❌ 漂移检查未通过：服务端有未进仓库的本地提交，reset 会覆盖它们');
    console.log(`     服务端 HEAD : ${drift.head || '?'}${drift.headShort ? ` (${drift.headShort})` : ''}`);
    console.log(`     待部署提交  : ${drift.target || '?'}`);
    if (drift.commits.length) {
      console.log('     将被覆盖的提交（最新在前，最多 20 条）：');
      for (const line of drift.commits) console.log(`       ${line}`);
      if (drift.commits.length >= 20) console.log('       …（还有更多，服务器上 git log --oneline 查看）');
    } else {
      console.log('     （git log 没返回内容，服务器上手工确认：git log --oneline -20）');
    }
    return;
  }
  const reason = drift.detail || '未知原因';
  if (drift.status === 'nobase') {
    console.log(`  ⚠️  跳过漂移检查：${reason}`);
    return;
  }
  console.log(`  ⚠️  跳过漂移检查（无法判定，非「无漂移」）：${reason}`);
}

async function main() {
  // --init 只生成模板：最早返回，不读配置、不 import node-ssh、不碰网络
  if (has('--init')) {
    runInit();
    return;
  }

  const cfg = loadConfig();
  const branch = cfg.branch || 'node';

  // 依赖：node-ssh 是项目依赖，直接用
  const { NodeSSH } = await import('node-ssh');

  const ssh = new NodeSSH();
  console.log(`\n▶ 连接 ${cfg.username}@${cfg.host}:${cfg.port || 22}`);
  try {
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
  } catch (err) {
    // dry-run 的价值就在于「先看将发生什么」；连不上时把跳过原因说清楚，而不是抛原始错误
    if (has('--dry-run')) {
      console.log(`  ⚠️  dry-run：连不上远端，跳过漂移检查（原因：${err?.message || err}）`);
      console.log('     因此无法预览远端命令；配置/网络修好后再跑 --dry-run');
    }
    throw err;
  }

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

    // ── 2. 远程更新代码：fetch → 漂移检测 → reset ──
    console.log('▶ 更新远端代码');
    // 不套 `| tail`：管道会把退出码变成 tail 的，fetch 失败会被当成成功
    const fetch = await remote(`cd ${appDir} && git fetch ${remoteBundle} ${branch} 2>&1`);
    if (fetch.code !== 0) fail(`远端 fetch 失败（尚未 reset，服务端代码未动）:\n${fetch.stdout}${fetch.stderr}`);
    const fetchTail = (fetch.stdout || '').trim().split('\n').filter(Boolean).slice(-3);
    for (const line of fetchTail) console.log(`  ${line}`);

    // 漂移检测：reset 前确认「服务端当前 HEAD」是否包含于「待部署提交」，否则会静默丢本地提交
    console.log('▶ 检查服务端是否有未推送的提交');
    const probe = await remote(buildDriftProbe(appDir));
    const drift = parseDriftProbe(probe.stdout);
    printDriftReport(drift);

    let backupBranch = '';
    if (drift.status === 'diverged') {
      const short = drift.headShort || drift.head.slice(0, 8);
      if (FORCE) {
        // --force：覆盖前先在服务端留一个指向原 HEAD 的备份分支
        backupBranch = `backup/predeploy-${short}`;
        const bk = await remote(
          `cd ${appDir} && git branch -f ${shq(backupBranch)} ${shq(drift.head)} 2>&1 && git rev-parse --short ${shq(backupBranch)}`
        );
        if (bk.code !== 0) {
          fail(`创建备份分支 ${backupBranch} 失败，已中止（服务端代码未动）:\n${bk.stdout}\n${bk.stderr}`);
        }
        console.log(`  ⚠️  --force：已建备份分支 ${backupBranch} → ${(bk.stdout || '').trim() || short}`);
        console.log(`     回滚：ssh ${cfg.username}@${cfg.host}${cfg.port ? ` -p ${cfg.port}` : ''} "cd ${appDir} && git reset --hard ${backupBranch}"`);
        console.log('     （部署完确认没问题，可 git branch -D 掉它）');
      } else if (has('--dry-run')) {
        console.log('  ⚠️  dry-run：真实部署会在此中止，所以不执行 reset，也不调 deploy.sh');
        console.log('     其余步骤（构建 / 重建容器 / 健康检查）在真实部署中会照常运行');
        return;
      } else {
        console.log('\n  处理建议：');
        console.log(`     1) 先上游化（推荐）：ssh ${cfg.username}@${cfg.host} 上去，`);
        console.log(`        cd ${appDir} && git log --oneline -20 看清改了什么，再 push 回仓库合并，然后重新部署`);
        console.log('     2) 确认这些提交可以丢弃：node deploy/deploy.mjs --force');
        console.log('        （--force 会先自动建 backup/predeploy-<sha> 备份分支，并打印回滚命令）');
        console.log('     3) 只想留个补丁：服务器上先 git stash 或 git format-patch 存一份，再部署');
        fail('检测到服务端本地提交，已中止部署（服务端代码未改动）');
      }
    }

    // 同样不套 `| tail`：reset 真失败（如 FETCH_HEAD 不可用）时必须能被捕获
    // dry-run 必须在 reset 之前收手：上面只做了 fetch（只写 FETCH_HEAD，不动工作树），
    // reset 会真的改服务端代码 —— 之前漏了这个早退，dry-run 把 243 的工作树改了。
    if (has('--dry-run')) {
      console.log('  ⚠️  dry-run：不执行 git reset --hard，服务端代码保持不变');
      console.log('     真实部署会在此把代码同步到 FETCH_HEAD，然后构建并重建容器');
      return;
    }
    
    const reset = await remote(`cd ${appDir} && git reset --hard FETCH_HEAD 2>&1`);
    if (reset.code !== 0) fail(`远端 reset 失败:\n${reset.stdout}${reset.stderr}`);
    const resetLine = (reset.stdout || '').trim().split('\n').filter(Boolean).pop();
    console.log(`  ✅ 已同步到 ${resetLine || 'FETCH_HEAD'}`);
    if (backupBranch) console.log(`  ℹ️  备份分支：${backupBranch}`);

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
    if (backupBranch) {
      console.log(`   服务端旧提交备份: ${backupBranch}`);
      console.log(`   要回滚本次代码更新: cd ${appDir} && git reset --hard ${backupBranch}`);
    }
  } finally {
    try { await ssh.dispose(); } catch { /* 忽略 */ }
  }
}

// 直接运行时才进 main；被 import（如 /tmp 下的验证脚本）时只导出纯函数
const invokedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n❌ ${err?.message || err}`);
    process.exit(1);
  });
}

export { buildDriftProbe, parseDriftProbe, printDriftReport, runInit, shq };
