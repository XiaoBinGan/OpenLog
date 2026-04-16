"""
OpenLog Python Backend — Complete Rewrite
对应 JS 版: server/index.js + server/remote.js + server/docker.js
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
from typing import Any, Optional, Set

import aiosqlite
import asyncssh
import psutil
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

load_dotenv()

# ─── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
SETTINGS_FILE = BASE_DIR / "settings.json"
SQLITE_PATH = DATA_DIR / "openlog.db"
REMOTE_CONFIG_PATH = BASE_DIR / "remote-servers.json"
ASSISTANT_MEMORY_DIR = BASE_DIR / "assistant_memory"
ASSISTANT_MEMORY_DIR.mkdir(exist_ok=True)

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

# ─── App & CORS ───────────────────────────────────────────────────────────────
app = FastAPI(title="OpenLog API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
            metadata TEXT,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS analysis_records (
            id TEXT PRIMARY KEY,
            log_record_id TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            diagnosis TEXT NOT NULL,
            suggestion TEXT,
            status TEXT DEFAULT 'pending',
            created_at INTEGER DEFAULT (strftime('%s','now')),
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS alert_configs (
            id TEXT PRIMARY KEY,
            machine_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            patterns TEXT NOT NULL DEFAULT '*.log',
            severity_filter TEXT DEFAULT 'error',
            keywords TEXT,
            webhook_url TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            updated_at INTEGER DEFAULT (strftime('%s','now')),
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER DEFAULT (strftime('%s','now'))
        );
    """)
    await db.commit()
    print(f"[DB] SQLite initialized: {SQLITE_PATH}")

async def kv_get(key: str) -> Any:
    if not db:
        return None
    async with db.execute("SELECT value FROM kv_store WHERE key=?", (key,)) as cur:
        row = await cur.fetchone()
        if row:
            try:
                return json.loads(row[0])
            except:
                return row[0]
    return None

async def kv_set(key: str, value: Any) -> None:
    if not db:
        return
    str_val = json.dumps(value) if not isinstance(value, str) else value
    now = int(time.time())
    await db.execute(
        "INSERT INTO kv_store(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, str_val, now),
    )
    await db.commit()

# ─── Settings ─────────────────────────────────────────────────────────────────
settings: dict[str, Any] = {}

async def load_settings() -> dict:
    global settings
    stored = await kv_get("app_settings")
    if stored and isinstance(stored, dict):
        settings = {**DEFAULT_SETTINGS, **stored}
    else:
        settings = DEFAULT_SETTINGS.copy()
    return settings

async def save_settings() -> None:
    await kv_set("app_settings", settings)

def ensure_settings() -> dict:
    return settings or DEFAULT_SETTINGS

# ─── Thinking Stream Filter ───────────────────────────────────────────────────
class ThinkingStreamFilter:
    """逐 token 过滤 <think/> 块"""
    def __init__(self):
        self.in_think = False
        self.buffer = ""

    def feed(self, content: str) -> str:
        if ensure_settings().get("thinkingEnabled"):
            return content
        output = ""
        if self.buffer:
            content = self.buffer + content
            self.buffer = ""
        i = 0
        while i < len(content):
            if self.in_think:
                close_idx = content.find("</think>", i)
                if close_idx != -1:
                    self.in_think = False
                    i = close_idx + 8
                    continue
                i = len(content)
                break
            else:
                open_idx = content.find("<think", i)
                if open_idx == -1:
                    output += content[i:]
                    break
                output += content[i:open_idx]
                tag_end = content.find(">", open_idx)
                if tag_end != -1:
                    self.in_think = True
                    i = tag_end + 1
                    continue
                self.buffer = content[open_idx:]
                break
        return output

    def flush(self) -> str:
        if ensure_settings().get("thinkingEnabled"):
            return self.buffer
        if self.in_think:
            self.buffer = ""
            return ""
        remaining = self.buffer
        self.buffer = ""
        return remaining

# ─── WebSocket Clients ────────────────────────────────────────────────────────
ws_clients: Set[WebSocket] = set()

async def broadcast(data: dict) -> None:
    message = json.dumps(data)
    dead_clients = set()
    for client in ws_clients:
        try:
            await client.send_text(message)
        except:
            dead_clients.add(client)
    for client in dead_clients:
        ws_clients.discard(client)

