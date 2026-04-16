"""
OpenLog Python Backend — main server
对应 JS 版: server/index.js + server/db/index.js
"""
import asyncio
import base64
import json
import os
import re
import subprocess
import time
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import aiosqlite
import asyncssh
import psutil
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import socketio as _sio
from starlette.applications import Starlette
from starlette.routing import Mount, Router

load_dotenv()

# ─── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
SETTINGS_FILE = BASE_DIR / "settings.json"
SQLITE_PATH = DATA_DIR / "openlog.db"
REMOTE_CONFIG_PATH = BASE_DIR / "remote-servers.json"

# ─── Default settings ────────────────────────────────────────────────────────
DEFAULT_SETTINGS: dict[str, Any] = {
    "openaiApiKey": "",
    "openaiBaseUrl": "http://localhost:11434/v1",
    "model": "qwen3.5:9b",
    "logPath": str(Path.home() / "logs"),
    "watchFiles": "*.log",
    "refreshInterval": "5000",
    "autoAnalysis": True,
    "thinkingEnabled": False,
    "watchSources": [
        {
            "id": "default",
            "name": "默认服务",
            "path": str(Path.home() / "logs"),
            "pattern": "*.log",
            "enabled": True,
            "autoAnalysis": True,
        }
    ],
    "dockerSources": [
        {
            "id": "local",
            "name": "本地 Docker",
            "host": "localhost",
            "port": 2375,
            "tls": False,
            "enabled": False,
            "autoAnalysis": True,
            "projects": [],
        }
    ],
}

# ─── App & Socket.IO ──────────────────────────────────────────────────────────
app = FastAPI(title="OpenLog API")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)

sio = _sio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

# ─── SQLite Database ─────────────────────────────────────────────────────────
db: aiosqlite.Connection | None = None

async def init_db():
    global db
    db = await aiosqlite.connect(str(SQLITE_PATH))
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    await db.executescript("""
        CREATE TABLE IF NOT EXISTS machines (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL DEFAULT 'local',
            name TEXT NOT NULL,
            host TEXT,
            port INTEGER,
            ssh_user TEXT,
            log_path TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            updated_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE TABLE IF NOT EXISTS log_records (
            id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_name TEXT NOT NULL,
            content TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'error',
            timestamp INTEGER,
            parsed JSON,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS analysis_records (
            id TEXT PRIMARY KEY,
            log_record_id TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            diagnosis TEXT NOT NULL,
            suggestion TEXT,
            severity TEXT,
            model TEXT,
            token_used INTEGER,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            FOREIGN KEY (log_record_id) REFERENCES log_records(id) ON DELETE CASCADE,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_log_records_machine ON log_records(machine_id);
        CREATE INDEX IF NOT EXISTS idx_log_records_timestamp ON log_records(timestamp);
        CREATE INDEX IF NOT EXISTS idx_analysis_records_log ON analysis_records(log_record_id);
    """)
    await db.commit()
    print(f"[DB] SQLite initialized: {SQLITE_PATH}")

# ─── KV Store helpers ─────────────────────────────────────────────────────────
async def kv_get(key: str) -> Any | None:
    if not db:
        return None
    async with db.execute("SELECT value FROM kv_store WHERE key=?", (key,)) as cur:
        row = await cur.fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return row[0]

async def kv_set(key: str, value: Any) -> None:
    if not db:
        return
    now = int(time.time())
    str_val = json.dumps(value) if not isinstance(value, str) else value
    await db.execute(
        "INSERT INTO kv_store(key,value,updated_at) VALUES(?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, str_val, now),
    )
    await db.commit()

async def kv_delete(key: str) -> None:
    if not db:
        return
    await db.execute("DELETE FROM kv_store WHERE key=?", (key,))
    await db.commit()

async def kv_list(prefix: str = "") -> list[dict]:
    if not db:
        return []
    sql = "SELECT * FROM kv_store WHERE key LIKE ? ORDER BY key" if prefix else "SELECT * FROM kv_store ORDER BY key"
    p = prefix + "%" if prefix else "%"
    async with db.execute(sql, (p,)) as cur:
        rows = await cur.fetchall()
    cols = [d[0] for d in (await cur.description) or []]
    return [dict(zip(cols, r)) for r in rows]

# ─── Settings ─────────────────────────────────────────────────────────────────
settings: dict[str, Any] | None = None

def ensure_settings() -> dict[str, Any]:
    global settings
    if settings is None:
        settings = load_settings()
    return settings

async def ensure_settings_async() -> dict[str, Any]:
    global settings
    if settings is None:
        settings = await load_settings_async()
    return settings

async def load_settings_async() -> dict[str, Any]:
    s = await kv_get("app_settings")
    if s:
        return s
    # 回退到文件
    if SETTINGS_FILE.exists():
        try:
            data = json.loads(SETTINGS_FILE.read_text())
            await kv_set("app_settings", data)
            print("[Settings] 已迁移到 SQLite")
            return data
        except Exception:
            pass
    return DEFAULT_SETTINGS.copy()

def load_settings() -> dict[str, Any]:
    return DEFAULT_SETTINGS.copy()

async def save_settings(data: dict[str, Any]) -> bool:
    global settings
    settings = data
    await kv_set("app_settings", data)
    # 同时写文件作为备份
    try:
        SETTINGS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    except Exception:
        pass
    return True

# ─── Thinking filter ──────────────────────────────────────────────────────────
class ThinkingStreamFilter:
    """流式思维过滤器，状态机逐 token 过滤 <think> 块"""
    def __init__(self):
        self.in_think = False
        self.buffer = ""

    def feed(self, content: str) -> str:
        if ensure_settings().get("thinkingEnabled", False):
            return content
        output = ""
        i = 0
        if self.buffer:
            content = self.buffer + content
            self.buffer = ""
        while i < len(content):
            if self.in_think:
                idx = content.find("</think>", i)
                if idx != -1:
                    self.in_think = False
                    i = idx + 8
                    continue
                i = len(content)
                break
            else:
                idx = content.find("<think", i)
                if idx == -1:
                    output += content[i:]
                    break
                output += content[i:idx]
                tag_end = content.find(">", idx)
                if tag_end != -1:
                    self.in_think = True
                    i = tag_end + 1
                    continue
                self.buffer = content[idx:]
                break
        return output

    def flush(self) -> str:
        if ensure_settings().get("thinkingEnabled", False):
            return self.buffer
        self.in_think = False
        remaining = self.buffer
        self.buffer = ""
        return remaining

def strip_thinking(text: str) -> str:
    if ensure_settings().get("thinkingEnabled", False):
        return text
    return re.sub(r"<think\b[^>]*>[\s\S]*?</think>", "", text).strip()

# ─── In-memory stores ──────────────────────────────────────────────────────────
logs: list[dict] = []
_monitor_history: list[dict] = []
analysis_history: list[dict] = []
analysis_queues: dict[str, dict] = defaultdict(lambda: {"running": False, "pending": []})
analysis_debounce: dict[str, float] = {}
DEBOUNCE_MS = 30_000
MAX_ANALYSIS_HISTORY = 500

