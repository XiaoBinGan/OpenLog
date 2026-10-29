import { describe, it, expect } from 'vitest';

const { classifyCommandRisk, splitCommandSegments, tokenizeSegment } = await import('../security/command-risk.js');

const readOnly = (cmd) => {
  const r = classifyCommandRisk(cmd);
  expect(r.readonly, `应判为只读: ${cmd}（实际: ${r.reason}）`).toBe(true);
};
const needsConfirm = (cmd) => {
  const r = classifyCommandRisk(cmd);
  expect(r.readonly, `应需要确认: ${cmd}`).toBe(false);
};

describe('classifyCommandRisk — 只读命令免确认（真实用户反馈里的命令）', () => {
  it('用户实际遇到的这些查询命令都应免确认', () => {
    const realCommands = [
      `nginx -T 2>/dev/null | grep -n -A6 'location' | head -60; echo '--- html dir ---'; ls -la /usr/share/nginx/html`,
      `nginx -T | sed -n '1,200p'`,
      `ls -la /usr/share/nginx/html; curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1/`,
      'cat /etc/nginx/conf.d/default.conf',
      'ls -l /usr/share/nginx/html',
      `grep -rn "metrics" /app/server 2>/dev/null | head -20`,
      'ps -w',
      'grep -rn metrics server/index.js | head -20',
      'grep -rn metrics server',
      'ps -o pid,comm',
      'grep -rn worker_processes /etc/nginx/nginx.conf',
      `sed -n '435,470p' server/gpu-mfu.js`,
      `nproc; echo '--- nginx workers on host ---'; ps -e | grep -c nginx`,
      `sed -n '380,435p' server/gpu-mfu.js`,
      'ls server; grep -rn oomKilled server | head -20',
      `docker stats --no-stream 2>/dev/null | grep -E 'openlog-site|NAME'; echo '--- nginx mem total ---'; ps -o rss,comm -C nginx | awk '{s+=$1} END {print s/1024 " MB"}'`,
    ];
    for (const cmd of realCommands) readOnly(cmd);
  });

  it('常见只读命令', () => {
    for (const cmd of [
      'ls -la', 'cat /etc/hosts', 'head -20 app.log', 'tail -n 100 app.log',
      'wc -l server/index.js', 'du -sh /var/log', 'df -h', 'free -m',
      'uname -a', 'hostname', 'whoami', 'id', 'uptime',
      'ss -tlnp', 'netstat -an', 'ping -c 2 127.0.0.1',
      'systemctl status nginx', 'systemctl is-active docker',
      'journalctl -u nginx -n 50 --no-pager',
      'docker ps -a', 'docker logs --tail 50 openlog', 'docker inspect openlog',
      'docker images', 'docker stats --no-stream', 'docker system df',
      'git status', 'git log --oneline -5', 'git diff HEAD~1', 'git show HEAD',
      'git branch -a', 'git remote -v', 'git rev-parse HEAD',
      'nvidia-smi', 'nproc', 'lscpu', 'lsblk', 'lsof -i :3001',
      'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/',
      'curl -s http://127.0.0.1:8899/v1/models',
      'jq . package.json', 'sort -u names.txt', 'uniq -c sorted.txt',
      'find /var/log -name "*.log" -type f',
      'timeout 10 curl -s http://x/',
      'true && ls', 'ls || echo none',
    ]) readOnly(cmd);
  });

  it('非只读命令要确认', () => {
    for (const cmd of [
      'rm -rf /tmp/x', 'rm file.txt', 'mv a b', 'cp a b', 'mkdir -p /opt/x',
      'touch /tmp/x', 'tee /etc/hosts', 'dd if=/dev/zero of=/dev/sda',
      `sed -i 's/a/b/' app.js`, `sed --in-place 's/a/b/' app.js`,
      'find / -delete', 'find / -name x -exec rm {} +', 'find / -fprint out.txt',
      `awk 'BEGIN{system("id")}'`, `awk '{print $1 > "/tmp/x"}'`,
      'sort -o out.txt in.txt', 'uniq in.txt out.txt',
      'echo hi > /etc/hosts', 'echo hi >> /tmp/log', 'cmd 2>/tmp/err',
      'docker restart openlog', 'docker exec openlog sh -c "rm -rf /app/data"',
      'docker stop openlog', 'docker rm openlog', 'docker compose down',
      'systemctl restart nginx', 'systemctl stop docker', 'service nginx restart',
      'nginx -s reload',
      'curl -X POST http://127.0.0.1/api', 'curl -d "a=1" http://x/',
      'curl -o /tmp/out.html http://x/', 'curl -O http://x/a.tar.gz',
      'bash -c "ls"', 'sh -c "rm -rf /"', 'python3 script.py', 'node app.js',
      'npm install', 'kill 1234', 'killall nginx', 'pkill node',
      'tail -f /var/log/app.log', 'date -s "2026-01-01"', 'hostname new-name',
      'dmesg -C', 'journalctl --vacuum-time=1d', 'sysctl -w net.ipv4.ip_forward=1',
      'git checkout .', 'git reset --hard HEAD~1', 'git clean -fd',
      'git push', 'git commit -m x', 'git tag -d v1', 'git config user.name x',
      'sudo ls', 'su -c "ls"', 'ls | xargs rm',
      'echo $(rm -rf /)', 'echo `rm -rf /`',
      'nvidia-smi -r', 'mount /dev/sdb1 /mnt',
    ]) needsConfirm(cmd);
  });

  it('空命令 / 超长命令按需要确认处理', () => {
    needsConfirm('');
    needsConfirm('   ');
    needsConfirm('ls ' + 'a'.repeat(5000));
  });

  it('管道里只要有一段不是只读就整体要求确认', () => {
    needsConfirm('cat app.log | xargs rm');
    needsConfirm('ls && rm -rf /tmp');
    needsConfirm('grep x app.log; sed -i s/a/b/ app.log');
  });

  it('引号里的分号/管道不拆段', () => {
    expect(splitCommandSegments(`echo 'a;b|c'`)).toEqual([`echo 'a;b|c'`]);
    expect(splitCommandSegments('ls; pwd')).toEqual(['ls', 'pwd']);
    expect(splitCommandSegments('a && b || c | d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('分词保留引号内空格', () => {
    expect(tokenizeSegment(`grep -n "hello world" app.log`)).toEqual(['grep', '-n', 'hello world', 'app.log']);
  });

  it('重定向到 /dev/null 不算写文件（真实命令里非常常见）', () => {
    readOnly('grep -rn err /var/log 2>/dev/null | head -10');
    readOnly('ls -la > /dev/null 2>&1');
    readOnly('docker ps --format "{{.Names}}" 2>/dev/null');
  });
});