# ─── Logs Storage ─────────────────────────────────────────────────────────────
logs: list[dict] = []

# ─── File Watcher ─────────────────────────────────────────────────────────────
watchers: dict[str, asyncio.Task] = {}
file_offsets: dict[str, int] = {}

async def read_last_line(file_path: str, source_id: str) -> dict | None:
    try:
        stat = os.stat(file_path)
        size = stat.st_size
        last_pos = file_offsets.get(file_path, 0)
        if size < last_pos:
            file_offsets[file_path] = 0
            last_pos = 0
        if size == last_pos:
            return None
        with open(file_path, 'rb') as f:
            f.seek(last_pos)
            data = f.read(min(size - last_pos, 512 * 1024))
            file_offsets[file_path] = size
        content = data.decode('utf-8', errors='ignore')
        lines = [l for l in content.split('\n') if l.strip()]
        if not lines:
            return None
        return {"lastLine": lines[-1], "sourceId": source_id}
    except Exception as e:
        print(f"[{source_id}] Read error: {e}")
        return None

def parse_log_line(line: str, source: str) -> dict:
    ts_match = re.match(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})", line)
    level_match = re.search(r"\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b", line, re.I)
    return {
        "id": str(uuid.uuid4()),
        "timestamp": ts_match.group(1) if ts_match else datetime.now().isoformat(),
        "level": level_match.group(1).upper() if level_match else "INFO",
        "message": line,
        "source": source,
        "metadata": json.dumps({"raw": line}),
    }

async def start_log_watcher():
    # Stop existing watchers
    for task in watchers.values():
        task.cancel()
    watchers.clear()
    file_offsets.clear()
    
    sources = ensure_settings().get("watchSources", [])
    if not sources:
        sources = [{
            "id": "default",
            "name": "默认服务",
            "path": ensure_settings().get("logPath", str(Path.home() / "logs")),
            "pattern": ensure_settings().get("watchFiles", "*.log"),
            "enabled": True,
            "autoAnalysis": ensure_settings().get("autoAnalysis", True),
        }]
    
    for source in sources:
        if not source.get("enabled", True):
            print(f"[{source['id']}] 跳过（已禁用）")
            continue
        task = asyncio.create_task(watch_source(source))
        watchers[source["id"]] = task

async def watch_source(source: dict):
    log_dir = Path(source["path"])
    pattern = source.get("pattern", "*.log")
    sid = source["id"]
    
    if not log_dir.exists():
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            print(f"[{sid}] Created directory: {log_dir}")
        except Exception as e:
            print(f"[{sid}] Failed to create directory: {e}")
            return
    
    # Initial scan
    for f in log_dir.glob(pattern):
        if f.is_file():
            file_offsets[str(f)] = 0
    
    print(f"[{sid}] 🚀 开始监听: {log_dir} ({pattern})")
    
    while True:
        try:
            for f in log_dir.glob(pattern):
                if f.is_file():
                    result = await read_last_line(str(f), sid)
                    if result:
                        log_entry = parse_log_line(result["lastLine"], f"{source['name']}/{f.name}")
                        log_entry["sourceId"] = sid
                        logs.insert(0, log_entry)
                        if len(logs) > 10000:
                            logs.pop()
                        await broadcast({"type": "log", "data": log_entry})
                        # Auto analysis
                        if log_entry["level"] in ("ERROR", "FATAL") and source.get("autoAnalysis", True):
                            enqueue_analysis(log_entry, source)
            await asyncio.sleep(2)
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[{sid}] Watcher error: {e}")
            await asyncio.sleep(2)

# ─── AI Analysis ──────────────────────────────────────────────────────────────
analysis_queues: dict[str, dict] = {}
analysis_debounce: dict[str, float] = {}
DEBOUNCE_MS = 30000
analysis_history: list[dict] = []
MAX_ANALYSIS_HISTORY = 500

def get_queue(source_id: str) -> dict:
    if source_id not in analysis_queues:
        analysis_queues[source_id] = {"running": False, "pending": []}
    return analysis_queues[source_id]