# WebSocket clients
ws_clients: set[Any] = set()

# File watchers: sourceId -> watch Process
watchers: dict[str, Any] = {}
file_offsets: dict[str, int] = {}

# ─── WebSocket broadcast ───────────────────────────────────────────────────────
async def broadcast(data: dict) -> None:
    msg = json.dumps(data)
    for client in list(ws_clients):
        try:
            await sio.emit("message", data, room="main")
            break  # socketio 统一广播
        except Exception:
            pass

async def sio_broadcast(data: dict) -> None:
    await sio.emit("message", data)

# ─── File watching ────────────────────────────────────────────────────────────
async def read_last_line(file_path: str, source_id: str) -> str | None:
    try:
        stat = os.stat(file_path)
        size = stat.st_size
        last_pos = file_offsets.get(file_path, 0)
        if size < last_pos:
            file_offsets[file_path] = 0
        if size == last_pos:
            return None
        with open(file_path, "rb") as f:
            f.seek(last_pos)
            buf = f.read(min(size - last_pos, 512 * 1024))
        file_offsets[file_path] = size
        content = buf.decode("utf-8", errors="replace")
        lines = [l for l in content.split("\n") if l.strip()]
        if not lines:
            return None
        return lines[-1]
    except Exception:
        return None

def parse_log_line(line: str, source: str) -> dict:
    ts_match = re.search(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})", line)
    lv_match = re.search(r"\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b", line, re.I)
    return {
        "id": str(uuid.uuid4()),
        "timestamp": ts_match.group(1) if ts_match else datetime.now().isoformat(),
        "level": lv_match.group(1).upper() if lv_match else "INFO",
        "message": line,
        "source": source,
        "metadata": json.dumps({"raw": line}),
    }

def start_log_watcher() -> None:
    s = ensure_settings()
    sources = s.get("watchSources") or []
    if not sources:
        src = {
            "id": "default",
            "name": "默认服务",
            "path": s.get("logPath") or str(Path.home() / "logs"),
            "pattern": s.get("watchFiles") or "*.log",
            "enabled": True,
            "autoAnalysis": s.get("autoAnalysis", True),
        }
        _start_source_watcher(src)
        return
    for src in sources:
        if not src.get("enabled", True):
            print(f"[{src['id']}] 跳过（已禁用）")
            continue
        _start_source_watcher(src)

def _start_source_watcher(source: dict) -> None:
    log_dir = Path(source["path"])
    pattern = source.get("pattern") or "*.log"
    sid = source["id"]
    import glob

    def scan_dir():
        for p in log_dir.glob(pattern):
            if p.is_file():
                file_offsets[str(p)] = 0

    scan_dir()

    async def on_change(file_path: str):
        if os.path.isfile(file_path):
            line = await read_last_line(file_path, sid)
            if line:
                src_name = source.get("name", sid)
                log_entry = parse_log_line(line, f"{src_name}/{os.path.basename(file_path)}")
                log_entry["sourceId"] = sid
                _save_log(log_entry, source)
                await sio_broadcast({"type": "log", "data": log_entry})

    # 轮询方式监听文件（跨平台兼容）
    async def poll_files():
        last_mtimes = {}
        while True:
            try:
                current = [str(p) for p in glob.glob(str(log_dir / pattern)) if p.is_file()]
                for fp in current:
                    mtime = os.path.getmtime(fp)
                    if fp not in last_mtimes:
                        last_mtimes[fp] = mtime
                        file_offsets[fp] = 0
                    elif mtime != last_mtimes[fp]:
                        last_mtimes[fp] = mtime
                        await on_change(fp)
            except Exception:
                pass
            await asyncio.sleep(1.0)

    asyncio.create_task(poll_files())
    print(f"[{sid}] 🚀 开始监听: {log_dir} ({pattern})")

def _save_log(log: dict, source: dict | None = None) -> None:
    logs.insert(0, log)
    if len(logs) > 10000:
        logs.pop()
    # 自动分析 ERROR/FATAL
    if log["level"] in ("ERROR", "FATAL"):
        auto = ensure_settings().get("autoAnalysis", True)
        src_auto = source.get("autoAnalysis", True) if source else True
        if auto and src_auto:
            _enqueue_analysis(log, source)

# ─── Analysis queue ────────────────────────────────────────────────────────────
def get_queue(source_id: str) -> dict:
    return analysis_queues[source_id]

def process_queue(source_id: str) -> None:
    q = get_queue(source_id)
    if q["running"] or not q["pending"]:
        return
    q["running"] = True
    item = q["pending"].pop(0)
    asyncio.create_task(_run_analysis(item["log"], item["source"]))
    q["running"] = False

def _enqueue_analysis(log: dict, source: dict | None = None) -> None:
    sid = (source or {}).get("id", "default") if source else "default"
    q = get_queue(sid)
    key = f"{sid}:{log['message'][:120]}"
    now = time.time() * 1000
    if key in analysis_debounce and now - analysis_debounce[key] < DEBOUNCE_MS:
        print(f"[{sid}] ⏭️ 防抖跳过: {log['message'][:60]}")
        return
    analysis_debounce[key] = now
    q["pending"].append({"log": log, "source": source})
    print(f"[{sid}] 📋 加入分析队列 (待处理: {len(q['pending'])})")
    process_queue(sid)

async def _run_analysis(error_log: dict, source: dict | None = None) -> None:
    sid = (source or {}).get("id", "default") if source else "default"
    s = ensure_settings()
    api_key = s.get("openaiApiKey", "")
    base_url = s.get("openaiBaseUrl", "http://localhost:11434/v1")
    model = s.get("model", "")
    is_local = "localhost" in base_url or "127.0.0.1" in base_url

    if not api_key and not is_local:
        await sio_broadcast({
            "type": "ai_analysis", "status": "skipped",
            "message": "未配置 LLM，无法自动分析。",
            "log": error_log, "sourceId": sid,
        })
        return
    if not model:
        await sio_broadcast({
            "type": "ai_analysis", "status": "skipped",
            "message": "未配置 LLM 模型，无法自动分析。",
            "log": error_log, "sourceId": sid,
        })
        return

    await sio_broadcast({"type": "ai_analysis", "status": "pending", "log": error_log, "sourceId": sid})
    print(f"[{sid}] 🤖 开始分析: {error_log['message'][:80]}")

    prompt = f"""你是一个专业的运维工程师。请分析以下错误日志，找出根因并给出简洁的修复建议。

错误日志：
[{error_log['timestamp']}] [{error_log['level']}] {error_log['message']}
来源: {error_log['source']}

请用以下格式回复（Markdown）：
## 🔍 根因分析
[一句话说明最可能的根因]

## 💡 修复建议
1. [具体可操作的修复步骤]
2. [...]

回复语言与日志一致（中文日志用中文）。"""

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key or "ollama", base_url=base_url)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        analysis = strip_thinking(resp.choices[0].message.content or "")
        record = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "sourceId": sid,
            "sourceName": (source or {}).get("name", sid) if source else sid,
            "log": error_log,
            "analysis": analysis,
            "status": "done",
            "model": model,
        }
        analysis_history.insert(0, record)
        if len(analysis_history) > MAX_ANALYSIS_HISTORY:
            analysis_history.pop()
        await sio_broadcast({
            "type": "ai_analysis", "status": "done",
            "log": error_log, "sourceId": sid,
            "analysis": analysis, "recordId": record["id"],
        })
    except Exception as e:
        record = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "sourceId": sid,
            "sourceName": (source or {}).get("name", sid) if source else sid,
            "log": error_log,
            "analysis": None,
            "status": "error",
            "error": str(e),
            "model": model,
        }
        analysis_history.insert(0, record)
        if len(analysis_history) > MAX_ANALYSIS_HISTORY:
            analysis_history.pop()
        await sio_broadcast({
            "type": "ai_analysis", "status": "error",
            "message": f"分析失败: {e}",
            "log": error_log, "sourceId": sid,
            "recordId": record["id"],
        })

