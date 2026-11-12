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

describe('Dockerfile —— 构建缓存不能吞掉前端产物', () => {
  const dockerfile = read('Dockerfile');

  it('CACHE_BUST 必须声明在两个阶段内（ARG 作用域不跨阶段）', () => {
    // 只有第二阶段声明时，stage1 的 `RUN npm run build` 缓存键只由 client/ 内容决定。
    // 踩过：243 连部署两次，第二次产物仍是上一版 bundle（D_DQ4OgQ），
    // 而干净重建是 EGEQfdxr。部署出去的代码和源码对不上。
    const lines = dockerfile.split('\n');
    const argStages = [];
    let stage = 0;
    for (const line of lines) {
      if (/^FROM\s/i.test(line)) stage += 1;
      if (/^ARG\s+CACHE_BUST/.test(line)) argStages.push(stage);
    }
    expect(argStages, 'CACHE_BUST 应声明在 stage 1 与 stage 2').toEqual([1, 2]);
  });

  it('前端两个 RUN 都带 cache bust 前缀', () => {
    // 光声明 ARG 不够，要在 RUN 里引用它才会进入该层的缓存键。
    const front = dockerfile.slice(0, dockerfile.indexOf('AS client-builder') + 2000);
    expect(front).toMatch(/RUN echo "Cache bust: \$\{CACHE_BUST\}" && npm install/);
    expect(front).toMatch(/RUN echo "Cache bust: \$\{CACHE_BUST\}" && npm run build/);
  });

  it('deploy.sh 传的 --build-arg 与 Dockerfile 的 ARG 同名', () => {
    // 名字对不上时 build-arg 静默失效，缓存照吃。
    expect(dockerfile).toContain('ARG CACHE_BUST');
    const deploy = read('deploy/deploy.sh');
    expect(deploy).toMatch(/docker build --build-arg CACHE_BUST=\$SHORT_SHA/);
  });
});

describe('install.sh —— 架构自检（装错架构的包）', () => {
  const install = read('deploy/install.sh');

  it('有架构归一化：uname 与 docker 的叫法要能对上', () => {
    // uname 给 x86_64 / aarch64；docker 给 amd64 / arm64。
    // 不做归一化直接比，x86 机器装 x86 包都会被判成不匹配。
    expect(install).toContain('host_arch');
    expect(install).toMatch(/x86_64\|amd64\)\s+echo amd64/);
    expect(install).toMatch(/aarch64\|arm64\|armv8\*\)\s+echo arm64/);
  });

  it('从归档里读架构走 manifest.json，不裸 grep 整个 tar 流', () => {
    // 裸 `tar -xOf f | grep` 会把 layer.tar 等二进制算进来，
    // grep 输出 "Binary file (standard input) matches" 而不是字段值。
    expect(install).toContain('archive_arch');
    expect(install).toMatch(/tar -xzOf "\$f" manifest\.json/);
    expect(install).toMatch(/"Config"/);
  });

  it('应用镜像与 PostgreSQL 镜像都要校验', () => {
    expect(install).toMatch(/check_arch "应用镜像"/);
    expect(install).toMatch(/check_arch "PostgreSQL 镜像"/);
  });

  it('导入后再用镜像元数据复核（tar 里的 json 可能不止一个）', () => {
    expect(install).toMatch(/docker image inspect "openlog:\$IMAGE_TAG" --format '\{\{\.Architecture\}\}'/);
  });

  it('有不匹配时的逃生参数，且默认拦截', () => {
    expect(install).toContain('--allow-arch-mismatch');
    expect(install).toMatch(/ALLOW_ARCH_MISMATCH=0/);   // 默认拦截，不是默认放行
  });

  it('报错文案要说清三件事：两边架构、真实症状、该换哪个包', () => {
    const msg = install.slice(install.indexOf('check_arch()'), install.indexOf('HOST_ARCH='));
    expect(msg).toContain('架构不匹配');
    expect(msg).toMatch(/本机: \$want/);
    expect(msg).toMatch(/包内: \$got/);
    expect(msg).toContain('exec format error');   // 真实症状，否则用户查不到架构上
    expect(msg).toContain('arm64');               // 对应包名提示
  });

  it('--skip-load 时不做文件级校验（镜像已就位，没有归档可读）', () => {
    expect(install).toMatch(/\[ "\$SKIP_LOAD" = "1" \] && CHECK_ARCH=0/);
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