def enqueue_analysis(log: dict, source: dict):
    source_id = source.get("id", "default")
    q = get_queue(source_id)
    key = f"{source_id}:{log['message'][:120]}"
    now = time.time() * 1000
    if key in analysis_debounce:
        if now - analysis_debounce[key] < DEBOUNCE_MS:
            print(f"[{source_id}] ⏭️ 防抖跳过: {log['message'][:60]}")
            return
    analysis_debounce[key] = now
    q["pending"].append({"log": log, "source": source})
    print(f"[{source_id}] 📋 加入分析队列 (待处理: {len(q['pending'])})")
    asyncio.create_task(process_queue(source_id))

async def process_queue(source_id: str):
    q = get_queue(source_id)
    if q["running"] or not q["pending"]:
        return
    q["running"] = True
    item = q["pending"].pop(0)
    try:
        await run_analysis(item["log"], item["source"])
    finally:
        q["running"] = False
        if q["pending"]:
            asyncio.create_task(process_queue(source_id))

async def run_analysis(error_log: dict, source: dict):
    source_id = source.get("id", "default")
    print(f"[{source_id}] 🤖 开始分析: {error_log['message'][:80]}")
    
    api_key = ensure_settings().get("openaiApiKey", "")
    base_url = ensure_settings().get("openaiBaseUrl", "http://localhost:11434/v1")
    model = ensure_settings().get("model", "qwen3.5:9b")
    is_local = "localhost" in base_url or "127.0.0.1" in base_url
    
    if not api_key and not is_local:
        await broadcast({"type": "ai_analysis", "status": "skipped", "message": "未配置 LLM", "log": error_log, "sourceId": source_id})
        return
    if not model:
        await broadcast({"type": "ai_analysis", "status": "skipped", "message": "未配置模型", "log": error_log, "sourceId": source_id})
        return
    
    await broadcast({"type": "ai_analysis", "status": "pending", "log": error_log, "sourceId": source_id})
    
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key or "ollama", base_url=base_url)
        
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
        
        response = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            timeout=60,
        )
        
        analysis = response.choices[0].message.content
        if not ensure_settings().get("thinkingEnabled", False):
            analysis = re.sub(r"<think\b[^>]*>[\s\S]*?</think>", "", analysis).strip()
        
        print(f"[{source_id}] ✅ 分析完成")
        
        record = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "sourceId": source_id,
            "sourceName": source.get("name", source_id),
            "log": error_log,
            "analysis": analysis,
            "status": "done",
            "model": model,
        }
        analysis_history.insert(0, record)
        if len(analysis_history) > MAX_ANALYSIS_HISTORY:
            analysis_history.pop()
        
        await broadcast({"type": "ai_analysis", "status": "done", "log": error_log, "sourceId": source_id, "analysis": analysis, "recordId": record["id"]})
    except Exception as e:
        print(f"[{source_id}] 分析失败: {e}")
        record = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "sourceId": source_id,
            "sourceName": source.get("name", source_id),
            "log": error_log,
            "analysis": None,
            "status": "error",
            "error": str(e),
            "model": model,
        }
        analysis_history.insert(0, record)
        if len(analysis_history) > MAX_ANALYSIS_HISTORY:
            analysis_history.pop()
        await broadcast({"type": "ai_analysis", "status": "error", "message": str(e), "log": error_log, "sourceId": source_id, "recordId": record["id"]})

# ─── Monitor ──────────────────────────────────────────────────────────────────
monitor_history: list[dict] = []
monitor_task: asyncio.Task | None = None

async def start_monitor():
    global monitor_task
    if monitor_task:
        monitor_task.cancel()
    interval_ms = int(ensure_settings().get("refreshInterval", 5000))
    monitor_task = asyncio.create_task(monitor_loop(interval_ms))