# ─── System monitor ───────────────────────────────────────────────────────────
monitor_task: asyncio.Task | None = None

async def start_monitor() -> None:
    global monitor_task
    if monitor_task:
        monitor_task.cancel()
    interval_ms = int(ensure_settings().get("refreshInterval", 5000))
    async def poll():
        while True:
            try:
                cpu = psutil.cpu_percent(interval=0.5)
                mem = psutil.virtual_memory()
                disks = psutil.disk_usage("/")
                nets = psutil.net_io_counters(pernic=True)
                gpus = await _get_gpus()
                stats = {
                    "timestamp": datetime.now().isoformat(),
                    "cpu": cpu,
                    "memory": (mem.used / mem.total) * 100 if mem.total > 0 else 0,
                    "disk": (disks.used / disks.total) * 100 if disks.total > 0 else 0,
                    "network": sum(n.bytes_recv + n.bytes_sent for n in nets.values()) if nets else 0,
                    "gpuUtil": gpus[0]["util"] if gpus else 0,
                }
                _monitor_history.insert(0, stats)
                if len(_monitor_history) > 1000:
                    _monitor_history.pop()
                await sio_broadcast({"type": "monitor", "data": stats})
            except Exception as e:
                print(f"Monitor error: {e}")
            await asyncio.sleep(interval_ms / 1000)
    monitor_task = asyncio.create_task(poll())

async def _get_gpus() -> list[dict]:
    try:
        out = subprocess.check_output(
            "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu "
            "--format=csv,noheader,nounits",
            shell=True, timeout=3,
        ).decode().strip()
        gpus = []
        for line in out.split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 6:
                gpus.append({
                    "index": int(parts[0]),
                    "name": parts[1],
                    "util": float(parts[2]) if parts[2] else 0,
                    "memUsed": float(parts[3]) if parts[3] else 0,
                    "memTotal": float(parts[4]) if parts[4] else 1,
                    "temp": float(parts[5]) if parts[5] else 0,
                })
        return gpus
    except Exception:
        return []

# ─── Remote servers ───────────────────────────────────────────────────────────
# SSH 连接池: id -> SSHConnection
ssh_connections: dict[str, Any] = {}
remote_servers: list[dict] = []

def _encrypt_pw(pw: str) -> str:
    return base64.b64encode(pw.encode()).decode()

def _decrypt_pw(encoded: str) -> str:
    return base64.b64decode(encoded.encode()).decode()

async def load_remote_servers() -> list[dict]:
    global remote_servers
    servers = await kv_get("remote_servers")
    if servers:
        remote_servers = [
            {**s, "password": _decrypt_pw(s["password"]) if s.get("password") else None}
            for s in servers
        ]
        print(f"[Remote] 从 SQLite 加载了 {len(remote_servers)} 台服务器")
        return remote_servers
    # 回退到文件
    if REMOTE_CONFIG_PATH.exists():
        try:
            remote_servers = json.loads(REMOTE_CONFIG_PATH.read_text())
            remote_servers = [
                {**s, "password": _decrypt_pw(s["password"]) if s.get("password") else None}
                for s in remote_servers
            ]
        except Exception:
            remote_servers = []
    return remote_servers

async def _save_remote_servers() -> None:
    to_save = [
        {**s, "password": _encrypt_pw(s["password"]) if s.get("password") else None}
        for s in remote_servers
    ]
    await kv_set("remote_servers", to_save)

def get_servers() -> list[dict]:
    return [
        {
            "id": s["id"], "name": s["name"], "host": s["host"],
            "port": s["port"], "username": s["username"],
            "logPath": s.get("logPath"), "watchFiles": s.get("watchFiles"),
            "lastConnected": s.get("lastConnected"),
            "status": s.get("status", "disconnected"),
        }
        for s in remote_servers
    ]

async def add_server(config: dict) -> dict:
    server = {
        "id": str(uuid.uuid4()),
        "name": config.get("name") or config.get("host"),
        "host": config["host"],
        "port": config.get("port", 22),
        "username": config["username"],
        "password": config.get("password"),
        "privateKey": config.get("privateKey"),
        "privateKeyPath": config.get("privateKeyPath"),
        "logPath": config.get("logPath", "/var/log"),
        "watchFiles": config.get("watchFiles", "*.log"),
        "lastConnected": None,
        "status": "disconnected",
    }
    remote_servers.append(server)
    await _save_remote_servers()
    return server

async def update_server(id: str, updates: dict) -> dict | None:
    for i, s in enumerate(remote_servers):
        if s["id"] == id:
            remote_servers[i] = {**s, **updates, "id": id}
            await _save_remote_servers()
            return remote_servers[i]
    return None

async def delete_server(id: str) -> bool:
    global ssh_connections
    if id in ssh_connections:
        try:
            ssh_connections[id].close()
        except Exception:
            pass
        del ssh_connections[id]
    for i, s in enumerate(remote_servers):
        if s["id"] == id:
            remote_servers.pop(i)
            await _save_remote_servers()
            return True
    return False

async def test_connection(config: dict) -> dict:
    try:
        kwargs = {
            "host": config["host"],
            "port": config.get("port", 22),
            "username": config["username"],
            "known_hosts": None,
        }
        if config.get("privateKey"):
            kwargs["client_keys"] = [asyncssh.PKey.from_private_key(config["privateKey"])]
        elif config.get("privateKeyPath"):
            kwargs["client_keys"] = [config["privateKeyPath"]]
        elif config.get("password"):
            kwargs["password"] = config["password"]
        else:
            return {"success": False, "error": "需要密码或私钥"}

        async with asyncssh.connect(**kwargs) as conn:
            result = await conn.run(
                "uname -a && echo '---SEP---' && df -h / | tail -1 && echo '---SEP---' && free -m | grep Mem",
                timeout=10,
            )
            parts = result.stdout.split("---SEP---")
            return {
                "success": True,
                "info": {
                    "connected": True,
                    "system": parts[0].strip() if len(parts) > 0 else "Unknown",
                    "disk": parts[1].strip() if len(parts) > 1 else "",
                    "memory": parts[2].strip() if len(parts) > 2 else "",
                },
            }
    except Exception as e:
        return {"success": False, "error": str(e)}

