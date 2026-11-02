/**
 * server/__tests__/deploy-scripts.test.js
 *
 * 部署脚本的回归保护（纯源码扫描，不需要 docker）。
 *
 * 真实踩过的坑：
 *   1. install.sh 只检查「运行中的」openlog-pg，容器停了就当成没有 → 重新生成密码
 *      + 复用老数据卷 → 应用侧 "password authentication failed for user openlog"
 *      （部署「成功」启动、健康检查失败、且首次部署没有回滚点）。
 *   2. save-image.sh 清理旧归档用 *.tar.gz，把 postgres-16-alpine.tar.gz 一起删了。
 *   3. deploy.sh 不打印访问令牌，每次都要登服务器翻 data/.auth_token。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('install.sh —— PostgreSQL 密码复用', () => {
  const src = read('deploy/install.sh');

  it('必须用 docker inspect 判断容器是否存在（含已停止），不能只看 docker ps', () => {
    expect(src).toContain('docker inspect --type container "$PG_CONTAINER"');
    expect(src).not.toMatch(/docker ps --filter "name=\^\$PG_CONTAINER\$"[^\n]*\n\s*if/);
  });

  it('存在旧容器时复用它的 POSTGRES_PASSWORD，而不是重新生成', () => {
    expect(src).toContain('POSTGRES_PASSWORD=//p');
    expect(src).toContain('复用已有 $PG_CONTAINER 容器的密码');
  });

  it('复用后必须用真实 TCP 连接验证密码（env 里的密码不一定等于卷里的密码）', () => {
    expect(src).toContain('pg_auth_ok');
    expect(src).toContain("psql -h 127.0.0.1 -U openlog -d openlog -c 'select 1'");
    expect(src).toMatch(/pg_auth_ok "\$PG_CONTAINER" "\$EXISTING_PW"/);
    expect(src).toMatch(/pg_auth_ok "\$PG_CONTAINER" "\$PG_PASSWORD"/);
  });

  it('数据卷有数据但没有容器时，给出可操作的三条出路（不静默重建）', () => {
    expect(src).toContain('数据卷 $PG_VOLUME 里已有 PostgreSQL 数据');
    expect(src).toContain('--db-url');
    expect(src).toContain('docker volume rm $PG_VOLUME');
  });
});

describe('save-image.sh —— 清理只针对应用镜像', () => {
  const src = read('deploy/scripts/save-image.sh');

  it('清理旧归档只匹配 openlog-*.tar.gz（别删掉 postgres 镜像归档）', () => {
    expect(src).toContain('"$IMAGES_DIR"/openlog-*.tar.gz');
    expect(src).not.toMatch(/"\$IMAGES_DIR"\/\*\.tar\.gz/);
  });
});

describe('deploy.sh —— 部署结果必须能直接登录', () => {
  const src = read('deploy/deploy.sh');

  it('结束处打印访问令牌（来源：OPENLOG_TOKEN > data/.auth_token > 容器内）', () => {
    expect(src).toContain('访问令牌:');
    expect(src).toContain('OPENLOG_TOKEN');
    expect(src).toContain('/app/data/.auth_token');
  });

  it('健康检查失败时把数据库认证失败翻译成可操作的提示', () => {
    expect(src).toContain('password authentication failed');
    expect(src).toContain('--db-url');
  });

  it('令牌不写进 .last-deploy.json（状态文件会被备份/同步）', () => {
    const stateBlock = src.slice(src.indexOf('cat > "$STATE_FILE"'), src.indexOf('# ─── 8.'));
    expect(stateBlock).not.toContain('TOKEN');
  });
});

describe('install.sh / deploy.sh —— 基础健全性', () => {
  it('两个脚本都有 set -euo pipefail', () => {
    expect(read('deploy/install.sh')).toContain('set -euo pipefail');
    expect(read('deploy/deploy.sh')).toContain('set -euo pipefail');
  });

  it('install.sh 会校验 SHA256SUMS（离线包完整性）', () => {
    expect(read('deploy/install.sh')).toContain('SHA256SUMS');
  });
});