async def monitor_loop(interval_ms: int):
    while True:
        try:
            cpu = psutil.cpu_percent(interval=0.5)
            mem = psutil.virtual_memory()
            disks = psutil.disk_usage("/")
            nets = psutil.net_io_counters(pernic=True)
            
            # Safe process iteration (macOS kernel_task fix)
            def safe_cpu(p):
                try:
                    return p.cpu_percent()
                except:
                    return -1.0
            
            procs = sorted(
                [p for p in psutil.process_iter(["pid", "name"]) if p.pid != 0],
                key=safe_cpu,
                reverse=True,
            )[:10]
            
            # GPU
            gpus = []
            try:
                out = subprocess.check_output(
                    "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits",
                    shell=True, timeout=3,
                ).decode().strip()
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
            except:
                pass
            
            stats = {
                "timestamp": datetime.now().isoformat(),
                "cpu": {"load": cpu, "cores": []},
                "memory": {"used": mem.used, "total": mem.total, "free": mem.free},
                "disk": [{"name": "/", "used": disks.used, "total": disks.total, "usePercent": disks.percent}],
                "network": [{"iface": k, "rx": v.bytes_recv, "tx": v.bytes_sent} for k, v in (nets or {}).items()],
                "processes": [{"pid": p.pid, "name": p.name(), "cpu": max(safe_cpu(p), 0), "mem": p.memory_percent()} for p in procs],
                "gpus": gpus,
            }
            
            monitor_history.insert(0, stats)
            if len(monitor_history) > 1000:
                monitor_history.pop()
            
            await broadcast({"type": "monitor", "data": stats})
        except Exception as e:
            print(f"Monitor error: {e}")
        await asyncio.sleep(interval_ms / 1000)

# ─── Remote Servers ───────────────────────────────────────────────────────────
ssh_connections: dict[str, asyncssh.SSHClientConnection] = {}
remote_servers: list[dict] = []

async def load_remote_servers():
    global remote_servers
    stored = await kv_get("remote_servers")
    if stored and isinstance(stored, list):
        remote_servers = stored
        for s in remote_servers:
            if "password" in s and s["password"]:
                try:
                    s["password"] = base64.b64decode(s["password"]).decode()
                except:
                    pass
    print(f"[Remote] 从 SQLite 加载了 {len(remote_servers)} 台服务器")

async def save_remote_servers():
    to_save = []
    for s in remote_servers:
        copy = dict(s)
        if "password" in copy and copy["password"]:
            copy["password"] = base64.b64encode(copy["password"].encode()).decode()
        to_save.append(copy)
    await kv_set("remote_servers", to_save)

def get_servers() -> list[dict]:
    return [{k: v for k, v in s.items() if k != "password"} for s in remote_servers]

async def connect_server(server_id: str) -> dict:
    server = next((s for s in remote_servers if s["id"] == server_id), None)
    if not server:
        raise HTTPException(status_code=404, detail="服务器不存在")
    
    if server_id in ssh_connections:
        await disconnect_server(server_id)
    
    try:
        conn = await asyncssh.connect(
            host=server["host"],
            port=server.get("port", 22),
            username=server["username"],
            password=server.get("password"),
            client_keys=[server["privateKey"]] if server.get("privateKey") else None,
            known_hosts=None,
        )
        ssh_connections[server_id] = conn
        server["status"] = "connected"
        server["lastConnected"] = datetime.now().isoformat()
        await save_remote_servers()
        return {"success": True}
    except Exception as e:
        server["status"] = "error"
        await save_remote_servers()
        raise HTTPException(status_code=400, detail=str(e))

async def disconnect_server(server_id: str):
    if server_id in ssh_connections:
        try:
            ssh_connections[server_id].close()
            await ssh_connections[server_id].wait_closed()
        except:
            pass
        del ssh_connections[server_id]
    server = next((s for s in remote_servers if s["id"] == server_id), None)
    if server:
        server["status"] = "disconnected"
        await save_remote_servers()

