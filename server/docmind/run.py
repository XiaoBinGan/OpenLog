"""DocMind 入口 — 启动 FastAPI 服务"""
import uvicorn
import os

# 设置工作目录为当前脚本所在目录
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from app.main import app

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        reload=False
    )