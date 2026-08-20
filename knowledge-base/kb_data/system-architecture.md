# Hermes Agent Suite 系统架构

## 整体架构
Hermes Agent Suite 是一个自组织认知智能体平台，核心组件：

### 1. Gateway API Server (端口 22122)
- OpenAI 兼容 API，供客户端（HermesBuddy）调用
- 模型路由、会话管理、工具调度

### 2. 结晶体系 (Crystal Reflex)
- **形成期**: 从交互中提取行为模式，计算 importance = confidence × severity
- **使用期**: playbook 规则匹配 + facet 分拆，实时注入上下文
- **回顾期**: 追踪复发率，准确率 <0.4 降权 / <0.2 退役 / ≥0.6 恢复
- 服务端口: 9124，模型: Qwen3-0.6B 本地推理

### 3. 三层知识库
- **L1 Memory**: ~/.hermes/memory/ — 热记忆，直接注入 prompt
- **L2 FAISS**: ~/.hermes/knowledge-base/ — 向量检索，语义搜索
- **L2.5 AnythingLLM**: 共享知识中枢，MCP 接入，REST API 采集

### 4. WorkBuddy API (端口 8700)
- 文件读写、Office 文档解析、工作空间管理

### 5. 视觉服务 (端口 9121)
- OCR + AI 图像理解，moondream 模型

## Cronjob 自动化
- 每日反思: 分析交互，提取/更新结晶模式
- 知识库索引: 增量向量化新文档
- 记忆维护: 三层记忆归档与清理
- 会话筛选: 高价值对话归档到知识库