async def connect_server(id: str) -> dict:
    if id in ssh_connections:
        try:
            ssh_connections[id].close()
        except Exception:
            pass
        del ssh_connections[id]

    server = next((s for s in remote_servers if s["id"] == id), None)
    if not server:
        raise HTTPException(status_code=404, detail="服务器不存在")

    try:
        kwargs = {
            "host": server["host"],
            "port": server.get("port", 22),
            "username": server["username"],
            "known_hosts": None,
        }
        if server.get("privateKey"):
            kwargs["client_keys"] = [asyncssh.PKey.from_private_key(server["privateKey"])]
        elif server.get("privateKeyPath"):
            kwargs["client_keys"] = [server["privateKeyPath"]]
        elif server.get("password"):
            kwargs["password"] = server["password"]

        conn = await asyncssh.connect(**kwargs)
        ssh_connections[id] = conn
        for s in remote_servers:
            if s["id"] == id:
                s["status"] = "connected"
                s["lastConnected"] = datetime.now().isoformat()
                break
        await _save_remote_servers()
        return {"success": True}
    except Exception as e:
        for s in remote_servers:
            if s["id"] == id:
                s["status"] = "error"
                break
        await _save_remote_servers()
        raise HTTPException(status_code=400, detail=str(e))

async def disconnect_server(id: str) -> None:
    if id in ssh_connections:
        ssh_connections[id].close()
        del ssh_connections[id]
    for s in remote_servers:
        if s["id"] == id:
            s["status"] = "disconnected"
            break
    await _save_remote_servers()

def _parse_df_size(s: str) -> int:
    s = s.strip()
    m = re.match(r"^([\d.]+)\s*([KMGTPE]?)(B?)", s, re.I)
    if not m:
        return 0
    num = float(m.group(1))
    unit = (m.group(2) or "").upper()
    mult = {"": 1, "K": 1024, "M": 1048576, "G": 1073741824, "T": 1099511627776, "P": 1125899906842624}
    return int(num * mult.get(unit, 1))

async def get_remote_system_stats(id: str) -> dict:
    conn = ssh_connections.get(id)
    if not conn:
        raise HTTPException(status_code=400, detail="服务器未连接")

    try:
        result = await conn.run("""
uname -snr && echo '---SEP---'
python3 -c "
import os, subprocess
# CPU
try:
    with open('/proc/stat') as f: line=f.readline()
    fields=line.split()[1:]; idle=sum(map(int,fields[3::4])); total=sum(map(int,fields))
    cpu=float(idle)/total*100 if total else 0
except: cpu=0
# Memory
try:
    with open('/proc/meminfo') as f: lines=f.readlines()
    mem={}
    for l in lines:
        k,v=l.split(':',1); mem[k.strip()]=int(v.split()[0])*1024
    total=mem.get('MemTotal',1); free=mem.get('MemFree',0)+mem.get('Buffers',0)+mem.get('Cached',0)
    used=total-free
    print(f'{used/total*100:.1f},{total},{used},{free}')
except: print('0,1,0,0')
# Disks
try:
    result=subprocess.run(['df','-B1','--output=source,target,size,used,pcent','-x','tmpfs','-x','devtmpfs','-x','overlay','-x','squashfs'],capture_output=True,text=True)
    for line in result.stdout.split('\\n')[1:]:
        if not line.strip(): continue
        parts=line.split()
        if len(parts)>=5:
            pct=parts[4].replace('%','')
            print(f'DISK:{parts[0]}:{parts[1]}:{parts[2]}:{parts[3]}:{pct}')
except: pass
# GPU
try:
    result=subprocess.run(['nvidia-smi','--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True)
    for line in result.stdout.strip().split('\\n'):
        if not line: continue
        p=[x.strip().replace('MiB','').replace('%','').replace('\\u00b0C','') for x in line.split(',')]
        if len(p)>=6: print(f'GPU:{p[0]}:{p[1]}:{p[2]}:{p[3]}:{p[4]}:{p[5]}')
except: pass
# Network
try:
    with open('/proc/net/dev') as f:
        for line in f.readlines()[2:]:
            parts=line.split(':')
            iface=parts[0].strip()
            if iface in ('lo','dummy','docker','br','veth','tun','tap','virbr',''): continue
            fields=parts[1].split()
            if len(fields)>=10:
                rx=int(fields[0]); tx=int(fields[8])
                print(f'NET:{iface}:{rx}:{tx}'); break
except: pass
# Top processes
try:
    result=subprocess.run(['ps','aux','--no-headers'],capture_output=True,text=True)
    lines=sorted(result.stdout.splitlines(),key=lambda x: float(x.split()[2].replace(',','.')) if len(x.split())>2 else 0,reverse=True)[:10]
    for l in lines:
        p=l.split(); print(f'PROC:{p[1]}:{p[10] if len(p)>10 else \"\"}:{p[2]}:{p[3]}')
except: pass
""", timeout=30, check=True)
        output = result.stdout

        cpu_load = 0.0
        mem_total, mem_used, mem_free = 1, 0, 0
        disks = []
        gpus = []
        network = []
        processes = []

        for line in output.split("\n"):
            line = line.strip()
            if not line:
                continue
            if "," in line and not line.startswith(("DISK", "GPU", "NET", "PROC")):
                parts = line.split(",")
                if len(parts) == 4:
                    cpu_load = float(parts[0])
                    mem_total = float(parts[1])
                    mem_used = float(parts[2])
                    mem_free = float(parts[3])
            elif line.startswith("DISK:"):
                p = line[5:].split(":")
                if len(p) >= 5:
                    disks.append({
                        "name": p[1] or "/",
                        "used": int(p[3]) if p[3].isdigit() else _parse_df_size(p[3]),
                        "total": int(p[2]) if p[2].isdigit() else _parse_df_size(p[2]),
                        "usePercent": float(p[4]) if p[4].replace(".", "").isdigit() else 0,
                    })
            elif line.startswith("GPU:"):
                p = line[4:].split(":")
                if len(p) >= 6:
                    gpus.append({
                        "index": int(p[0]),
                        "name": p[1],
                        "util": float(p[2]) if p[2] else 0,
                        "memUsed": float(p[3]) if p[3] else 0,
                        "memTotal": float(p[4]) if p[4] else 1,
                        "temp": float(p[5]) if p[5] else 0,
                    })
            elif line.startswith("NET:"):
                p = line[4:].split(":")
                if len(p) >= 3:
                    network.append({"iface": p[0], "rx": int(p[1]), "tx": int(p[2])})
            elif line.startswith("PROC:"):
                p = line[5:].split(":")
                if len(p) >= 4:
                    processes.append({
                        "pid": int(p[0]) if p[0].isdigit() else 0,
                        "name": p[1].split()[0] if p[1] else "",
                        "cpu": float(p[2]) if p[2] else 0,
                        "mem": float(p[3]) if p[3] else 0,
                    })

        return {
            "cpu": {"load": cpu_load, "cores": []},
            "memory": {"used": mem_used, "total": mem_total, "free": mem_free},
            "disk": disks,
            "network": network,
            "processes": processes,
            "gpus": gpus,
        }
    except Exception as e:
        return {"error": str(e)}