async def get_remote_system_stats(server_id: str) -> dict:
    if server_id not in ssh_connections:
        return {"cpu": {}, "memory": {}, "disk": [], "gpus": [], "network": [], "processes": [], "uptime": 0, "connected": False}
    
    conn = ssh_connections[server_id]
    try:
        result = await conn.run("""
uname -snr && echo '---SEP---'
python3 -c "
import os, subprocess
try:
    with open('/proc/stat') as f: line=f.readline()
    fields=line.split()[1:]; idle=sum(map(int,fields[3::4])); total=sum(map(int,fields))
    cpu=float(idle)/total*100 if total else 0
except: cpu=0
try:
    with open('/proc/meminfo') as f: lines=f.readlines()
    mem={}
    for l in lines:
        k,v=l.split(':',1); mem[k.strip()]=int(v.split()[0])*1024
    total=mem.get('MemTotal',1); free=mem.get('MemFree',0)+mem.get('Buffers',0)+mem.get('Cached',0)
    used=total-free
    print(f'{used/total*100:.1f},{total},{used},{free}')
except: print('0,1,0,0')
try:
    result=subprocess.run(['df','-B1','--output=source,target,size,used,pcent','-x','tmpfs','-x','devtmpfs','-x','overlay','-x','squashfs'],capture_output=True,text=True)
    for line in result.stdout.split('\\n')[1:]:
        if not line.strip(): continue
        parts=line.split()
        if len(parts)>=5:
            pct=parts[4].replace('%','')
            print(f'DISK:{parts[0]}:{parts[1]}:{parts[2]}:{parts[3]}:{pct}')
except: pass
try:
    result=subprocess.run(['nvidia-smi','--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True)
    for line in result.stdout.strip().split('\\n'):
        if not line: continue
        p=[x.strip().replace('MiB','').replace('%','').replace('\\u00b0C','') for x in line.split(',')]
        if len(p)>=6: print(f'GPU:{p[0]}:{p[1]}:{p[2]}:{p[3]}:{p[4]}:{p[5]}')
except: pass
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
try:
    result=subprocess.run(['ps','aux','--no-headers'],capture_output=True,text=True)
    lines=sorted(result.stdout.splitlines(),key=lambda x: float(x.split()[2].replace(',','.')) if len(x.split())>2 else 0,reverse=True)[:10]
    for l in lines:
        p=l.split(); print(f'PROC:{p[1]}:{p[10] if len(p)>10 else \"\"}:{p[2]}:{p[3]}')
except: pass
"
""", timeout=30)
        
        if result.exit_status != 0:
            return {"error": result.stderr or "命令执行失败"}
        
        output = result.stdout
        cpu_load, mem_total, mem_used, mem_free = 0, 1, 0, 0
        disks, gpus, network, processes = [], [], [], []
        
        for line in output.split("\n"):
            line = line.strip()
            if not line:
                continue
            if "," in line and not line.startswith(("DISK:", "GPU:", "NET:", "PROC:")):
                parts = line.split(",")
                if len(parts) == 4:
                    cpu_load = float(parts[0])
                    mem_total = float(parts[1])
                    mem_used = float(parts[2])
                    mem_free = float(parts[3])
            elif line.startswith("DISK:"):
                p = line[5:].split(":")
                if len(p) >= 5:
                    disks.append({"name": p[1] or "/", "used": int(p[3]) if p[3].isdigit() else 0, "total": int(p[2]) if p[2].isdigit() else 1, "usePercent": float(p[4]) if p[4].replace(".", "").isdigit() else 0})
            elif line.startswith("GPU:"):
                p = line[4:].split(":")
                if len(p) >= 6:
                    gpus.append({"index": int(p[0]), "name": p[1], "util": float(p[2]) if p[2] else 0, "memUsed": float(p[3]) if p[3] else 0, "memTotal": float(p[4]) if p[4] else 1, "temp": float(p[5]) if p[5] else 0})
            elif line.startswith("NET:"):
                p = line[4:].split(":")
                if len(p) >= 3:
                    network.append({"iface": p[0], "rx": int(p[1]), "tx": int(p[2])})
            elif line.startswith("PROC:"):
                p = line[5:].split(":")
                if len(p) >= 4:
                    processes.append({"pid": int(p[0]), "name": p[1], "cpu": float(p[2]), "mem": float(p[3])})
        
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

async def list_remote_files(server_id: str, sub_path: str = "") -> dict:
    if server_id not in ssh_connections:
        return {"files": [], "dirs": [], "currentPath": sub_path or "/tmp", "connected": False}
    
    conn = ssh_connections[server_id]
    server = next((s for s in remote_servers if s["id"] == server_id), None)
    base = sub_path or (server.get("logPath") if server else "/var/log")
    
    try:
        result = await conn.run(f'find "{base}" -maxdepth 1 -printf "%f\\n%Y\\n%s\\n" 2>&1 | paste -d"\\n" - - -', timeout=10)
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

# ─── API Routes ───────────────────────────────────────────────────────────────

