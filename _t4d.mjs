import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NodeSSH } from "node-ssh";
const SHA = process.argv[2], FALLBACK = process.argv[3];
const REPO = "D:\\project\\openlog", DIR = path.join(REPO, "_t4ctx");
const REMOTE_DIR = `/tmp/openlog-ctx-${SHA}`, REMOTE_TAR = `/tmp/openlog-ctx-${SHA}.tar.gz`;
const DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
ARG CACHE_BUST=1
RUN echo "Cache bust: \${CACHE_BUST}" && apk add --no-cache python3 make g++ openssh sshpass
COPY package*.json ./
COPY scripts/ensure-sqlite-binding.js ./scripts/
RUN echo "Cache bust: \${CACHE_BUST}" && npm install --omit=dev --legacy-peer-deps --no-audit --no-fund && npm rebuild better-sqlite3
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY client/dist ./client/dist
RUN rm -rf /root/.npm
ENV NODE_ENV=production
ENV PORT=3011
ENV HOST=0.0.0.0
EXPOSE 3011
VOLUME ["/app/data", "/app/logs"]
CMD ["node", "server/index.js"]
`;
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, "Dockerfile"), DOCKERFILE, "utf8");
for (const f of ["package.json", "package-lock.json"]) if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), path.join(DIR, f));
for (const d of ["scripts", "server"]) fs.cpSync(path.join(REPO, d), path.join(DIR, d), { recursive: true });
fs.mkdirSync(path.join(DIR, "client"), { recursive: true });
fs.cpSync(path.join(REPO, "client", "dist"), path.join(DIR, "client", "dist"), { recursive: true });
const TAR = path.join(REPO, `_t4c-${SHA}.tar.gz`);
fs.rmSync(TAR, { force: true });
execFileSync("C:\\Windows\\System32\\tar.exe", ["-czf", TAR, "-C", DIR, "."], { cwd: REPO, stdio: "pipe" });
const ssh = new NodeSSH();
await ssh.connect({ host: "100.100.142.179", port: 22, username: "smai", password: "smai123", readyTimeout: 25000, keepaliveInterval: 10000 });
const run = async (c, t = 900000) => { const r = await ssh.execCommand(c, { execTimeout: t }); return { code: r.code, out: ((r.stdout||"")+(r.stderr||"")).trim() }; };
const start = (img) => `docker run -d --name openlog --network host --restart unless-stopped -e NODE_ENV=production -e PORT=3001 -e HOST=0.0.0.0 -e OPENLOG_ENABLE_CONTAINER_EXEC=1 -v /tmp/oldep/data:/app/data -v openlog-logs:/app/logs ${img} >/dev/null`;
try {
  await ssh.putFile(TAR, REMOTE_TAR);
  fs.rmSync(TAR, { force: true }); fs.rmSync(DIR, { recursive: true, force: true });
  let r = await run(`rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR} && tar xzf ${REMOTE_TAR} -C ${REMOTE_DIR} && echo unpacked`);
  console.log("解包:", r.out);
  r = await run(`cd ${REMOTE_DIR} && docker build --pull=false --build-arg CACHE_BUST=7b3b3de8 -t openlog:${SHA} . 2>&1 | tail -5`);
  console.log(r.out);
  if (!/DONE/.test(r.out) && /ERROR|error:/.test(r.out)) throw new Error("构建失败");
  r = await run(`docker tag openlog:${SHA} openlog:latest
mkdir -p /tmp/oldep/backups && cp /tmp/oldep/data/openlog.db /tmp/oldep/backups/openlog-sqlite-$(date +%Y%m%d-%H%M%S).db 2>/dev/null || true
docker rm -f openlog >/dev/null 2>&1 || true
${start(`openlog:${SHA}`)}
sleep 10
docker ps --filter name=openlog --format '{{.Image}} | {{.Status}}'`);
  console.log("容器:", r.out);
  r = await run(`c=000
for i in $(seq 1 25); do c=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3001/ 2>/dev/null || echo 000); [ "$c" = 200 ] && break; sleep 3; done
echo "首页=$c"
if [ "$c" != 200 ]; then docker rm -f openlog >/dev/null 2>&1; ${start(FALLBACK)}; sleep 6; curl -s -o /dev/null -w '回滚 %{http_code}\\n' -m 5 http://127.0.0.1:3001/; exit 1; fi`);
  console.log(r.out);
  if (r.code !== 0) throw new Error("健康检查失败");
  console.log(`\n✅ 4卡T4 openlog:${SHA}`);
} finally {
  await run(`rm -rf ${REMOTE_DIR} ${REMOTE_TAR} >/dev/null 2>&1 || true`);
  await ssh.dispose();
}