async def list_remote_files(id: str, sub_path: str = "") -> dict:
    conn = ssh_connections.get(id)
    if not conn:
        raise HTTPException(status_code=400, detail="服务器未连接")
    server = next((s for s in remote_servers if s["id"] == id), None)
    base = sub_path or (server.get("logPath") if server else "/var/log")
    try:
        result = await conn.run(
            f'find "{base}" -maxdepth 1 -printf "%f\\n%Y\\n%s\\n" 2>&1 | paste -d"\\n" - - -',
            timeout=10,
        )
        lines = [l for l in result.stdout.split("\n") if l.strip()]
        files, dirs = [], []
        for i in range(0, len(lines), 3):
            name = lines[i].strip() if i < len(lines) else ""
            ftype = lines[i + 1].strip() if i + 1 < len(lines) else ""
            size = int(lines[i + 2].strip()) if i + 2 < len(lines) and lines[i + 2].strip().isdigit() else 0
            if not name or name in (".", ".."):
                continue
            is_dir = ftype == "d"
            is_log = name.endswith(".log") or ".log." in name
            if is_dir:
                dirs.append({"name": name, "path": f"{base}/{name}"})
            else:
                files.append({"name": name, "path": f"{base}/{name}", "size": size, "isLog": is_log})
        files.sort(key=lambda x: (not x["isLog"], x["name"]))
        return {"files": files, "dirs": dirs, "currentPath": base}
    except Exception as e:
        return {"files": [], "dirs": [], "error": str(e)}

async def read_remote_file(id: str, file_path: str, lines: int = 200, search: str = "", level: str = "") -> dict:
    conn = ssh_connections.get(id)
    if not conn:
        raise HTTPException(status_code=400, detail="服务器未连接")
    try:
        if search:
            cmd = f'grep -i "{search}" "{file_path}" | tail -n {lines}'
        else:
            cmd = f'tail -n {lines} "{file_path}"'
        result = await conn.run(cmd, timeout=30)
        log_lines = [l for l in result.stdout.split("\n") if l.strip()]
        ts_re = re.compile(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})")
        lv_re = re.compile(r"\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL|CRITICAL)\b", re.I)
        logs = []
        for i, line in enumerate(log_lines):
            ts_m = ts_re.search(line)
            lv_m = lv_re.search(line)
            logs.append({
                "id": f"remote-{int(time.time()*1000)}-{i}",
                "timestamp": ts_m.group(1) if ts_m else datetime.now().isoformat(),
                "level": lv_m.group(1).upper() if lv_m else "INFO",
                "message": line,
                "source": os.path.basename(file_path),
                "metadata": json.dumps({"raw": line, "remote": True, "path": file_path}),
            })
        if level:
            logs = [l for l in logs if l["level"] == level]
        return {"logs": logs, "totalLines": len(log_lines)}
    except Exception as e:
        return {"logs": [], "error": str(e)}

async def read_remote_file_raw(id: str, file_path: str) -> dict:
    conn = ssh_connections.get(id)
    if not conn:
        return {"error": "服务器未连接"}
    try:
        result = await conn.run(f'cat "{file_path}"', timeout=30, check=True)
        return {"content": result.stdout}
    except Exception as e:
        return {"error": str(e)}

async def write_remote_file(id: str, file_path: str, content: str) -> dict:
    conn = ssh_connections.get(id)
    if not conn:
        return {"error": "服务器未连接"}
    try:
        b64 = base64.b64encode(content.encode()).decode()
        result = await conn.run(
            f'python3 -c "import sys,base64; open(\'{file_path}\',\'wb\').write(base64.b64decode(sys.stdin.read()))"',
            input=b64, timeout=30, check=True,
        )
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}

async def search_remote_logs(id: str, q: str, path: str = "", pattern: str = "*.log") -> dict:
    conn = ssh_connections.get(id)
    if not conn:
        raise HTTPException(status_code=400, detail="服务器未连接")
    server = next((s for s in remote_servers if s["id"] == id), None)
    search_path = path or (server.get("logPath") if server else "/var/log")
    try:
        result = await conn.run(
            f'find "{search_path}" -name "{pattern}" -type f 2>/dev/null | head -20',
            timeout=15,
        )
        files = [f for f in result.stdout.split("\n") if f.strip()]
        results = []
        for file in files[:10]:
            r = await conn.run(f'grep -n "{q}" "{file}" 2>/dev/null | head -50', timeout=20)
            for line in r.stdout.split("\n"):
                if not line.strip():
                    continue
                parts = line.split(":", 1)
                if len(parts) < 2:
                    continue
                line_num = int(parts[0]) if parts[0].isdigit() else 0
                content = parts[1]
                ts_m = re.search(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})", content)
                lv_m = re.search(r"\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b", content, re.I)
                results.append({
                    "file": file, "line": line_num, "content": content.strip(),
                    "timestamp": ts_m.group(1) if ts_m else "",
                    "level": lv_m.group(1).upper() if lv_m else "INFO",
                })
                if len(results) >= 500:
                    break
            if len(results) >= 500:
                break
        return {"results": results, "files": files, "total": len(results)}
    except Exception as e:
        return {"results": [], "error": str(e)}

async def exec_remote_command(id: str, command: str) -> dict:
    conn = ssh_connections.get(id)
    if not conn:
        raise HTTPException(status_code=400, detail="服务器未连接")
    try:
        result = await conn.run(command, timeout=30)
        return {"success": True, "stdout": result.stdout, "stderr": result.stderr, "exitCode": result.exit_status}
    except Exception as e:
        return {"success": False, "error": str(e)}

# Shell session per server
shell_sessions: dict[str, Any] = {}

async def create_shell_session(id: str, ws) -> Any:
    conn = ssh_connections.get(id)
    if not conn:
        raise HTTPException(status_code=400, detail="服务器未连接")
    chan, session = await conn.create_session(
        handler=lambda *args, **kwargs: None,
        term_type="xterm-256color", cols=120, rows=30,
    )
    shell_sessions[id] = session
    return session

