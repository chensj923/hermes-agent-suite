# Hermes Agent Suite 三层知识库体系

## 架构概览

Hermes Agent Suite 采用三层知识库架构，实现从短期记忆到长期知识的完整链路：

```
┌─────────────────────────────────────────┐
│  Layer 3: AnythingLLM (共享知识中枢)      │
│  - 向量检索 + RAG                        │
│  - 多 Agent 共享                         │
│  - REST API + MCP 接入                   │
├─────────────────────────────────────────┤
│  Layer 2: FAISS 本地向量索引              │
│  - SQLite + FAISS 语义搜索               │
│  - 会话记录自动索引                       │
│  - 离线可用                              │
├─────────────────────────────────────────┤
│  Layer 1: Memory (即时记忆)              │
│  - MEMORY.md / USER.md                  │
│  - 每次对话注入                           │
│  - 8KB 容量限制                          │
└─────────────────────────────────────────┘
```

## Layer 1: Memory（即时记忆）

**用途**：存储用户偏好、环境配置、工具使用经验等高频信息。

**特点**：
- 每次对话自动注入系统提示
- 容量限制 8KB，需定期清理
- 写入即生效，无需索引

**适用内容**：
- 用户个人信息和偏好
- 服务器 IP、端口、凭据位置
- 工具使用陷阱和解决方案
- 项目约定和规范

## Layer 2: FAISS 本地向量索引

**用途**：对会话历史进行语义搜索，支持跨会话回忆。

**特点**：
- SQLite FTS5 全文检索 + FAISS 向量相似度
- 自动索引每日会话记录
- 支持 `session_search` 工具查询

**适用场景**：
- "上次我们怎么解决的 X 问题？"
- "找到讨论 Y 功能的会话"
- 跨会话上下文恢复

## Layer 3: AnythingLLM（共享知识中枢）

**用途**：团队/多 Agent 共享的结构化知识库，支持 RAG 增强。

**特点**：
- 向量数据库 + LLM 检索增强生成
- REST API 供 cron job 自动采集
- MCP 协议供 Agent 实时查询
- 支持文档上传、网页抓取、API 对接

**部署**：
- Docker 容器化部署
- 默认端口 3001
- 可通过 `kb.chensj.net` 外网访问

## 数据流转

```
用户对话 → Session DB → [cron: 每6小时] → FAISS 索引
                                    ↓
                            [cron: 每周日] → AnythingLLM 归档
                                    
Agent 查询 → session_search (L2)
           → kb_search (L3)
           → memory (L1, 自动注入)
```

## Cron Job 自动化

安装时自动创建以下知识库相关 cron job：

| Job | 频率 | 功能 |
|-----|------|------|
| 知识库增量索引 | 每6小时 | 扫描新会话，更新 FAISS 索引 |
| Weekly Session Screener | 每周日 03:00 | 筛选高价值会话归档到 AnythingLLM |
| Daily Memory Maintenance | 每天 03:00 | 清理过期 memory，保持紧凑 |

## 客户使用指南

1. **自动采集**：cron job 会自动将会话中的有价值内容入库
2. **手动上传**：通过 AnythingLLM Web UI 上传文档
3. **Agent 查询**：Agent 会自动搜索知识库回答相关问题
4. **维护**：定期查看知识库质量，删除过时内容
