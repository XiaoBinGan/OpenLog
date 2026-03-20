# Give Me The Log - 智能日志分析监控平台

## 1. 项目概述

**项目名称**：Give Me The Log (Open Log)
**项目类型**：Web 全栈应用
**核心功能**：使用大模型智能分析日志、监控系统运行状态、生成告警报告
**目标用户**：运维工程师、开发人员、SRE

---

## 2. 技术栈

- **前端**：React + Vite + TypeScript + TailwindCSS + Recharts
- **后端**：Node.js + Express + SQLite (better-sqlite3)
- **大模型**：OpenAI API (兼容任意 OpenAI 兼容 API)
- **日志收集**：Tail + FS Watcher

---

## 3. 功能模块

### 3.1 日志监控面板
- 实时日志流展示（WebSocket）
- 日志级别过滤（INFO, WARN, ERROR, DEBUG）
- 日志搜索与关键词高亮
- 日志时间范围选择

### 3.2 系统监控
- CPU 使用率图表
- 内存使用率图表
- 磁盘 I/O 监控
- 网络流量监控
- 进程状态

### 3.3 AI 智能分析
- 自动识别日志中的异常模式
- 生成问题诊断报告
- 提供修复建议
- 异常告警（当检测到严重问题时）

### 3.4 仪表盘
- 自定义图表组件
- 拖拽式布局
- 多种图表类型（折线图、柱状图、热力图）

---

## 4. 页面结构

```
/                   - 首页/仪表盘
/logs               - 日志流页面
/analytics          - AI 分析页面
/monitor            - 系统监控页面
/settings           - 设置页面
```

---

## 5. API 设计

### 日志 API
- `GET /api/logs` - 获取日志列表（支持分页、过滤）
- `GET /api/logs/stream` - WebSocket 日志流
- `POST /api/logs/analyze` - AI 分析日志
- `DELETE /api/logs` - 清除日志

### 监控 API
- `GET /api/monitor/stats` - 获取系统统计
- `GET /api/monitor/history` - 获取历史数据

### 设置 API
- `GET /api/settings` - 获取设置
- `PUT /api/settings` - 更新设置

---

## 6. 验收标准

- [ ] 前端页面完整，可正常加载
- [ ] 实时日志流正常显示
- [ ] 系统监控图表正常显示
- [ ] AI 分析功能正常工作
- [ ] 项目可直接运行（npm install && npm run dev）