# ─── Docker ───────────────────────────────────────────────────────────────────
async def ping_docker(source_id: str, config: dict) -> dict:
    try:
        import docker
        client = docker.DockerClient(
            base_url=f"tcp://{config.get('host','localhost')}:{config.get('port',2375)}"
        )
        client.ping()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

async def list_containers(source_id: str, config: dict) -> list[dict]:
    try:
        import docker
        client = docker.DockerClient(
            base_url=f"tcp://{config.get('host','localhost')}:{config.get('port',2375)}"
        )
        return [
            {
                "id": c.short_id,
                "name": c.name,
                "image": c.image.tags[0] if c.image.tags else c.image.short_id,
                "status": c.status,
                "state": c.attrs.get("State", {}).get("Status", ""),
                "created": c.attrs.get("Created", ""),
                "ports": [
                    {"private": bp.private_port, "public": bp.public_port or None, "type": bp.type}
                    for bp in (c.ports or [])
                ],
            }
            for c in client.containers.list(all=True)
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def get_container_logs(source_id: str, container_id: str, config: dict, tail: int = 200) -> list[dict]:
    try:
        import docker
        client = docker.DockerClient(
            base_url=f"tcp://{config.get('host','localhost')}:{config.get('port',2375)}"
        )
        try:
            container = client.containers.get(container_id)
        except docker.errors.NotFound:
            # 尝试短 ID
            for c in client.containers.list(all=True):
                if c.short_id.startswith(container_id):
                    container = c
                    break
            else:
                raise HTTPException(status_code=404, detail="容器不存在")
        logs_bytes = container.logs(tail=tail, timestamps=True, stdout=True, stderr=True)
        logs_str = logs_bytes.decode("utf-8", errors="replace")
        result = []
        for i, line in enumerate(logs_str.split("\n")):
            if not line.strip():
                continue
            ts_m = re.search(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})", line)
            lv_m = re.search(r"\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b", line, re.I)
            result.append({
                "timestamp": ts_m.group(1) if ts_m else "",
                "level": lv_m.group(1).upper() if lv_m else "INFO",
                "content": line,
                "containerId": container_id,
                "sourceId": source_id,
            })
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

async def docker_op(source_id: str, container_id: str, op: str, config: dict) -> dict:
    import docker
    client = docker.DockerClient(
        base_url=f"tcp://{config.get('host','localhost')}:{config.get('port',2375)}"
    )
    try:
        container = client.containers.get(container_id)
    except docker.errors.NotFound:
        for c in client.containers.list(all=True):
            if c.short_id.startswith(container_id):
                container = c
                break
        else:
            raise HTTPException(status_code=404, detail="容器不存在")
    method = getattr(container, op, None)
    if not method:
        raise HTTPException(status_code=400, detail=f"未知操作: {op}")
    method()
    return {"ok": True}

# ─── AI helpers ────────────────────────────────────────────────────────────────
async def call_llm(messages: list, stream: bool = False, thinking_enabled: bool = False):
    from openai import OpenAI
    s = ensure_settings()
    api_key = s.get("openaiApiKey", "")
    base_url = s.get("openaiBaseUrl", "http://localhost:11434/v1")
    model = s.get("model", "qwen3.5:9b")
    client = OpenAI(api_key=api_key or "ollama", base_url=base_url)
    return client.chat.completions.create(
        model=model, messages=messages, temperature=0.7, stream=stream,
    )

# ─── REST Routes ─────────────────────────────────────────────────────────────

@app.get("/api/logs")
async def get_logs(
    level: str = "", source: str = "", search: str = "",
    limit: int = Query(100), offset: int = Query(0),
):
    result = [l for l in logs]
    if level:
        result = [l for l in result if l["level"] == level]
    if source:
        result = [l for l in result if l["source"] == source]
    if search:
        sl = search.lower()
        result = [l for l in result if sl in l["message"].lower()]
    total = len(result)
    return {"logs": result[offset:offset + limit], "total": total}

@app.delete("/api/logs")
async def clear_logs():
    logs.clear()
    return {"success": True}

@app.get("/api/models/ollama")
async def get_ollama_models():
    s = ensure_settings()
    base_url = (s.get("openaiBaseUrl") or "http://localhost:11434/v1").replace("/v1", "")
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{base_url}/api/tags")
        if r.status_code == 200:
            data = r.json()
            return {"models": [m["name"] for m in data.get("models", [])]}
    except Exception:
        pass
    return {"models": [], "error": "无法连接到 Ollama"}

@app.post("/api/logs/analyze")
async def analyze_logs(body: dict):
    from openai import OpenAI
    s = ensure_settings()
    api_key = s.get("openaiApiKey", "")
    base_url = s.get("openaiBaseUrl", "http://localhost:11434/v1")
    model = s.get("model", "qwen3.5:9b")
    is_local = "localhost" in base_url or "127.0.0.1" in base_url
    if not api_key and not is_local:
        raise HTTPException(status_code=400, detail="API Key 未配置")
    if not model:
        raise HTTPException(status_code=400, detail="模型未配置")

    logs_list = body.get("logs", [])
    prompt = body.get("prompt") or f"""你是一个专业的运维工程师。请分析以下日志：

日志统计：
- 总日志数: {len(logs_list)}
- ERROR: {sum(1 for l in logs_list if l.get('level')=='ERROR')}
- WARN: {sum(1 for l in logs_list if l.get('level') in ('WARN','WARNING'))}
- INFO: {sum(1 for l in logs_list if l.get('level')=='INFO')}

日志内容：
{chr(10).join(f"[{l.get('timestamp','')}] [{l.get('level','')}] {l.get('message','')}" for l in logs_list[:100])}

请按以下格式回复：
## 🔍 分析摘要
## ⚠️ 发现的问题
## 💡 修复建议"""

    try:
        client = OpenAI(api_key=api_key or "ollama", base_url=base_url)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
        )
        return {"analysis": strip_thinking(resp.choices[0].message.content or "")}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/logs/generate-sample")
async def generate_sample():
    import random
    levels = ["INFO", "WARN", "ERROR", "DEBUG"]
    messages = [
        "Server started on port 3000", "Database connection established",
        "User login successful", "Request processed in 145ms",
        "Cache miss for key: user_123", "High memory usage detected: 85%",
        "Connection timeout to database", "Failed to parse JSON payload",
        "Rate limit exceeded for IP 192.168.1.1", "Scheduled task completed",
        "Memory leak detected", "SSL certificate expires in 7 days",
        "Disk usage above threshold: 90%", "API response time degraded: 2.5s",
    ]
    count = random.randint(5, 14)
    for _ in range(count):
        level = random.choice(levels)
        msg = random.choice(messages)
        entry = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "level": level,
            "message": f"{msg} [{uuid.uuid4().hex[:8]}]",
            "source": random.choice(["app.log", "access.log", "error.log", "system.log"]),
            "metadata": json.dumps({"generated": True}),
        }
        logs.insert(0, entry)
        await sio_broadcast({"type": "log", "data": entry})
    return {"success": True, "count": count}

