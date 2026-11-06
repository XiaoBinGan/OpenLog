/**
 * 区块：Docker 卡片底部的「💡 连接说明」+「📖 如何查看 Docker Server 地址？」折叠文档
 *
 * 负责什么：
 *   - 纯静态文案：连接说明、SSH 模式解释、macOS / Linux / Windows 三份命令速查
 *
 * 为什么不放在父组件：
 *   这段是 140 行纯静态 JSX（含大量 {'\n'} 拼接的 <pre>），没有任何 state 依赖，
 *   也不需要任何 props。单独成文件后：(1) 它一次都不会因为 settings 变化而重渲染
 *   （React.memo + 零 props）；(2) Docker 卡片里那 300 行可变逻辑可以独立阅读。
 */
import { memo } from 'react';

function DockerHelpSection() {
  return (
    <div className="px-4 pb-3">
      <p className="text-xs text-dark-600 mb-1">💡 连接说明</p>
      <p className="text-xs text-dark-600 leading-relaxed mb-2">
        每个配置项连接的是一个 <strong className="text-dark-400">Docker Server（守护进程）</strong>，不是单个容器。
        连接成功后会自动列出该 Server 上的所有容器，无需手动添加。
        <span className="text-amber-400/90">🔐 「SSH 服务器」模式通过 SSH 通道访问远端 docker.sock，无需在远端暴露 2375（无需重启 dockerd、不影响运行中的容器），凭据复用远程服务器配置。</span>
      </p>
      <details className="group">
        <summary className="text-xs text-blue-400 cursor-pointer hover:text-blue-300 transition-colors">
          📖 如何查看 Docker Server 地址？
        </summary>
        <div className="mt-2 space-y-2 text-xs">
          <div>
            <p className="text-dark-400 font-medium">macOS（Docker Desktop）</p>
            <pre className="mt-1 px-2.5 py-1.5 bg-dark-800 rounded text-dark-300 font-mono overflow-x-auto">
              docker context ls{'\n'}
              {'#'} 默认: localhost:2375 或 unix:///var/run/docker.sock
            </pre>
          </div>
          <div>
            <p className="text-dark-400 font-medium">Linux</p>
            <pre className="mt-1 px-2.5 py-1.5 bg-dark-800 rounded text-dark-300 font-mono overflow-x-auto">
              {'# 开启 Docker Remote API（2375）\n'}
              {'\n'}
              {'## 1. 检查当前配置\n'}
              {'\n'}
              {'# 查看 Docker 服务状态：\n'}
              sudo systemctl status docker --no-pager{'\n'}
              {'# 查看 Docker 配置：\n'}
              cat /etc/docker/daemon.json{'\n'}
              {'# 查看 Runtime：\n'}
              docker info | grep -A5 Runtimes{'\n'}
              {'\n'}
              {'# 记录当前配置，确认是否存在：\n'}
              {'# - nvidia runtime\n'}
              {'# - registry-mirrors\n'}
              {'# - data-root\n'}
              {'# - insecure-registries\n'}
              {'# - 其它自定义配置\n'}
              {'\n'}
              {'## 2. 备份配置\n'}
              sudo cp /etc/docker/daemon.json {'\\'}
              {'  /etc/docker/daemon.json.bak.$(date +%F-%H%M%S)\n'}
              {'\n'}
              {'## 3. 修改 daemon.json\n'}
              {'# 编辑配置文件：\n'}
              sudo vim /etc/docker/daemon.json{'\n'}
              {'# 在保留现有配置的前提下增加：\n'}
              {'{\n'}
              {' "hosts": [\n'}
              {' "unix:///var/run/docker.sock",\n'}
              {' "tcp://0.0.0.0:2375"\n'}
              {' ]\n'}
              {'}\n'}
              {'\n'}
              {'# 例如 NVIDIA 服务器：\n'}
              {'{\n'}
              {' "hosts": [\n'}
              {' "unix:///var/run/docker.sock",\n'}
              {' "tcp://0.0.0.0:2375"\n'}
              {' ],\n'}
              {' "runtimes": {\n'}
              {' "nvidia": {\n'}
              {' "path": "nvidia-container-runtime",\n'}
              {' "args": []\n'}
              {' }\n'}
              {' }\n'}
              {'}\n'}
              {'\n'}
              {'#> 注意：不要直接覆盖整个 daemon.json，\n'}
              {'#> 否则可能导致 NVIDIA Runtime、\n'}
              {'#> 镜像加速器、数据目录等配置丢失。\n'}
              {'\n'}
              {'## 4. 如出现 hosts 冲突\n'}
              {'\n'}
              {'# 如果重启 Docker 后出现类似报错：\n'}
              {'# the following directives are specified\n'}
              {'# both as a flag and in the configuration\n'}
              {'# file: hosts\n'}
              {'\n'}
              {'# 创建 systemd Override：\n'}
              sudo mkdir -p /etc/systemd/system/docker.service.d{'\n'}
              {'\n'}
              sudo tee /etc/systemd/system/docker.service.d/override.conf {`>`} /dev/null {'<<'}EOF{'\n'}
              [Service]{'\n'}
              ExecStart={'\n'}
              ExecStart=/usr/bin/dockerd --containerd=/run/containerd/containerd.sock{'\n'}
              EOF{'\n'}
              {'\n'}
              {'## 5. 重启 Docker\n'}
              sudo systemctl daemon-reload{'\n'}
              sudo systemctl restart docker{'\n'}
              {'\n'}
              {'## 6. 验证配置\n'}
              {'# 查看 Docker 状态：\n'}
              sudo systemctl status docker --no-pager{'\n'}
              {'# 查看 2375 监听：\n'}
              sudo ss -lntp | grep 2375{'\n'}
              {'# 查看 Runtime：\n'}
              docker info | grep -A5 Runtimes{'\n'}
              {'# 验证 Docker Remote API：\n'}
              curl http://127.0.0.1:2375/version{'\n'}
              {'\n'}
              {'## 7. 远程访问 Docker\n'}
              {'# 直接指定远程 Docker：\n'}
              docker -H tcp://{'<服务器IP>'}:2375 ps{'\n'}
              {'# 或者：\n'}
              export DOCKER_HOST=tcp://{'<服务器IP>'}:2375{'\n'}
              docker ps{'\n'}
              {'\n'}
              {'## 8. 安全说明\n'}
              {'\n'}
              {'⚠️ 0.0.0.0:2375 为无认证明文接口。\n'}
              {'\n'}
              {'任何能够访问该端口的主机，都相当于\n'}
              {'拥有 Docker 主机的高权限控制能力。\n'}
              {'\n'}
              {'仅建议在可信内网环境使用：\n'}
              sudo ufw allow from 192.168.0.0/16 to any port 2375{'\n'}
              sudo ufw deny 2375{'\n'}
              {'\n'}
              {'生产环境建议：\n'}
              {' - 使用 TLS (2376) 认证\n'}
              {' - 或仅监听 127.0.0.1:2375\n'}
              {' - 通过 SSH Tunnel 进行远程访问'}
            </pre>
          </div>
          <div>
            <p className="text-dark-400 font-medium">Windows（Docker Desktop）</p>
            <pre className="mt-1 px-2.5 py-1.5 bg-dark-800 rounded text-dark-300 font-mono overflow-x-auto">
              {'#'} PowerShell 查看配置{'\n'}
              docker info | Select-String "Server Version|Operating System"{'\n'}
              {'\n'}
              {'#'} 默认: npipe:////./pipe/docker_engine{'\n'}
              {'#'} 开启 TCP: Docker Desktop → Settings → General → Expose daemon on tcp://localhost:2375
            </pre>
          </div>
        </div>
      </details>
    </div>
  );
}

export default memo(DockerHelpSection);