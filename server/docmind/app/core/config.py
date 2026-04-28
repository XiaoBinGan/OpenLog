import os
import httpx
from pydantic_settings import BaseSettings
from typing import Literal

class Settings(BaseSettings):
    APP_NAME: str = "DocMind"
    DEBUG: bool = True
    
    # OpenLog API 地址（用于读取 AI 配置）
    OPENLOG_API: str = "http://localhost:3001"
    
    # 上传设置
    UPLOAD_DIR: str = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "data", "docmind_uploads")
    MAX_FILE_SIZE: int = 50 * 1024 * 1024  # 50MB
    
    # Database（独立的 DocMind 数据库）
    DATABASE_URL: str = f"sqlite+aiosqlite:///{os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'data', 'docmind.db')}"
    
    # PageIndex Settings
    MAX_TREE_DEPTH: int = 3
    MAX_LEAF_NODES: int = 100
    CHUNK_SIZE: int = 500
    
    # LLM 配置（从 OpenLog 动态读取，fallback 到默认值）
    LLM_PROVIDER: str = "local"
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    ANTHROPIC_API_KEY: str = ""
    ANTHROPIC_MODEL: str = "claude-3-haiku-20240307"
    LOCAL_MODEL_URL: str = "http://localhost:11434/v1"
    LOCAL_MODEL_NAME: str = "qwen3.5:9b"
    
    class Config:
        extra = "allow"

settings = Settings()

# 尝试从 OpenLog 读取 AI 配置
def _sync_from_openlog():
    try:
        resp = httpx.get(f"{settings.OPENLOG_API}/api/settings", timeout=5)
        if resp.status_code == 200:
            s = resp.json()
            base_url = s.get('openaiBaseUrl', '')
            model = s.get('model', '')
            api_key = s.get('openaiApiKey', '')
            
            # 更新配置
            if base_url:
                settings.LOCAL_MODEL_URL = base_url.rstrip('/')
                # 判断是本地还是远程
                if 'localhost' in base_url or '127.0.0.1' in base_url:
                    settings.LLM_PROVIDER = 'local'
                    settings.OPENAI_API_KEY = api_key or 'ollama'
                else:
                    settings.LLM_PROVIDER = 'local'
                    settings.OPENAI_API_KEY = api_key or 'sk-dummy'
            if model:
                settings.LOCAL_MODEL_NAME = model
            
            print(f"[DocMind] 从 OpenLog 同步 AI 配置: {settings.LOCAL_MODEL_URL} / {settings.LOCAL_MODEL_NAME}")
    except Exception as e:
        print(f"[DocMind] 无法从 OpenLog 读取配置，使用默认值: {e}")

_sync_from_openlog()

# Ensure upload directory exists
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)