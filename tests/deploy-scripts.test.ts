import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 部署脚本的回归守卫。
 *
 * 这些 bug 全部是在真实目标机（4卡T4，Docker 29.1.2）上实测暴露的，
 * 不是假想场景 —— 每个用例对应一次实际失败。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('deploy.sh —— 容器/镜像不能混查', () => {
  const deploy = read('deploy/deploy.sh');

  it('所有 docker inspect 都带 --type container（否则容器不存在时会去查同名镜像）', () => {
    // 事故：首次部署时镜像已 load、容器还没建，`docker inspect openlog` 命中了
    // openlog:latest 这个镜像，模板 {{.Image}} 报 “map has no entry for key Image”，
    // 在 set -e 下直接打死脚本 —— 表现为「部署失败」但容器根本没起来。
    const lines = deploy.split('\n').filter(l => l.includes('docker inspect'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `未带 --type container: ${line.trim()}`).toContain('--type container');
    }
  });

  it('取不到上一个镜像时不致命（首次部署本来就没有）', () => {
    expect(deploy).toMatch(/docker inspect --type container "\$CONTAINER_NAME" --format '\{\{\.Image\}\}'[^\n]*\|\| true/);
  });

  it('健康检查不硬依赖 curl（curl → wget → 容器内 node）', () => {
    expect(deploy).toContain('http_code()');
    expect(deploy).toContain('http_get()');
    expect(deploy).toMatch(/wh?i?c?h?e?n?|command -v curl/);
    expect(deploy).toContain('docker exec "$CONTAINER_NAME" node -e');
  });

  it('http_get 的第二参数可选（set -u 下 $2 会 unbound variable）', () => {
    expect(deploy).toContain('local auth="${2:-}"');
  });
});

describe('install.sh —— 一键部署的健壮性', () => {
  const install = read('deploy/install.sh');

  it('显式参数必须生效（曾静默沿用旧 deploy.env，把新实例建到旧端口上）', () => {
    expect(install).toContain('EXPLICIT_CONFIG');
    for (const flag of ['--port', '--data-dir', '--container-name', '--with-postgres', '--db-url']) {
      const line = install.split('\n').find(l => l.trim().startsWith(flag + ')'));
      expect(line, `${flag} 未置 EXPLICIT_CONFIG`).toContain('EXPLICIT_CONFIG=1');
    }
  });

  it('多实例各有独立配置文件（--env-file，并传给 deploy.sh）', () => {
    expect(install).toContain('--env-file');
    expect(install).toContain('ENV_FILE_OVERRIDE');
    expect(install).toContain('DEPLOY_ENV_FILE="$ENV_FILE"');
  });

  it('PostgreSQL：包内归档优先，其次 docker pull，最后给三条明确出路', () => {
    expect(install).toContain('postgres-*.tar.gz');   // 包内归档
    expect(install).toMatch(/docker pull "\$PG_IMAGE"/); // 有外网时兜底
    expect(install).toMatch(/离线环境/);              // 失败时的指引
  });

  it('旧 Docker 会提示没有 docker compose 但继续（脚本本身不需要 compose）', () => {
    expect(install).toContain('DOCKER_VER');
    expect(install).toMatch(/不需要 compose/);
    // 提示文案里不能出现裸反引号（双引号内会被 shell 当命令执行）
    const hint = install.split('\n').find(l => l.includes('没有 docker compose 子命令'));
    expect(hint).toBeTruthy();
    expect(hint).not.toContain('`');
  });

  it('失败时区分「启动前失败」与「回滚过」（原提示一律说已回滚，误导排查）', () => {
    expect(install).toMatch(/并没有发生回滚/);
  });
});

describe('离线 compose 文件', () => {
  it('用格式 2.4（v1 与 v2 都认，且支持 depends_on.condition）', () => {
    const compose = read('deploy/docker-compose.offline.yml');
    expect(compose).toMatch(/^version: "2\.4"$/m);
    expect(compose).toContain('condition: service_healthy');
  });

  it('用已导入的镜像，不 build（目标机没有源码）', () => {
    const compose = read('deploy/docker-compose.offline.yml');
    expect(compose).toContain('image: ${OPENLOG_IMAGE:-openlog:latest}');
    expect(compose).not.toMatch(/^\s*build:/m);
  });
});