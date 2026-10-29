# OpenLog

🤖 AI-powered log analysis & monitoring platform for GPU fleets and Docker hosts

**[[English](README.md)] | [[简体中文](README.zh-CN.md)]**

> This is the primary (English) README. The Chinese translation lives in
> [README.zh-CN.md](README.zh-CN.md); if the two ever disagree, this file wins.

---

## 📑 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
  - [Prerequisites](#prerequisites) · [Installation](#installation) · [Configuration](#configuration)
  - [Supported inference engines](#supported-inference-engines-vllm--sglang--strata--ollama)
  - [Access token](#-access-token) · [Running](#running) · [Windows](#windows-quick-start)
  - [Production (single port)](#production-single-port) · [One-command deploy](#-one-command-deploy)
  - [Database](#-database) · [Remote access & token](#-remote-access--token)
- [Dev & Quality Gates](#-dev--quality-gates)
- [Page Navigation](#-page-navigation)
- [Project Structure](#-project-structure)
- [Recent Changes](#-recent-changes)
- [Tech Stack](#-tech-stack)
- [Core Features](#-core-features)
  - Remote server management · Scale & performance (1,000 servers) · Ops assistant · AI Shell
  - Skills · GPU monitoring · How MFU is computed · Integrating a custom inference service
  - Alert rules · Container log alerts · Docker live logs · In-container exec
- [API Reference](#-api-reference)
- [License](#-license)

---

## ✨ Features

| Feature | What it does |
|---------|--------------|
| 📊 Real-time dashboard | CPU / memory / disk / GPU / processes at a glance |
| 🎮 Multi-server GPU monitoring | Utilization, VRAM, temperature and **MFU** across the fleet |
| 📝 Live log streaming | WebSocket tail with level colors, pause/resume, search |
| 🤖 AI analysis | LLM-driven log analysis, container patrol, health diagnosis |
| 💬 Ops assistant | Agent that **locates → reads code → edits → verifies** on SSH hosts |
| 🧠 AI Shell | Natural language → multi-step shell agent with risk gating |
| 🩺 Inference-engine compatibility | vLLM / SGLang / Strata / Ollama — auto tool-calling fallback |
| 🔍 Container log alerts | Multi-format level parsing + in-page popups |
| 📈 GPU MFU | Per-card MFU, engine-agnostic (vLLM / SGLang / Strata / TGI / custom) |
| 🔧 Skills | Markdown skill specs, import/export, usable by assistant & AI Shell |
| 🔔 Alert rules | Keyword/level rules + webhook notifications with cooldown |
| 🐳 Docker management | Containers, live logs, upstream/downstream topology, exec |
| 🖥️ Remote servers | SSH pool, file browser, PTY terminal, auto-reconnect |
| 📜 Analysis history | Browse and revisit past analyses |
| ⚙️ Flexible configuration | vLLM/SGLang presets, DB backends, scale knobs |

---

## 🚀 Quick Start

### Prerequisites

- Node.js **22.22+** (required by the `jsdom 30` dependency chain; see `.nvmrc`)
- npm
- An OpenAI-compatible model endpoint (local vLLM/SGLang/Strata/Ollama or a cloud API)

### Installation

```bash
git clone https://github.com/XiaoBinGan/OpenLog.git
cd OpenLog
npm install
cd client && npm install && cd ..
```

### Configuration

```bash
cp .env.example .env
# Edit .env. At minimum set OPENLOG_TOKEN (required in production mode).
```

> ⚠️ The server binds `127.0.0.1:3011` by default. To reach it from another machine you
> **must** set `HOST=0.0.0.0`, provide `OPENLOG_TOKEN`, and add your origin to
> `OPENLOG_ALLOWED_ORIGINS`. Every variable is documented inline in `.env.example`.

Model API keys are configured in the **Settings page** and persisted in the database;
`OPENAI_API_KEY` in `.env` is only used as the initial default while the DB has no config yet.

#### Supported inference engines (vLLM / SGLang / Strata / Ollama)

The Settings page accepts any **OpenAI-compatible** endpoint — just get the Base URL right:

| Engine | Base URL example | Native function calling |
|---|---|---|
| vLLM | `http://127.0.0.1:8000/v1` | Requires `--enable-auto-tool-choice --tool-call-parser hermes` (or the parser matching your model) |
| SGLang | `http://127.0.0.1:30000/v1` | Requires `--tool-call-parser qwen25` (or matching parser) |
| Strata | `http://127.0.0.1:8899/v1` | Supported |
| Ollama | `http://localhost:11434/v1` | Depends on model (qwen3 / llama3.1+ support it) |
| OpenAI-compatible cloud | each vendor's `/v1` | Supported |

**It works even without native tool calling.** Both failure modes are handled:

1. The engine **errors out** (e.g. vLLM's `400 tools is not supported`).
2. The engine **silently ignores** `tools` — the real behaviour of vLLM / SGLang when
   `--tool-call-parser` is missing: no error, but the model just replies with prose like
   "I need to call remote_ls…" and executes nothing.

Both cases fall back automatically to a **text protocol** (`TOOL_CALL: {...}` / `FINAL:`).
Agent capabilities (read code, edit config, run commands, confirmation gate, audit) are all
preserved — only the dispatch mechanism changes. The downgrade decision is cached for 30
minutes and the UI shows a `provider_notice`, so it is not retried on every round.

The "Refresh list" button in Settings works for every engine above (it calls `/v1/models`,
falling back to Ollama's `/api/tags`). `GET /api/chat/provider` reports the detected engine
and hints on how to enable native tools.

> 🔐 `OPENLOG_SECRET_KEY` is the encryption key for stored SSH passwords / model keys.
> Going from "unset" to "set" triggers a one-time (one-way) data migration — **never** unset it
> afterwards, or previously re-encrypted credentials become unreadable. Generate one (32 bytes):
>
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 🔑 Access Token

The server authenticates with `OPENLOG_TOKEN` (mandatory in production — see "Scope" below).
**The token is the master key to the console**: it can drive SSH, Docker and remote execution
APIs, so keep it secret.

#### 1. Generate

Node's built-in `crypto` is enough — 24 random bytes, 48 hex chars, same format the server
generates automatically:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
# Example output: 3f9c2a... (48 hex chars)
```

Put it into `.env` (after `cp .env.example .env`):

```bash
OPENLOG_TOKEN=3f9c2a...   # your generated value
```

For containers / Compose pass it as an environment variable (**never** bake it into the image):

```bash
# docker run
docker run -d ... -e OPENLOG_TOKEN=<your-token> openlog:latest

# docker compose (the compose file declares OPENLOG_TOKEN as required)
OPENLOG_TOKEN=<your-token> docker compose up -d
```

#### 2. Default behaviour when unset

**It works without `OPENLOG_TOKEN`** — the server generates and persists one:

1. On first start it creates a 24-byte random token in `data/.auth_token` (mode `0600`, gitignored).
2. Subsequent starts **reuse that file**; the token stays stable (in containers it lives on the
   `data/` volume, so recreating the container does not change it).
3. Precedence: `OPENLOG_TOKEN` env var **>** `data/.auth_token` **>** auto-generate.
4. Deleting `data/.auth_token` and restarting generates a **new** token; the old one stops
   working immediately (browsers holding the old token fall back to the token prompt).

Read the currently effective token:

```bash
cat data/.auth_token                              # bare metal
docker exec openlog cat /app/data/.auth_token     # container (volume mounted at /app/data)
```

> If `OPENLOG_TOKEN` is set, it wins — `data/.auth_token` may not exist or may be stale.
> Don't guess from the file in that case.

#### 3. Scope & usage

| Scenario | Token required |
|---|---|
| `NODE_ENV=production` (container default) | **All** `/api` and `/ws` requests |
| Dev mode from loopback (`127.0.0.1` / `::1`) | No (local debugging) |
| Dev mode from another host | Yes |

- HTTP: `Authorization: Bearer <token>`
- WebSocket: `ws://host:port/ws?token=<token>`
- When a browser on another machine hits a production instance, an `AuthGate` dialog asks for the
  token once and stores it in `localStorage`; rotating the token prompts again.

#### 4. Rotate

Pick either, then restart the server — every browser will ask for the token again:

```bash
# Option A: change the env var (recommended; independent of the data dir)
OPENLOG_TOKEN=<new-token> node server/index.js

# Option B: delete the file and let it regenerate
rm -f data/.auth_token && node server/index.js
```

> Security: never commit `.env`, never paste the token into URLs / screenshots / chat logs.
> In production use a Compose `.env`, a Docker secret, or your platform's secret manager.

### Running

```bash
# Terminal 1 — server
nvm use 22
node server/index.js

# Terminal 2 — client
cd client && npm run dev -- --port 5173 --host
```

Visit http://localhost:5173

### Windows Quick Start

On Windows the PowerShell wrapper for npm (`npm.ps1`) is often blocked by the execution
policy — use `npm.cmd` instead. Also, Windows has no filesystem unix sockets, so the
Docker-over-SSH bridge automatically switches to a named pipe (`\\.\pipe\...`, built in,
no configuration needed).

```powershell
cd D:\project\openlog
copy .env.example .env
npm.cmd install
npm.cmd install --prefix client

# Terminal 1
node server/index.js
# Terminal 2
cd client; npm.cmd run dev -- --port 5173 --host
```

### Production (single port)

With `NODE_ENV=production` the backend serves `client/dist` directly, so only one port is needed:

```bash
npm ci --no-audit --no-fund
npm run build
OPENLOG_TOKEN=<your-token> NODE_ENV=production HOST=0.0.0.0 node server/index.js   # POSIX
```

```powershell
# Windows: npm.cmd start (cross-platform, implies NODE_ENV=production)
$env:OPENLOG_TOKEN = '<your-token>'
npm.cmd start
```

Production enforces auth: every `/api` and `/ws` request must carry `OPENLOG_TOKEN`
(`scripts/start-prod.js` defaults `NODE_ENV` to `production`).

#### 📦 One-command deploy

Two shapes — pick by scenario.

**A. Greenfield machine (app + PostgreSQL)**

```bash
cp deploy/deploy.env.example .env    # fill OPENLOG_TOKEN / POSTGRES_PASSWORD
docker compose up -d --build
```

`docker-compose.yml` ships a PostgreSQL service with health checks; it is ready once up.

**B. Updating an existing instance (recommended for production)** — one command with backup,
health check and automatic rollback on failure:

```bash
# On your dev machine: fill deploy/.deploy.json (host/credentials, gitignored)
cp deploy/deploy.config.example.json deploy/.deploy.json
npm run deploy
```

It performs the whole chain and never leaves a half-applied state:

1. Create a git bundle (servers often can't reach GitHub) → SFTP upload
2. Remote `git fetch` + `reset --hard`
3. Run `deploy/deploy.sh` on the server:
   - **Back up the database** (PG → `pg_dump`, SQLite → online backup; keeps the last 10)
   - Build the image, tag both `openlog:<commit>` and `openlog:latest`
   - Start the container with all config from `deploy/deploy.env` (no more long `-e` lists)
   - **Health check**: HTTP 200 plus `/api/db/info` `ok:true`, up to 90s
   - **Automatic rollback** to the previous image and restore service on failure
   - Prune old images (keeps the last N)

```bash
npm run deploy -- --dry-run      # print the actions, touch nothing
npm run deploy -- --no-build     # sync code + restart only (after editing deploy.env)
npm run deploy -- --skip-backup  # skip the DB backup
npm run deploy:logs              # just show status / deploy record / recent logs
npm run deploy:image:save        # archive the current image (offline deploy / long-term rollback)
```

Server-side config lives in `deploy/deploy.env` (contains the DB password, gitignored):

```bash
APP_PORT=3001
DATA_DIR=/workspace/Openlog-new/data
LOGS_VOLUME=openlog-logs
NETWORK_MODE=host
OPENLOG_DB_TYPE=postgres
OPENLOG_DATABASE_URL=postgres://openlog:password@127.0.0.1:5432/openlog
OPENLOG_ENABLE_CONTAINER_EXEC=1
```

Or run it directly on the server (no SSH involved):

```bash
cd /workspace/Openlog-new && bash deploy/deploy.sh
```

The deploy record is written to `backups/.last-deploy.json` (timestamp / commit / image /
previous image, used for rollback).

> Prepare `deploy/deploy.env` once on the server; after that every code change is just
> `npm run deploy`.
> Full runbook (first deploy / image archiving / backup & restore / rollback / troubleshooting):
> **[deploy/MANUAL.md](deploy/MANUAL.md)**

#### 🗄 Database

Default is **SQLite** (`data/openlog.db`, WAL + `synchronous=NORMAL` + `busy_timeout=5s`) —
zero config, fine for a single node. For scale or multi-instance sharing switch to
**PostgreSQL** (recommended) or **MySQL**; both use a **connection pool**:

```bash
# PostgreSQL (pool size defaults to 10)
OPENLOG_DB_TYPE=postgres
OPENLOG_DATABASE_URL=postgres://openlog:password@127.0.0.1:5432/openlog
OPENLOG_PG_POOL_MAX=10

# Or split fields: OPENLOG_PG_HOST / PORT / USER / PASSWORD / DATABASE
# MySQL: OPENLOG_DB_TYPE=mysql + OPENLOG_DATABASE_URL=mysql://...
```

Behaviour notes:

- If a database is **explicitly configured but unreachable, startup fails loudly** — there is no
  silent fallback to local SQLite (otherwise production data would be written somewhere nobody
  looks at).
- SQL uses `?` placeholders; PostgreSQL is translated to `$1, $2, …` in the adapter, so business
  code stays dialect-agnostic.
- DDL is generated per dialect: timestamps are `BIGINT` on PG/MySQL (SQLite's 32-bit `INTEGER`
  overflows in 2038), PG JSON columns are `JSONB`, MySQL primary keys are `VARCHAR` (TEXT can't
  be a PK).
- `kv_store` (settings, GPU config, audit …) is **loaded fully into memory at startup**; reads
  hit memory, writes persist asynchronously — this keeps `getKv()` synchronous, which is what
  made it work under async adapters (and is the root cause of the earlier "all PG settings are
  undefined" bug).
- Migration tool:

```bash
OPENLOG_DB_TYPE=postgres \
OPENLOG_DATABASE_URL=postgres://openlog:password@127.0.0.1:5432/openlog \
  node scripts/migrate-sqlite-to-pg.mjs
```

Idempotent (skips PK conflicts), supports `--dry-run` to preview row counts; it only copies data
and leaves the SQLite file untouched (useful for rollback).
⚠️ SSH passwords are stored encrypted — migration and runtime must use the **same**
`OPENLOG_SECRET_KEY`, otherwise the passwords can't be decrypted.

> Measured on PostgreSQL at 1,000 servers: bulk insert of 1,000 rows 674ms (batches of 100),
> read-back 86ms, 50 concurrent queries 1ms (pooled); `log_records` and lookups use
> `machine_id` / `timestamp` indexes.

**Health check**: `GET /api/db/info` (token required) returns backend type, pool occupancy, probe
latency and storage usage:

```json
{
  "type": "postgres", "dialect": "postgresql", "ready": true, "ok": true,
  "latencyMs": 2,
  "pool": { "total": 1, "idle": 1, "waiting": 0, "max": 10 },
  "database": "openlog",
  "storage": { "kind": "database", "bytes": 8454144 },
  "timestamp": "2026-10-29T00:24:11.000Z"
}
```

A persistently positive `waiting` means the pool is saturated — raise `OPENLOG_PG_POOL_MAX`.
`?counts=1` also returns key table row counts (large tables use dialect estimates: PG
`pg_class.reltuples`, MySQL `information_schema`; no full table scans). The endpoint never
returns usernames, passwords or the connection string.

#### 🔐 Remote access & token

`GET /api/auth/token` only answers **loopback** callers (everything else gets 403), so a browser
on another machine can't fetch the token automatically — it shows the "token required" gate:

- The token comes from `data/.auth_token` (auto-generated on first start; in containers that's the
  file on the data volume). If `OPENLOG_TOKEN` is set, it wins. See
  [Access Token](#-access-token) for generation and defaults.
- Entered once, it is stored in the browser's `localStorage` (this machine only).
  Rotating the token prompts again.
- To reset locally: run `localStorage.removeItem('openlog_token')` in DevTools and refresh.
  (Chrome asks you to type "allow pasting" the first time — that's the browser's anti-XSS
  protection, not this project. The normal flow doesn't need the console; just type the token
  into the page.)

---

## 🧪 Dev & Quality Gates

```bash
npm test              # unit + integration (~680 cases, incl. security regressions)
npm run test:coverage # with coverage
npm run lint          # server ESLint
npm run lint:client   # client ESLint (React + TS)
npm run lint:all      # both
npm run build         # tsc -b && vite build
```

CI (`.github/workflows/ci.yml`) runs install → lint (both sides) → build → test on push/PR to
`node` / `main`, with a **matrix over ubuntu-latest and windows-latest** (Docker-over-SSH bridge
and path-separator differences only surface on Windows, so CI must cover it).

> ⚠️ **Test isolation**: tests spawn a real server subprocess. Without `OPENLOG_DATA_DIR` it would
> read/write the project's `data/openlog.db`, `settings.json` and `remote-servers.json`.
> `vitest.config.js` already points them at `openlog-vitest` under the OS temp dir (cross-platform,
> no hardcoded `/tmp`). When running the server manually, don't point it at production data.

---

## 🧭 Page Navigation

| Page | Path | What it does |
|------|------|--------------|
| System monitor | `/monitor` | CPU, memory, disk, GPU, processes |
| GPU monitor | `/gpu` | Fleet-wide GPU overview (util / VRAM / temp / processes / MFU) |
| Dashboard | `/dashboard` | Summary panel |
| Live logs | `/logs` | Real-time logs, level filters, search |
| Remote servers | `/remote` | SSH connections, file browser, terminal, AI Shell |
| Docker | `/docker` | Container management, live logs, upstream/downstream topology |
| AI analysis | `/analytics` | Log analysis, container patrol, health diagnosis |
| Analysis history | `/analysis-history` | Browse past analyses |
| Ops assistant | `/assistant` | Agent: locate issues, edit code/config, run & verify (writes need confirmation, audited) |
| Skills | `/skills` | Skill CRUD, import/export, standard format |
| Settings | `/settings` | Model config (vLLM/SGLang/Strata/Ollama), alert rules, container patrol |

---

## 📁 Project Structure

```
openlog/
├── client/                       # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── AIShellTerminal.tsx   # AI Shell terminal
│   │   │   ├── Layout.tsx            # layout + navigation
│   │   │   └── ...
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx         # dashboard
│   │   │   ├── GPU.tsx               # GPU monitoring
│   │   │   ├── Logs.tsx              # live logs
│   │   │   ├── Analytics.tsx         # AI analysis
│   │   │   ├── AnalysisHistory.tsx   # analysis history
│   │   │   ├── Assistant.tsx         # ops assistant
│   │   │   ├── Docker.tsx            # Docker management
│   │   │   ├── Monitor.tsx           # system monitor
│   │   │   ├── Remote.tsx            # remote servers
│   │   │   ├── Settings.tsx          # settings
│   │   │   └── Skills.tsx            # skills
│   │   ├── contexts/
│   │   │   ├── RemoteContext.tsx     # remote server state
│   │   │   ├── AssistantContext.tsx  # assistant state
│   │   │   └── ...
│   │   └── types.ts
│   └── package.json
├── server/                       # Node.js backend
│   ├── index.js                  # main entry (API + WebSocket + patrol)
│   ├── remote.js                 # SSH manager (pool, auto-reconnect, backoff)
│   ├── remote-store.js           # per-row server storage (1,000-server scale)
│   ├── docker.js                 # Docker API wrapper
│   ├── docker-ssh-bridge.js      # Docker over SSH (named-pipe bridge)
│   ├── gpu.js                    # GPU queries (nvidia-smi)
│   ├── gpu-mfu.js                # MFU math (engine-agnostic, multi-source probing)
│   ├── log-level.js              # multi-format log level parser
│   ├── container-log-watch.js    # real-time container error watcher
│   ├── ai-shell.js               # AI Shell multi-step agent (env-aware / risk gating)
│   ├── llm-provider.js           # inference adapter (vLLM/SGLang/Strata/Ollama)
│   ├── agent-tools.js            # assistant "hands-on" tools (read/edit/rollback)
│   ├── agent-audit.js            # write-operation audit trail
│   ├── stats-scheduler.js        # centralized stats collection scheduler
│   ├── security/                 # command risk & shell policy
│   ├── routes/                   # routers (chat/chat-runner/docker/remote/gpu/…)
│   └── db/                       # SQLite / PostgreSQL / MySQL data layer
│       └── index.js              # schema + CRUD
├── deploy/                       # deploy assets (scripts, env templates, image archive)
│   ├── deploy.sh                 #   server-side deploy (backup/build/health-check/rollback)
│   ├── deploy.mjs                #   one-command deploy from your dev machine
│   ├── MANUAL.md                 #   full deployment runbook
│   └── images/                   #   archived images + MANIFEST
├── data/                         # database files (gitignored)
└── package.json
```

---

## 🕒 Recent Changes

> Only user-visible changes; see `git log` for details.

### 2026-10-29 · Read-only commands no longer prompt for confirmation

- New `server/security/command-risk.js`: quote-aware shell parsing decides whether a command is
  read-only. Read-only queries through `remote_exec` / `docker_exec`
  (ls/cat/grep/ps/df/ss/docker ps/docker logs/systemctl status/nginx -T…) **run directly, no
  prompt**; file writes, config edits, service restarts, `sudo` and command substitution still
  require confirmation.
- Identical write operations within one task are confirmed only once.
- The judgement is deliberately conservative: any pipeline/segment outside the read-only
  allow-list, or a write redirect / `tee` / `sed -i` / `find -exec` / `xargs` / `sudo` /
  command substitution makes the whole command require confirmation.

### 2026-10-29 · Fixed drag-to-reorder blocking log selection

- Container cards on the Docker page were entirely `draggable`, so the browser's native drag
  hijacked mouse movement — **live logs, AI diagnosis and terminal output could not be selected or
  copied**. Only the grip handle is draggable now (`dragstart` still bubbles, so reorder/drop logic
  is unchanged); Dashboard and Monitor cards were fixed the same way.
- Auto-scroll during streaming now skips while text is selected and uses instant scroll, so a
  selection is no longer scrolled away.
- Live log and terminal panels gained a one-click "Copy" button; log timestamps no longer block
  selection.

### 2026-10 · Ops assistant became an agent; inference-engine compatibility

**The ops assistant can act** (`/assistant`)

- 10 new remote tools: `remote_stat` / `remote_ls` / `remote_read_file` (line ranges, 200KB
  truncation) / `remote_grep` / `remote_edit_file` (exact replace, must be unique) /
  `remote_write_file` / `remote_rollback_file` / `remote_git_status` / `remote_git_diff` /
  `remote_restart_service`
- **Server-side confirmation gate**: `write` / `danger` calls pause the SSE stream and show a
  confirm bar (path / command / diff preview); no action for 3 minutes counts as a denial, and the
  denial is fed back to the model so it can change plan
- **Automatic backups**: files are copied to `<file>.openlog-bak.<timestamp>` before a write;
  `remote_rollback_file` restores them
- **Audit trail**: `GET /api/chat/audit` lists tool / server / path / command / result per write
- Tool-round budget raised from 5 to 10, and the system prompt now encodes the standard workflow
  "locate → explain → modify → **verify** → rollback on failure"

**Inference-engine compatibility** (vLLM / SGLang / Strata / Ollama)

- New `GET /api/models` (unified `/v1/models`, Ollama falls back to `/api/tags`) and
  `GET /api/chat/provider` (detects engine type + hints for enabling native tools)
- **Automatic downgrade**: when an engine doesn't support native function calling (errors **or
  silently ignores tools**) it switches to the `TOOL_CALL:` / `FINAL:` text protocol with identical
  agent capabilities; the decision is cached for 30 minutes
- Fixed a severe `ThinkingStreamFilter` bug that swallowed replies: models that don't emit a
  `<think>` marker (Strata / vLLM / SGLang put reasoning in `reasoning_content`) used to produce
  half-empty or entirely empty answers
- Settings gained vLLM / SGLang presets; "Refresh list" works for all engines

**Remote servers**

- Automatic reconnection with exponential backoff (5s → capped at 300s); cards show the last
  failure reason, retry count and next retry time

**Container log alerts**

- Multi-format level parsing (`[ERROR]` / `ERROR:` / JSON / pino numeric / syslog / logback /
  nginx / `panic:` …)
- Real-time watching (5s incremental polling) + in-page popup that jumps straight to that
  container's live log
- Prevents self-amplification by skipping OpenLog's own containers and its own log lines

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + TypeScript + Vite + TailwindCSS + Recharts + marked |
| Backend | Node.js + Express + WebSocket + SSE |
| Database | SQLite (better-sqlite3) / PostgreSQL / MySQL (pooled) |
| AI | OpenAI-compatible protocol (vLLM / SGLang / Strata / Ollama / cloud), automatic text-protocol downgrade when native tool calling is unavailable |
| Monitoring | chokidar + systeminformation + nvidia-smi |

---

## 💡 Core Features

### 🖥 Remote Server Management

- SSH connections (password / private key / key path) sharing one pooled implementation
- File browsing, log viewing, file editing, upload/download (including chunked upload)
- Embedded PTY terminal and AI Shell
- **Automatic reconnection**: unreachable hosts retry on an exponential backoff
  `5s → 10s → 20s → … → 5min` and return to `connected` by themselves
  (early versions only reconnected once at process start, so a host that went down and came back
  stayed red forever)
  - Clicking "Disconnect" clears the retry schedule — it won't reconnect behind your back
  - Cards show the **last failure reason** (`Timed out while waiting for handshake`,
    `All configured authentication methods failed`, …) and retry count, so a red card is
    diagnosable instead of guesswork about network / sshd / credentials

### 📈 Scale & Performance (1,000 servers)

The original design targeted dozens of servers; at 1,000 these points became bottlenecks.
Each has been reworked:

| Problem | Before | Now |
|---|---|---|
| Server config storage | One JSON blob in `kv_store`; every status change rewrote the whole array (332KB / 1.7ms at 1,000, blocking the event loop) | Dedicated `remote_servers` table, **one row per server**; status changes UPDATE a single row; writes coalesced with a 100ms micro-batch. 1,000 status updates queue in 5ms, land in 95ms; loading 1,000 servers takes 20ms |
| GPU stats collection | Frontend sent 2 requests per server every 30s (stats + mfu) with unbounded `Promise.all` → 2,000 concurrent requests / 30s at 1,000 servers | **Centralized server-side collection**: bounded concurrency (16), in-memory cache, adaptive interval; the frontend makes **one** request for the full snapshot `GET /api/remote/servers/stats` |
| Auto-reconnect | Serial `for … await connect()`: with 1,000 unreachable hosts one pass takes hours, during which nothing is retried | **Bounded concurrency + per-pass cap** (16 concurrent / 64 per pass, ordered by next retry time): a pass finishes in seconds and keeps rolling |
| SSH connections | One resident connection per server, unbounded | Pool cap (300) + **idle eviction** (10 min), reconnected on demand; connect timeout 10s (was 20s) |
| Container log watching | Two nested serial loops every 5s, **no re-entrancy guard** → task pile-up as containers grow | Timer-side re-entrancy guard + interval auto-widening when a pass overruns |
| Log retention | `logPersistenceMaxAge` only applied on a **manual** endpoint; no scheduled job → unbounded growth | Hourly maintenance prunes `log_records` / `analysis_records` by retention days + WAL checkpoint |
| Assistant prompt | All connected servers crammed into the system prompt (thousands = 100k+ tokens) | First 30 servers + a total count; the model queries the rest with `remote_servers` |
| Startup reconnect | `Promise.allSettled` fired thousands of SSH handshakes at once | Bounded concurrency (16) |

**Tunables** (environment variables, all with defaults):

| Variable | Default | Purpose |
|---|---|---|
| `OPENLOG_STATS_INTERVAL_MS` | `30000` | Stats collection interval |
| `OPENLOG_STATS_CONCURRENCY` | `16` | Collection concurrency (16–32 recommended at 1,000) |
| `OPENLOG_MFU_INTERVAL_MS` | `60000` | MFU interval (GPU hosts only) |
| `OPENLOG_MAX_SSH_CONNECTIONS` | `300` | Resident SSH connection cap (LRU eviction) |
| `OPENLOG_SSH_IDLE_TTL_MS` | `600000` | Idle connection eviction time |
| `OPENLOG_SSH_READY_TIMEOUT_MS` | `10000` | SSH connect timeout |
| `OPENLOG_RECONNECT_CONCURRENCY` | `16` | Reconnect concurrency |
| `OPENLOG_RECONNECT_MAX_PER_PASS` | `64` | Max hosts retried per pass |
| `OPENLOG_STARTUP_CONNECT_CONCURRENCY` | `16` | Reconnect concurrency at startup |

> The database is not the bottleneck: SQLite (WAL) sustains 8k+ inserts/sec and loads 1,000
> servers in 20ms. Beyond 1,000 servers, tune the concurrency/interval variables above first; a
> further order of magnitude suggests splitting collection into its own process plus
> PostgreSQL with a pool.

**Recommended config for 1,000 servers** (the connection cap must be ≥ server count, otherwise
every collection pass is just SSH reconnects):

```bash
OPENLOG_STATS_CONCURRENCY=32        # collection concurrency (a pass over 1,000 ≈ 6–12s)
OPENLOG_STATS_INTERVAL_MS=30000     # interval
OPENLOG_MAX_SSH_CONNECTIONS=1200    # resident cap ≥ server count
OPENLOG_SSH_IDLE_TTL_MS=1800000     # eviction relaxed to 30 minutes
OPENLOG_RECONNECT_CONCURRENCY=32
OPENLOG_RECONNECT_MAX_PER_PASS=128
```

> Why raise the connection cap: the collector touches every host every 30s. With a cap of 300,
> LRU evicts and rebuilds connections on every pass (one SSH handshake is 200–500ms + CPU), which
> at 1,000 hosts means dozens of handshakes per second. The memory cost is small — an idle ssh2
> connection is a few hundred KB.

**Known limits**: one process holding ~1,000 SSH sessions is workable; another order of magnitude
(5,000+) suggests moving collection into separate processes/instances, decoupling web from
collection, and PostgreSQL with a pool.

**Upgrade note**: older versions stored servers under the `remote_servers` key in `kv_store`;
startup **migrates automatically** to the new table and keeps the old data in
`remote_servers_legacy` as a backup. No manual step needed.

### 🤖 Ops Assistant

It doesn't just chat — it **locates problems on connected SSH servers, edits code and config**,
then reports back.

**Read (runs automatically)**

| Tool | Purpose |
|---|---|
| `remote_servers` | List servers and connection status (to get a serverId) |
| `remote_stat` / `remote_ls` | File attributes / directory listing |
| `remote_read_file` | Read a file (with line numbers, optional range; truncates above 200KB with a notice) |
| `remote_grep` | **Primary debugging tool**: regex search across dirs/files, returns `file:line:content` |
| `remote_git_status` / `remote_git_diff` | Repo status and uncommitted changes |
| `remote_system_stats` / `remote_search_logs` | System stats / log search |
| `docker_list` / `docker_logs` / `docker_inspect` / `docker_health_check` | Container troubleshooting |

**Write (enforced server-side, not just prompt discipline)**

| Tool | Notes |
|---|---|
| `remote_edit_file` | Exact string replacement; **`old_string` must be unique**, otherwise rejected with the match count |
| `remote_write_file` | Whole-file write (create or overwrite) |
| `remote_rollback_file` | Restore the most recent automatic backup |
| `remote_restart_service` | Restart a systemd service |
| `remote_exec` / `docker_exec` **non-read-only** commands, `docker_start/stop/restart` | Command and container operations |

**Three safety gates**

1. **Server-side confirmation**: `write` / `danger` calls pause the stream and show a confirm bar
   (path, command, diff preview); only "Allow" executes. **No action for 3 minutes counts as a
   denial**, which is fed back to the model so it can try another approach (a prompt-only "ask the
   user first" is unreliable, so it's enforced in code).
   **Read-only commands are auto-approved**: `remote_exec` / `docker_exec` first parse the command
   (`server/security/command-risk.js`) — `ls` / `cat` / `grep` / `ps` / `df` / `ss` / `docker ps` /
   `docker logs` / `systemctl status` / `nginx -T` / `journalctl` and read-only combinations joined
   with `|` `;` `&&` (including redirects to `/dev/null`) run without a prompt; write redirects,
   `tee`, `sed -i`, `find -exec`, service restarts, `docker run/rm/restart`, `sudo` and command
   substitution still require confirmation. Identical writes within one task are confirmed once.
2. **Automatic backups**: the original is copied to `<file>.openlog-bak.<timestamp>` before any
   write, so a bad edit can be rolled back.
3. **Path and command validation**: only absolute paths, no quotes/newlines; writes to `/etc`,
   `/root`, `~/.ssh` and similar are escalated to red `danger`; delete/format/`dd`-style commands
   are flagged separately.

**Standard workflow** (encoded in the system prompt): `remote_servers` to locate the host →
`remote_grep` to find the error → `remote_read_file` to read code → explain the plan →
`remote_edit_file` to apply → **verify** (read back / run tests / restart and check logs) →
rollback on failure.

**Long tasks no longer die mid-way** (default 30 rounds / 10 minutes, configurable):

| Mechanism | Effect |
|---|---|
| 30-round budget | The old implementation hardcoded 10 rounds, so long tasks were always cut off; now `OPENLOG_ASSISTANT_MAX_ROUNDS` |
| 10-minute budget | `OPENLOG_ASSISTANT_MAX_WALL_MS`; on timeout it still produces an interim summary first |
| **Context compaction** | Estimated tokens before each request; over budget, older tool results are compressed into one-line summaries (keeping tool name/key fields/errors) while recent rounds stay intact; measured: one compaction needed over 43 tool calls (17k tokens) |
| **Overflow retry** | If the model really returns `exceeds the context window`, it compacts deeply and retries once instead of failing |
| **Graceful wrap-up** | When the budget runs out the model is asked for an interim summary (what's confirmed / what's left / suggested next steps) rather than "please simplify the question" |
| Per-round model timeout | `OPENLOG_ASSISTANT_ROUND_TIMEOUT_MS` (default 180s); retried once, wrap-up after two consecutive timeouts |
| SSE heartbeat | A comment frame every 15s so proxies/browsers don't kill an idle-looking connection |
| Connection self-healing | `ensureSshConnection` validates the real connection before a tool runs (auto-reconnects when the status says `connected` but the connection was LRU-evicted) |

The UI surfaces three kinds of notices: engine downgrade (`provider_notice`), context compaction
(`context_compacted`) and budget exhaustion (`budget_exhausted`) — so users know what happened and
that replying "continue" resumes the work.

Also:

- SSE streaming with live tool-call status and diff visualization
- `@`-mentions pull analysis history into context; patrol reports can be injected for analysis
- Conversation history is persisted locally

**Audit trail**: every write/danger operation (executed, failed, denied) is recorded and queryable
via `GET /api/chat/audit?limit=50` — tool, server, path, command, result, timestamp. Only metadata
is stored (never file contents, so secrets in configs aren't duplicated into the DB); combined with
automatic backups this allows after-the-fact rollback.

> ⚠️ Security boundary: tools execute as the **existing SSH account** (which typically has sudo /
> docker rights) with no privilege separation. The defence is threefold: the **server-side
> confirmation gate** (nothing is changed without your click), **automatic backups** (rollback) and
> the **audit trail** (review). The gate protects against mistakes — it is not a sandbox.

### 🧠 AI Shell

AI Shell is a **multi-step agent that actually acts**, not a "generate one command" box:

- **Environment awareness**: at session start it collects real host facts (distro / kernel / CPU /
  memory / disk / GPU / containers / listening ports / installed tools) into the prompt, so the
  model never guesses whether Docker exists or whether it's Ubuntu
- **Multi-step execution**: given a goal ("what's running on the GPUs? is VRAM healthy?") it runs
  commands → reads output → decides the next step → concludes; on failure it reads the error and
  self-corrects, up to 6 steps
- **Streaming output**: commands stream as they run (no more waiting for long commands), stoppable
  at any time (Esc / stop button)
- **Risk gating + confirmation**:
  - `read` (df/ls/ps/nvidia-smi/docker ps…) → executes directly in auto mode
  - `write` (mkdir/cp/systemctl restart/docker restart…) → asks in auto mode, always asks in
    step-by-step mode
  - `danger` (rm -rf / mkfs / shutdown / docker rm / overwriting `/etc` …) → **always requires
    human confirmation**
- **Two modes**: AI mode (natural-language goal) / command mode (direct shell with streaming output,
  ↑↓ history, Ctrl+L clear)
- **Multi-skill composition**: skill workflows are injected into the prompt so the agent follows a
  standard troubleshooting procedure
- Context is kept per session; command history is persisted locally

> ⚠️ Security boundary: AI Shell acts as the **existing SSH account** (typically with sudo / docker
> rights). Risk gating + confirmation only reduce the chance of mistakes — **it is not a sandbox**.
> High-risk operations (dropping a database, wiping a data disk) rely entirely on the confirmation
> gate.

### 🔧 Skills

- Standard Markdown format (Purpose / Workflow / Constraints / Output)
- 8 built-in ops skills (protected, not deletable)
- JSON import/export
- One click to use in the assistant or AI Shell

### 🎮 GPU Monitoring

- Automatically pulls GPU status from every connected server
- Per card: utilization, **MFU (Model FLOPs Utilization)**, VRAM, temperature, processes (PID +
  name + VRAM)
- MFU is shown only when the service actually exposes inference metrics; services that don't are
  shown with utilization/VRAM/temperature only (never guessed, never faked with utilization)
- Auto-refresh every 30 seconds
- Shares server config with the Remote page — no re-entering host/user

#### How MFU is computed

The `MFU` badge appears on the card running the inference engine (engines are mapped to GPUs by
process name from nvidia-smi, e.g. `VLLM::EngineCore` / `strata`):

```
MFU = actual model FLOPs/s ÷ GPU peak dense FP16/BF16 TFLOPS (no sparsity)
```

**Core principle: if the service doesn't expose inference metrics, no MFU is shown.** OpenLog never
substitutes GPU utilization for MFU — utilization is kernel-active time, not model FLOPs
utilization, and the two can differ by an order of magnitude in a bandwidth-bound decode phase.

Data sources (read **locally on the target host** over the existing SSH connection — no extra
ports, no remote config changes):

1. Engine-reported FLOPs counters (e.g. vLLM's `vllm:estimated_flops_per_gpu_total`) differenced
   over time;
2. When that counter is missing or always 0, token-count deltas × `2 × activated parameters`
   (for MoE use the activated `A3B`-style count so MFU isn't inflated by total parameters);
3. When the engine reports its GPU model (e.g. Strata's `/metrics`), use it to map MFU to the
   specific card.

**Engines/formats auto-discovered**:

| Engine/format | Endpoint | Key metrics |
|---|---|---|
| vLLM | `/metrics` (Prometheus) | `vllm:prompt_tokens_total` + `vllm:generation_tokens_total` (prefers `by_source{local_compute}`, excluding prefix-cache hits) |
| Strata | `/metrics` (JSON) | `totals.prompt_tokens` / `totals.output_tokens` |
| SGLang | `/metrics` (Prometheus) | `sglang:prompt_tokens_total` / `generation_tokens_total` |
| TGI | `/metrics` (Prometheus) | `tgi_request_input_length_sum` / `tgi_request_generated_tokens_sum` |
| llama.cpp | `/metrics` (Prometheus) | `llamacpp:prompt_tokens_total` / `llamacpp:tokens_predicted_total` |
| Custom service | `/metrics` (JSON or Prometheus) | see [Integrating a custom inference service](#-integrating-a-custom-inference-service) |

Discovery and auth are automatic: it scans listening ports plus ports published by `docker ps`; on
401/403 it retries with candidate keys taken from `*_KEY / *_TOKEN / *_SECRET` env vars of local
containers. `/metrics` is only reachable over loopback (`127.0.0.1` / `localhost`) — metrics are
never exposed publicly.

Notes and limits:

- The first load needs two samples (~2s); afterwards the 30s poll adds a single curl. The
  differencing window is capped at 90s, after which it resamples, so a stale window never shows up
  as a current value (this is also why idle shows 0% rather than a historical peak).
- The peak-FLOPS table covers 4090/5090/A100/H100/L40S/T4 and similar; **cards outside the table
  are not guessed** and show no MFU. Likewise, no discovered metrics endpoint or no metrics
  implementation means **no MFU** (utilization/VRAM/temperature only).
- Single-stream decode MFU is typically 1%–5% (bandwidth-bound); it rises with concurrency and long
  prefills.
- Use it to compare models/batch configs on the same machine — not as an absolute performance
  metric.

### 🔌 Integrating a Custom Inference Service

MFU collection is engine-agnostic: **if your service can report how many tokens it processed, MFU
can be computed.** Hand-written transformers, in-house inference frameworks and training scripts
all qualify. Three integration paths:

#### Option 1: add a `/metrics` endpoint (recommended, ~5 lines)

Accumulate token counts in your inference loop and expose them as JSON (or Prometheus text).
OpenLog discovers and integrates automatically.

**JSON contract** (field aliases are supported):

```json
{
  "model": "my-transformer-7b",
  "prompt_tokens": 123456,
  "generation_tokens": 7890,
  "gpu": "NVIDIA GeForce RTX 4090"
}
```

- `prompt_tokens` aliases: `input_tokens` / `prefill_tokens`; `generation_tokens` aliases:
  `output_tokens` / `completion_tokens` / `decode_tokens`
- `flops_total` (optional): if your code can count FLOPs directly, this is the most accurate —
  OpenLog prefers it
- `gpu` (optional): the engine-reported GPU model, used to attach MFU to the right card
- Values must be **monotonically increasing counters** (OpenLog differences two samples)

Example (FastAPI + PyTorch, 10 lines):

```python
from fastapi import FastAPI
import torch

app = FastAPI()
STATS = {"prompt_tokens": 0, "generation_tokens": 0}

@app.get("/metrics")
def metrics():
    return {
        "model": "my-transformer-7b",
        "prompt_tokens": STATS["prompt_tokens"],
        "generation_tokens": STATS["generation_tokens"],
        "gpu": torch.cuda.get_device_name(0),
    }

# In your inference loop (after prefill add the prompt length; +1 per generated token)
# STATS["prompt_tokens"] += len(input_ids[0])
# STATS["generation_tokens"] += 1
```

Prometheus text also works (OpenLog prefix-matches with `sumMetric`, so
`<any-prefix>:prompt_tokens_total` is recognized):

```
myengine:prompt_tokens_total 123456
myengine:generation_tokens_total 7890
```

#### Option 2: log parsing (no code change, if logs already contain token counts)

If your script already logs token counts, point OpenLog at that log directory ("log dir / file
pattern" on the Remote page) and it parses `tokens=N` / `tok/s=N` style fields line by line.
Prefer option 1 for a first integration — log parsing depends on a stable format and breaks when
the script changes.

#### Option 3: specify parameter count manually (when the name lacks `27B`)

If the parameter count can't be parsed from the model name (e.g. `my-transformer`), set
"activated parameters (B)" for that server under **Settings → GPU monitoring / MFU data source**.
You can also override there:

| Field | Purpose |
|---|---|
| Metrics URL | Manually specify `http://127.0.0.1:<port>/metrics` (blank = auto-discover; **loopback only**) |
| Auth key | Bearer token for the metrics endpoint (stored server-side, the UI only shows the first 4 chars) |
| Activated parameters (B) | Overrides name parsing (MoE: activated parameters, not total) |
| Engine process name | Optional regex mapping MFU to a specific GPU (e.g. if the process is `python train_server.py`, use `train_server`) |
| FLOPs basis | FP16/BF16 dense or FP8 dense (match the model's compute precision) |

> If the engine process isn't found and the service doesn't report a `gpu` model, MFU is spread
> across all GPUs of that host (divided by card count) and shown on every card. For per-card
> accuracy, add the "engine process name" or report `gpu` in the JSON.

#### Verifying the integration

1. On the target host, `curl -s http://127.0.0.1:<port>/metrics` shows the fields from the contract;
2. Open the GPU monitoring page — the server's header row shows an `<engine> MFU x.x%` badge;
3. Send an inference request; the value should rise clearly within 30 seconds (falling back to 0%
   when idle is expected).

> If the service in the container doesn't report metrics yet, the card simply **shows no MFU**
> (utilization/VRAM/temperature only). That's deliberate: no number is better than a fake one
> derived from GPU utilization.

### 🔔 Alert Rules

- Configured per machine: keywords, level filter, cooldown, webhook URL
- Container patrol triggers webhook notifications automatically
- Cooldown + deduplication avoid alert storms

### 🐳 Container Log Alerts

Two mechanisms, both enabled by default:

| Mechanism | Cadence | Purpose |
|---|---|---|
| **Real-time error alerts** | Incremental tail, 5s default | An `ERROR` / `FATAL` in a running container pops up in the page corner with the raw log line and a "view logs →" link |
| **Scheduled patrol** | 5 minutes default | Batch-scans all containers, results land in the AI analysis page; also pushed via webhook when configured |

Level detection covers common formats (`server/log-level.js`, unit-tested):

```
[ERROR] xxx                          ERROR: xxx
ERROR xxx                            2026-10-26T18:35:14Z ERROR xxx
2026-10-26 18:35:14,532 - root - ERROR - xxx     (Python logging)
(APIServer pid=1) ERROR: xxx         (vLLM / uvicorn wrapped prefix)
{"level":"error","msg":"..."}        (JSON structured logs; also severity/log.level)
{"level":50,"msg":"..."}             (pino / bunyan numeric levels)
level=error msg="..."                (logfmt)
Oct 26 18:35:14 host app[1]: ERROR xxx           (syslog)
18:35:14.532 [main] ERROR com.x.App - xxx        (logback)
2026/10/26 18:35:14 [error] 12#0: xxx            (nginx)
panic: xxx / [CRITICAL] / [SEVERE]    → FATAL / ERROR
```

> Early versions only recognized the `[ERROR]` bracket prefix, so `ERROR xxx`, JSON logs and
> vLLM's `(APIServer pid=1) ERROR:` were all classified as INFO — **neither patrol nor popups
> fired**, which is exactly why "container errors produced no popup". Everything now goes through
> the multi-format parser, and real-time alerts are on by default.

Popup behaviour:

- Same container + same error pattern (signature after stripping timestamps/IPs/UUIDs) pops at most
  **once per 60 seconds** to avoid spam;
- At most 5 entries per container per check; the rest are merged into "N more in this batch";
- Popups persist; "view logs →" jumps to the Docker page, expands that container and opens its live
  log stream;
- Real-time alerts can be disabled or the interval changed (3s / 5s / 10s / 30s) under
  **Settings → Container anomaly monitoring**.

### 🐳 Docker Live Logs

- WebSocket streaming tail in a dark terminal style
- Pause / resume / clear / auto-scroll
- Colored by level (shares the same multi-format level parser as alerts)

### 💻 In-Container Command Exec (Docker Page Terminal)

The terminal panel inside a container's details lets you run **read-only** commands for quick
troubleshooting:

- Supported: `ls` / `cat` / `head` / `tail` / `ps` / `grep` / `du` / `df` / `uname` / `stat` / `ss` /
  `ping` and similar (full allow-list in `server/security/shell-command-policy.js`)
- Rejected: shell metacharacters and command chaining (`;` `|` `&&` `$( )` backticks `>` `<`
  newlines) — the command **never goes through a shell**, arguments are passed as argv to the
  container
- Output is demultiplexed from Docker's multiplexed frames (otherwise frame headers leak into the
  text); 256KB output cap per command
- Commands are tokenized respecting quotes, so paths with spaces like `cat "/var/log/my app.log"`
  work

**Disabled by default**; enable explicitly (you can enable the panel without enabling SSH remote
exec):

```bash
OPENLOG_ENABLE_CONTAINER_EXEC=1   # or OPENLOG_ENABLE_REMOTE_EXEC=1 to enable both
```

When disabled the panel returns a clear "in-container command execution is not enabled" message
instead of a cryptic error.

> ⚠️ "Metacharacter filtering + command-name allow-list" is **not a security boundary**: commands
> themselves may have escape hatches. The real boundary is this switch being off by default plus
> page token auth. Use the read-only panel for log inspection/troubleshooting; use the AI Shell or
> SSH terminal on the `/remote` page when you need an interactive shell.

---

## 📝 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/monitor/stats` | System stats (incl. GPU) |
| GET | `/api/db/info` | Database health: backend, pool occupancy, latency, storage (`?counts=1` adds key table row counts; no credentials) |
| GET | `/api/remote/servers` | Remote server list |
| GET | `/api/remote/servers/:id/stats` | Remote system stats (incl. GPU processes; served from the collection cache) |
| GET | `/api/remote/servers/stats` | Full stats snapshot (server-side collection; `?refresh=1` or `?ids=a,b` to refresh on demand) |
| GET | `/api/remote/servers/:id/mfu` | Remote model MFU (reads the engine `/metrics`) |
| GET | `/api/docker/containers` | Container list |
| POST | `/api/docker/:sourceId/:containerId/exec` | Execute in container (read-only allow-list; needs `OPENLOG_ENABLE_CONTAINER_EXEC=1`) |
| GET | `/api/docker/containers/:sid/:cid/logs` | Container logs |
| WS | `/ws/docker/logs/:sid/:cid` | Container live log stream |
| WS | `/ws/aishell/:serverId` | AI Shell terminal |
| GET | `/api/skills` | Skill list |
| POST | `/api/skills` | Create a skill |
| GET | `/api/alerts` | Alert configs |
| PUT | `/api/alerts` | Save alert configs |
| GET | `/api/gpu/remote-server/:id` | Remote GPU (reuses SSH) |
| POST | `/api/chat` | Assistant chat (SSE streaming, with agent tool calls) |
| POST | `/api/chat/confirm` | Approve/deny one write operation (`{confirmId, approved}`) |
| GET | `/api/chat/audit` | Assistant write-operation audit trail |
| GET | `/api/chat/provider` | Detected inference engine and capability hints |
| GET | `/api/models` | Model list (vLLM/SGLang/Strata/Ollama; `?baseUrl=&apiKey=` overrides) |

---

## 📄 License

MIT License
