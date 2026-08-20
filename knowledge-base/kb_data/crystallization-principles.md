# 结晶系统运行原理 (Crystallization System)

## 什么是结晶？

结晶是 Hermes Agent Suite 的核心自进化机制。它将 Agent 在日常交互中积累的经验提炼为可复用的规则（playbook），使 Agent 越用越聪明。

## 三阶段生命周期

### 1. 形成期 (Formation)

**触发条件**：
- 用户纠正 Agent 行为
- Agent 犯错后自行修正
- 重复出现的交互模式

**过程**：
```
原始交互 → 模式识别 → importance = confidence × severity → 候选结晶
```

只有 importance 超过阈值的模式才会进入结晶池，避免噪声。

### 2. 使用期 (Application)

**Playbook 结构**：
- 18 条正则匹配规则
- Facet 分拆（按场景/工具/错误类型分类）
- 注入时机：对话开始前自动匹配

**KV Cache 优化**：
- 固定前缀（system prompt + user 标记）预计算 KV Cache
- 后续请求复用缓存，推理延迟从 2443ms → 1240ms（2x 加速）
- 手动 forward + argmax 替代 generate，避免 DynamicCache 污染

### 3. 回顾期 (Review)

**追踪机制**：
- `crystal_injections` 表记录每次结晶注入
- 同 session 再次命中相同问题 = fail（结晶没起作用）
- 准确率统计窗口：最近 50 次使用

**权重调整**：
| 准确率 | 动作 |
|--------|------|
| ≥ 0.6 | 恢复/提升权重 |
| 0.4 ~ 0.6 | 保持观察 |
| 0.2 ~ 0.4 | 降权 |
| < 0.2 | 退役（移入归档） |

## 每日反思 Cron Job

**时间**：每天 02:30  
**脚本**：`/opt/hermes-suite/crystallization/daily_reflection.py`

**执行内容**：
1. 扫描过去 24 小时的会话交互
2. 识别新的行为模式
3. 更新现有结晶的准确率统计
4. 淘汰失效规则
5. 生成反思日志

**日志位置**：`/root/crystallization/logs/`

## 文件结构

```
/root/.hermes/
├── crystallization/
│   ├── crystal_reflex.py      # 反射服务（9124端口）
│   ├── daily_reflection.py    # 每日反思脚本
│   └── playbook.json          # 当前活跃规则集
├── crystal_injections.db      # 注入追踪数据库
└── knowledge-base/
    └── kb_data/
        └── crystallization-guide.md  # 本文档
```

## 与知识库的关系

结晶系统是知识库的"活性层"：
- **知识库**存储静态事实（文档、API、规范）
- **结晶**存储动态经验（怎么做更好、哪些坑要避）
- 两者互补：知识库回答"是什么"，结晶回答"怎么做"

## 监控指标

通过 `/stats` 端点或日志查看：
- KV Cache 命中率
- Playbook 规则数量
- 各规则准确率
- 每日新增/退役结晶数