@app.get("/api/logs")
async def get_logs(level: str = "", source: str = "", search: str = "", limit: int = 100, offset: int = 0):
    result = logs[:]
    if level:
        result = [l for l in result if l["level"] == level]
    if source:
        result = [l for l in result if l["source"] == source]
    if search:
        search_lower = search.lower()
        result = [l for l in result if search_lower in l["message"].lower()]
    total = len(result)
    result = result[offset:offset + limit]
    return {"logs": result, "total": total}

@app.delete("/api/logs")
async def clear_logs():
    logs.clear()
    return {"success": True}

@app.get("/api/logs/files")
async def get_log_files():
    log_path = Path(ensure_settings().get("logPath", Path.home() / "logs"))
    if not log_path.exists():
        return []
    try:
        return [{"name": f.name, "path": str(f), "size": f.stat().st_size} for f in log_path.glob("*.log")]
    except:
        return []

@app.post("/api/logs/analyze")
async def analyze_logs(body: dict):
    analyze_logs_data = body.get("logs", [])
    prompt = body.get("prompt", "")
    # Simplified - just return placeholder
    return {"analysis": "AI analysis placeholder"}

@app.post("/api/logs/fix")
async def fix_logs(body: dict):
    return {"fix": "Fix placeholder", "warning": "⚠️ 重要：在应用任何修复前，请务必备份原文件并在测试环境验证！"}

@app.post("/api/logs/generate-sample")
async def generate_sample_logs():
    levels = ["INFO", "WARN", "ERROR", "DEBUG"]
    messages = [
        "Server started on port 3000",
        "Database connection established",
        "User login successful",
        "Request processed in 145ms",
        "Cache miss for key: user_123",
        "High memory usage detected: 85%",
        "Connection timeout to database",
        "Failed to parse JSON payload",
        "Rate limit exceeded for IP 192.168.1.1",
        "Scheduled task completed",
        "Memory leak detected",
        "SSL certificate expires in 7 days",
        "Disk usage above threshold: 90%",
        "API response time degraded: 2.5s",
    ]
    count = 5 + (int(time.time()) % 10)
    for _ in range(count):
        level = levels[int(time.time() * 1000) % len(levels)]
        msg = messages[int(time.time() * 1000) % len(messages)]
        entry = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now().isoformat(),
            "level": level,
            "message": f"{msg} [{uuid.uuid4().hex[:8]}]",
            "source": ["app.log", "access.log", "error.log", "system.log"][int(time.time() * 1000) % 4],
            "metadata": json.dumps({"generated": True}),
        }
        logs.insert(0, entry)
        await broadcast({"type": "log", "data": entry})
    return {"success": True, "count": count}

@app.get("/api/monitor/stats")
async def get_monitor_stats():
    if not monitor_history:
        return {"cpu": {"load": 0, "cores": []}, "memory": {"used": 0, "total": 1, "free": 0}, "disk": [], "network": [], "processes": [], "gpus": []}
    return monitor_history[0]

@app.get("/api/monitor/history")
async def get_monitor_history(limit: int = 100):
    return monitor_history[:limit]

@app.get("/api/settings")
async def get_settings():
    return ensure_settings()

@app.put("/api/settings")
async def update_settings(body: dict):
    global settings
    settings.update(body)
    await save_settings()
    if any(k in body for k in ("watchSources", "logPath", "watchFiles")):
        await start_log_watcher()
    if "refreshInterval" in body:
        await start_monitor()
    return {"success": True, "settings": settings}

@app.get("/api/analysis/status")
async def get_analysis_status():
    result = {}
    for source_id, q in analysis_queues.items():
        result[source_id] = {"pending": len(q["pending"]), "running": q["running"]}
    total_pending = sum(len(q["pending"]) for q in analysis_queues.values())
    return {"queues": result, "totalPending": total_pending}

@app.post("/api/analysis/trigger")
async def trigger_analysis(body: dict):
    message = body.get("message", "")
    source_id = body.get("sourceId", "manual")
    source_name = body.get("sourceName", "手动触发")
    if not message:
        raise HTTPException(status_code=400, detail="message required")
    log = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now().isoformat(),
        "level": "ERROR",
        "message": message,
        "source": source_name,
        "sourceId": source_id,
        "metadata": json.dumps({"manual": True}),
    }
    enqueue_analysis(log, {"id": source_id, "name": source_name, "autoAnalysis": True})
    return {"success": True, "message": "已加入分析队列", "log": log}

