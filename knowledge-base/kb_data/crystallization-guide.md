# 结晶体系运行原理

## 什么是结晶？
结晶是从日常交互中自动提取的行为模式和解决方案，让智能体"越用越聪明"。

## 三阶段生命周期

### 形成期 (Stage 1 → 2)
- 从交互日志中识别重复模式
- 计算重要性: importance = confidence × severity
- 达到阈值后升级为活跃结晶

### 使用期 (Stage 2)
- 18 条 playbook 规则 regex 匹配
- facet 分拆: 将复杂模式拆解为可组合的子模式
- 实时注入到 agent 上下文中

### 回顾期 (Stage 3)
- crystal_injections 表追踪每次注入的效果
- 同 session 再命中 = fail（说明没解决问题）
- 准确率 <0.4 → 降权, <0.2 → 退役, ≥0.6 → 恢复

## KV Cache 优化
固定前缀预计算 KV Cache，后续请求复用，实测 2x 加速。

## 相关文件
- crystal_reflex.py: 核心推理引擎
- daily_reflection.py: 每日反思脚本
- playbook.json: 匹配规则库
- crystallization.db: SQLite 存储