# ─── Monitor ──────────────────────────────────────────────────────────────────

@app.get("/api/monitor/stats")
async def monitor_stats():
    try:
        cpu = psutil.cpu_percent(interval=0.5)
        mem = psutil.virtual_memory()
        disks = psutil.disk_usage("/")
        nets = psutil.net_io_counters(pernic=True)
        procs = sorted(psutil.process_iter(["pid", "name"]), key=lambda p: p.cpu_percent(), reverse=True)[:10]
        gpus = await _get_gpus()

        return {
            "cpu": {"load": cpu, "cores": []},
            "memory": {"used": mem.used, "total": mem.total, "free": mem.free},
            "disk": [{"name": d.mountpoint, "used": d.used, "total": d.total, "usePercent": d.percent}
                     for d in [psutil.disk_usage(p) for p in ["/"] if os.path.exists(p)] or [disks]],
            "network": [{"iface": k, "rx": v.bytes_recv, "tx": v.bytes_sent} for k, v in nets.items()],
            "processes": [{"pid": p.pid, "name": p.name(), "cpu": p.cpu_percent(), "mem": p.memory_percent()}
                          for p in procs[:10]],
            "gpus": gpus,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/monitor/history")
async def get_monitor_history(limit: int = Query(100)):
    return _monitor_history[:limit]

# ─── Settings ─────────────────────────────────────────────────────────────────

@app.get("/api/settings")
async def get_settings():
    return await ensure_settings_async()

@app.put("/api/settings")
async def update_settings(body: dict):
    s = await ensure_settings_async()
    s.update(body)
    await save_settings(s)
    # 重启日志监听
    if any(k in body for k in ("watchSources", "logPath", "watchFiles")):
        start_log_watcher()
    # 重启监控
    if "refreshInterval" in body:
        await start_monitor()
    return {"success": True, "settings": s}

# ─── Analysis ─────────────────────────────────────────────────────────────────

@app.get("/api/analysis/status")
async def analysis_status():
    return {
        "queues": {sid: {"pending": q["pending"], "running": q["running"]}
                   for sid, q in analysis_queues.items()},
        "totalPending": sum(len(q["pending"]) for q in analysis_queues.values()),
    }

@app.post("/api/analysis/trigger")
async def trigger_analysis(body: dict):
    msg = body.get("message", "")
    sid = body.get("sourceId", "manual")
    sname = body.get("sourceName", "手动触发")
    if not msg:
        raise HTTPException(status_code=400, detail="message required")
    log = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now().isoformat(),
        "level": "ERROR",
        "message": msg,
        "source": sname,
        "sourceId": sid,
        "metadata": json.dumps({"manual": True}),
    }
    source = {"id": sid, "name": sname, "autoAnalysis": True}
    _enqueue_analysis(log, source)
    return {"success": True, "message": "已加入分析队列", "log": log}

@app.get("/api/analysis/history")
async def get_analysis_history(
    sourceId: str = "", status: str = "",
    limit: int = Query(50), offset: int = Query(0),
):
    result = [r for r in analysis_history]
    if sourceId:
        result = [r for r in result if r["sourceId"] == sourceId]
    if status:
        result = [r for r in result if r["status"] == status]
    total = len(result)
    return {"records": result[offset:offset + limit], "total": total}

@app.delete("/api/analysis/history/{record_id}")
async def delete_analysis_record(record_id: str):
    for i, r in enumerate(analysis_history):
        if r["id"] == record_id:
            analysis_history.pop(i)
            return {"success": True}
    raise HTTPException(status_code=404, detail="记录不存在")

@app.delete("/api/analysis/history")
async def clear_analysis_history():
    analysis_history.clear()
    return {"success": True}

# ─── Chat ─────────────────────────────────────────────────────────────────────

@app.post("/api/chat")
async def chat(body: dict):
    messages = body.get("messages", [])
    if not messages:
        raise HTTPException(status_code=400, detail="messages required")
    s = await ensure_settings_async()
    api_key = s.get("openaiApiKey", "")
    base_url = s.get("openaiBaseUrl", "http://localhost:11434/v1")
    model = s.get("model", "qwen3.5:9b")
    is_local = "localhost" in base_url or "127.0.0.1" in base_url
    if not api_key and not is_local:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    if not model:
        raise HTTPException(status_code=400, detail="未配置模型")

    SYSTEM = {
        "role": "system",
        "content": "你是一个专业的运维工程师和技术支持助手。你的职责是：帮助运维人员排查服务器、网络、数据库、中间件等问题；提供清晰、可操作的解决方案；回复使用与用户相同的语言。",
    }
    thinking_filter = ThinkingStreamFilter()

    async def event_stream():
        from openai import OpenAI
        client = OpenAI(api_key=api_key or "ollama", base_url=base_url)
        try:
            stream = client.chat.completions.create(
                model=model, messages=[SYSTEM, *messages], temperature=0.7, stream=True,
            )
            for chunk in stream:
                raw = chunk.choices[0].delta.content or ""
                if raw:
                    content = thinking_filter.feed(raw)
                    if content:
                        yield f"data: {json.dumps({'content': content})}\n\n"
            remaining = thinking_filter.flush()
            if remaining:
                yield f"data: {json.dumps({'content': remaining})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

# ─── Docker Routes ────────────────────────────────────────────────────────────

@app.post("/api/docker/ping")
async def docker_ping(body: dict):
    return await ping_docker(body.get("sourceId", "local"), body.get("config", {}))

@app.get("/api/docker/containers")
async def docker_containers():
    s = await ensure_settings_async()
    sources = s.get("dockerSources", [])
    results = []
    for src in sources:
        if not src.get("enabled"):
            continue
        cfg = {
            "host": src.get("socketPath") and "localhost" or src.get("host", "localhost"),
            "port": src.get("port", 2375),
            "tls": src.get("tls", False),
        }
        try:
            containers = await list_containers(src["id"], cfg)
            results.append({"sourceId": src["id"], "sourceName": src["name"], "containers": containers})
        except Exception as e:
            results.append({"sourceId": src["id"], "sourceName": src["name"], "error": str(e), "containers": []})
    return {"sources": results}

@app.get("/api/docker/containers/{source_id}/{container_id}/logs")
async def container_logs(source_id: str, container_id: str, tail: int = Query(200)):
    s = await ensure_settings_async()
    src = next((x for x in s.get("dockerSources", []) if x["id"] == source_id), None)
    cfg = {"host": src and src.get("host", "localhost") or "localhost", "port": src and src.get("port", 2375) or 2375}
    logs = await get_container_logs(source_id, container_id, cfg, tail=tail)
    return {"logs": logs, "containerId": container_id, "sourceId": source_id}