@app.get("/api/analysis/history")
async def get_analysis_history(sourceId: str = "", status: str = "", limit: int = 50, offset: int = 0):
    result = analysis_history[:]
    if sourceId:
        result = [r for r in result if r.get("sourceId") == sourceId]
    if status:
        result = [r for r in result if r.get("status") == status]
    total = len(result)
    result = result[offset:offset + limit]
    return {"records": result, "total": total}

@app.delete("/api/analysis/history/{record_id}")
async def delete_analysis_record(record_id: str):
    idx = next((i for i, r in enumerate(analysis_history) if r.get("id") == record_id), -1)
    if idx != -1:
        analysis_history.pop(idx)
        return {"success": True}
    raise HTTPException(status_code=404, detail="记录不存在")

@app.delete("/api/analysis/history")
async def clear_analysis_history():
    analysis_history.clear()
    return {"success": True}

@app.get("/api/assistant/memory")
async def get_assistant_memory():
    try:
        files = []
        for f in sorted(ASSISTANT_MEMORY_DIR.glob("*.md"), key=lambda x: -x.stat().st_mtime):
            files.append({
                "name": f.stem,
                "path": str(f),
                "content": f.read_text(),
                "updatedAt": f.stat().st_mtime * 1000,
            })
        return {"files": files}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/assistant/memory")
async def save_assistant_memory(body: dict):
    name = body.get("name", "")
    content = body.get("content", "")
    if not name or content is None:
        raise HTTPException(status_code=400, detail="name and content required")
    safe_name = re.sub(r"[^a-zA-Z0-9_\u4e00-\u9fa5-]", "-", name).replace(".md", "") + ".md"
    file_path = ASSISTANT_MEMORY_DIR / safe_name
    try:
        file_path.write_text(content, encoding="utf-8")
        return {"success": True, "name": safe_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/assistant/memory/{name}")
async def delete_assistant_memory(name: str):
    file_path = ASSISTANT_MEMORY_DIR / (name + ".md")
    try:
        if file_path.exists():
            file_path.unlink()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat")
async def chat(body: dict):
    messages = body.get("messages", [])
    if not messages:
        raise HTTPException(status_code=400, detail="messages required")
    
    api_key = ensure_settings().get("openaiApiKey", "")
    base_url = ensure_settings().get("openaiBaseUrl", "http://localhost:11434/v1")
    model = ensure_settings().get("model", "qwen3.5:9b")
    is_local = "localhost" in base_url or "127.0.0.1" in base_url
    
    if not api_key and not is_local:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    if not model:
        raise HTTPException(status_code=400, detail="未配置模型")
    
    async def generate():
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=api_key or "ollama", base_url=base_url)
            
            system_prompt = {
                "role": "system",
                "content": "你是一个专业的运维工程师和技术支持助手。你的职责是帮助运维人员排查服务器、网络、数据库、中间件等问题，提供清晰、可操作的解决方案。"
            }
            
            stream = await client.chat.completions.create(
                model=model,
                messages=[system_prompt] + messages,
                temperature=0.7,
                stream=True,
                timeout=120,
            )
            
            thinking_filter = ThinkingStreamFilter()
            async for chunk in stream:
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
    
    return StreamingResponse(generate(), media_type="text/event-stream")

# Remote Servers API
@app.get("/api/remote/servers")
async def get_remote_servers():
    return {"servers": get_servers()}

@app.post("/api/remote/servers")
async def add_remote_server(body: dict):
    server = {
        "id": str(uuid.uuid4()),
        "name": body.get("name") or body.get("host"),
        "host": body["host"],
        "port": body.get("port", 22),
        "username": body["username"],
        "password": body.get("password"),
        "privateKey": body.get("privateKey"),
        "logPath": body.get("logPath", "/var/log"),
        "watchFiles": body.get("watchFiles", "*.log"),
        "lastConnected": None,
        "status": "disconnected",
    }
    remote_servers.append(server)
    await save_remote_servers()
    return {"success": True, "server": {k: v for k, v in server.items() if k != "password"}}