@app.post("/api/docker/{source_id}/{container_id}/start")
async def start_container(source_id: str, container_id: str):
    s = await ensure_settings_async()
    src = next((x for x in s.get("dockerSources", []) if x["id"] == source_id), None)
    cfg = {"host": src and src.get("host", "localhost") or "localhost", "port": src and src.get("port", 2375) or 2375}
    return await docker_op(source_id, container_id, "start", cfg)

@app.post("/api/docker/{source_id}/{container_id}/stop")
async def stop_container(source_id: str, container_id: str):
    s = await ensure_settings_async()
    src = next((x for x in s.get("dockerSources", []) if x["id"] == source_id), None)
    cfg = {"host": src and src.get("host", "localhost") or "localhost", "port": src and src.get("port", 2375) or 2375}
    return await docker_op(source_id, container_id, "stop", cfg)

@app.post("/api/docker/{source_id}/{container_id}/restart")
async def restart_container(source_id: str, container_id: str):
    s = await ensure_settings_async()
    src = next((x for x in s.get("dockerSources", []) if x["id"] == source_id), None)
    cfg = {"host": src and src.get("host", "localhost") or "localhost", "port": src and src.get("port", 2375) or 2375}
    return await docker_op(source_id, container_id, "restart", cfg)

@app.delete("/api/docker/{source_id}/{container_id}")
async def remove_container(source_id: str, container_id: str):
    s = await ensure_settings_async()
    src = next((x for x in s.get("dockerSources", []) if x["id"] == source_id), None)
    cfg = {"host": src and src.get("host", "localhost") or "localhost", "port": src and src.get("port", 2375) or 2375}
    return await docker_op(source_id, container_id, "remove", cfg)

# ─── Remote Server Routes ────────────────────────────────────────────────────

@app.get("/api/remote/servers")
async def remote_servers_list():
    return {"servers": get_servers()}

@app.post("/api/remote/servers")
async def remote_add(body: dict):
    return {"success": True, "server": await add_server(body)}

@app.put("/api/remote/servers/{server_id}")
async def remote_update(server_id: str, body: dict):
    result = await update_server(server_id, body)
    if not result:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return {"success": True, "server": result}

@app.delete("/api/remote/servers/{server_id}")
async def remote_delete(server_id: str):
    ok = await delete_server(server_id)
    if not ok:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return {"success": True}

@app.post("/api/remote/test")
async def remote_test(body: dict):
    return await test_connection(body)

@app.post("/api/remote/servers/{server_id}/connect")
async def remote_connect(server_id: str):
    return await connect_server(server_id)

@app.post("/api/remote/servers/{server_id}/disconnect")
async def remote_disconnect(server_id: str):
    await disconnect_server(server_id)
    return {"success": True}

@app.get("/api/remote/servers/{server_id}/files")
async def remote_files(server_id: str, path: str = Query("")):
    return await list_remote_files(server_id, path)

@app.get("/api/remote/servers/{server_id}/logs")
async def remote_logs(
    server_id: str,
    file: str = Query(...), lines: int = Query(200),
    search: str = Query(""), level: str = Query(""),
):
    return await read_remote_file(server_id, file, lines=lines, search=search, level=level)

@app.get("/api/remote/servers/{server_id}/search")
async def remote_search(server_id: str, q: str = Query(...), path: str = Query(""), pattern: str = Query("*.log")):
    return await search_remote_logs(server_id, q, path=path, pattern=pattern)

@app.get("/api/remote/servers/{server_id}/file/read")
async def remote_file_read(server_id: str, path: str = Query(...)):
    return await read_remote_file_raw(server_id, path)

@app.post("/api/remote/servers/{server_id}/file/write")
async def remote_file_write(server_id: str, body: dict):
    return await write_remote_file(server_id, body.get("path", ""), body.get("content", ""))

@app.get("/api/remote/servers/{server_id}/stats")
async def remote_stats(server_id: str):
    return await get_remote_system_stats(server_id)

@app.post("/api/remote/servers/{server_id}/exec")
async def remote_exec(server_id: str, body: dict):
    cmd = body.get("command", "")
    if not cmd:
        raise HTTPException(status_code=400, detail="缺少命令")
    allowed = ["ls", "cat", "tail", "head", "grep", "find", "du", "df", "free", "top", "ps", "uptime", "date"]
    if cmd.split()[0] not in allowed:
        raise HTTPException(status_code=403, detail="命令不允许执行")
    return await exec_remote_command(server_id, cmd)

@app.post("/api/remote/servers/{server_id}/shell")
async def remote_shell(server_id: str, body: dict):
    cmd = body.get("command", "")
    if not cmd:
        raise HTTPException(status_code=400, detail="缺少命令")
    return await exec_remote_command(server_id, cmd)

# ─── Assistant memory ────────────────────────────────────────────────────────

@app.get("/api/assistant/memory")
async def get_memory():
    mem_dir = BASE_DIR / "assistant_memory"
    mem_dir.mkdir(exist_ok=True)
    files = []
    for f in sorted(mem_dir.glob("*.md"), key=lambda x: -x.stat().st_mtime):
        files.append({
            "name": f.stem,
            "path": str(f),
            "content": f.read_text(),
            "updatedAt": f.stat().st_mtime * 1000,
        })
    return {"files": files}

@app.post("/api/assistant/memory")
async def save_memory(body: dict):
    name = body.get("name", "").replace("/", "-").replace("\\", "-")
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    safe_name = re.sub(r"[^a-zA-Z0-9_\u4e00-\u9fa5-]", "-", name) + ".md"
    content = body.get("content", "")
    mem_dir = BASE_DIR / "assistant_memory"
    mem_dir.mkdir(exist_ok=True)
    (mem_dir / safe_name).write_text(content, encoding="utf-8")
    return {"success": True, "name": safe_name}

@app.delete("/api/assistant/memory/{name}")
async def delete_memory(name: str):
    mem_dir = BASE_DIR / "assistant_memory"
    f = mem_dir / f"{name}.md"
    if f.exists():
        f.unlink()
    return {"success": True}

# ─── Startup ─────────────────────────────────────────────────────────────────

async def startup():
    global settings
    await init_db()
    settings = await load_settings_async()
    print(f"[Settings] 已加载")
    await load_remote_servers()
    start_log_watcher()
    await start_monitor()
    print(f"🚀 OpenLog server (Python) running on http://localhost:3001")

# Mount socket.io on the FastAPI app
sio_app = _sio.ASGIApp(sio, other_asgi_app=app)

@sio.on("connect", namespace="/")
async def on_connect(sid, environ):
    print(f"Client connected: {sid}")

@sio.on("disconnect", namespace="/")
async def on_disconnect(sid):
    print(f"Client disconnected: {sid}")

@sio.on("message", namespace="/")
async def on_message(sid, data):
    pass

# Run with: uvicorn server:app --host 0.0.0.0 --port 3001 --reload
# or: python server.py
if __name__ == "__main__":
    import uvicorn
    asyncio.run(startup())
    uvicorn.run("server:app", host="0.0.0.0", port=3001, reload=False)