@app.put("/api/remote/servers/{server_id}")
async def update_remote_server(server_id: str, body: dict):
    for i, s in enumerate(remote_servers):
        if s["id"] == server_id:
            remote_servers[i] = {**s, **body, "id": server_id}
            await save_remote_servers()
            return {"success": True, "server": {k: v for k, v in remote_servers[i].items() if k != "password"}}
    raise HTTPException(status_code=404, detail="服务器不存在")

@app.delete("/api/remote/servers/{server_id}")
async def delete_remote_server(server_id: str):
    for i, s in enumerate(remote_servers):
        if s["id"] == server_id:
            await disconnect_server(server_id)
            remote_servers.pop(i)
            await save_remote_servers()
            return {"success": True}
    raise HTTPException(status_code=404, detail="服务器不存在")

@app.post("/api/remote/test")
async def test_remote_connection(body: dict):
    # Simplified test
    return {"success": True, "info": {"connected": True, "system": "Test OK"}}

@app.post("/api/remote/servers/{server_id}/connect")
async def api_connect_server(server_id: str):
    return await connect_server(server_id)

@app.post("/api/remote/servers/{server_id}/disconnect")
async def api_disconnect_server(server_id: str):
    await disconnect_server(server_id)
    return {"success": True}

@app.get("/api/remote/servers/{server_id}/files")
async def api_list_remote_files(server_id: str, path: str = ""):
    return await list_remote_files(server_id, path)

@app.get("/api/remote/servers/{server_id}/stats")
async def api_get_remote_stats(server_id: str):
    return await get_remote_system_stats(server_id)

# Docker API (placeholders)
@app.post("/api/docker/ping")
async def docker_ping(body: dict):
    return {"success": False, "error": "Docker not implemented in Python backend"}

@app.get("/api/docker/containers")
async def docker_containers():
    return {"sources": []}

# WebSocket Endpoints
@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    ws_clients.add(websocket)
    print(f"[WS] Client connected, total: {len(ws_clients)}")
    try:
        while True:
            data = await websocket.receive_text()
            # Echo back or handle commands
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(websocket)
        print(f"[WS] Client disconnected, total: {len(ws_clients)}")

@app.websocket("/ws/shell/{server_id}")
async def ws_shell_endpoint(websocket: WebSocket, server_id: str):
    await websocket.accept()
    print(f"[WS Shell] Connection for server: {server_id}")
    
    if server_id not in ssh_connections:
        await websocket.send_text(json.dumps({"type": "shell_error", "error": "服务器未连接"}))
        await websocket.close()
        return
    
    conn = ssh_connections[server_id]
    try:
        # Create interactive shell
        process = await conn.create_process(
            "/bin/bash",
            term_type="xterm-256color",
            term_size=(120, 30),
        )
        
        async def read_output():
            async for line in process.stdout:
                if websocket.client_state.CONNECTED:
                    await websocket.send_text(json.dumps({"type": "shell_output", "data": line}))
        
        read_task = asyncio.create_task(read_output())
        
        try:
            while True:
                msg = await websocket.receive_text()
                data = json.loads(msg)
                if data.get("type") == "input":
                    process.stdin.write(data.get("data", ""))
                elif data.get("type") == "resize":
                    process.change_terminal_size(data.get("rows", 30), data.get("cols", 120))
        except WebSocketDisconnect:
            pass
        finally:
            read_task.cancel()
            try:
                await read_task
            except asyncio.CancelledError:
                pass
            process.close()
            
    except Exception as e:
        print(f"[WS Shell] Error: {e}")
        try:
            await websocket.send_text(json.dumps({"type": "shell_error", "error": str(e)}))
        except:
            pass

# Startup
@app.on_event("startup")
async def startup():
    await init_db()
    await load_settings()
    await load_remote_servers()
    await start_log_watcher()
    await start_monitor()
    print(f"🚀 OpenLog server (Python) running on http://localhost:3001")
    
    # Auto-reconnect servers
    to_reconnect = [s for s in remote_servers if s.get("status") == "connected"]
    if to_reconnect:
        print(f"🔄 正在重连 {len(to_reconnect)} 台之前在线的服务器...")
        for s in to_reconnect:
            try:
                await connect_server(s["id"])
                print(f"  ✅ {s['name']} 重连成功")
            except Exception as e:
                print(f"  ❌ {s['name']} 重连失败: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=3001, reload=False)
