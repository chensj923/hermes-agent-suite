# Hermes Buddy · WS 工具通道协议规范（v1）

> 目标：把"决策"放到 Hermes 服务器侧，把"执行"放到 Buddy 客户端侧。
> 服务器跑 Agent 循环（LLM 推理 + 工具调度），把工具调用通过 WebSocket 卸载给已连接的
> Buddy；Buddy 过命令护栏后在 Windows 本地执行，再把结果回传。像飞书通道一样可插拔——
> 本组件是挂在 Hermes 主机上的"外挂通道"，不改动 Hermes 二进制。

---

## 1. 角色与拓扑

```
┌─────────────────────┐         WebSocket (WS)          ┌──────────────────────────┐
│  Buddy (Windows)     │  tool_request ───────────────▶  │  hermes-buddy-channel     │
│  · 命令护栏          │  ◀─────────────── tool_result    │  （外挂组件，Hermes 主机） │
│  · 本地工具执行       │  assistant_chunk ─────────────▶  │  · 读 Hermes config.yaml   │
│  · 工作区沙箱        │  ◀─────────────── user_message   │  · Agent 循环 + LLM 推理   │
└─────────────────────┘                                  └────────────┬─────────────┘
                                                                     │ 复用 Hermes 上游
                                                                     ▼
                                                            Ark / DeepSeek / vLLM …
```

- **服务器组件**（`packages/hermes-buddy-channel/buddy-channel.py`）：零依赖 Python，WS 服务 + Agent 循环。
- **Buddy 客户端**（`apps/hermes-buddy-desktop/src/agent/channel.js`）：零依赖 WS 客户端，复用 `ToolRegistry` + `CommandGuard`。

---

## 2. 连接与鉴权

```
ws://<hermes-host>:<port>/api/buddy/channel?token=<API_SERVER_KEY>&client=buddy&session=<sid>
```

- 端口默认 `8822`（`BUDDY_CHANNEL_PORT` 可改）。
- 鉴权：token 取自 Hermes 的 `API_SERVER_KEY`（与 8811 代理同源）。服务端未配置 key 时内网降级不强制。
- 握手为 RFC6455；客户端必须按规范 mask 发送帧，服务端发送帧不 mask。
- 每个 WS 连接对应一个 session；连接建立即开始 Agent 循环，直到 `task_done` / `cancel` / 断开。

---

## 3. 消息总表（均为 JSON，`{ "type": ... }`）

### 3.1 客户端 → 服务器

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `client`, `version`, `capabilities:["tool_execute"]`, `session?` | 握手后首条，声明能力 |
| `user_message` | `session`, `text`, `history?`, `model?` | 发起/继续一次任务；`model` 指定本轮用的模型（缺省用服务端默认） |
| `list_models` | `session?` | 请求可用模型清单（服务端去上游 `/models` 拉取） |
| `tool_result` | `id`, `ok`, `text`, `blocked?`, `exit_code?`, `data?` | 工具执行结果 |
| `tool_rejected` | `id`, `reason`, `rule?` | 被命令护栏拦截（服务器需把它作为"失败的工具结果"回灌模型） |
| `tool_progress` | `id`, `chunk` | 长命令的流式输出（可选） |
| `cancel` | `id?` | 中止当前任务/工具 |
| `pong` | `ts?` | 响应服务端 `ping` |

### 3.2 服务器 → 客户端

| type | 字段 | 说明 |
|---|---|---|
| `welcome` | `session`, `model`, `server`, `version`, `channel_version` | 握手确认；`channel_version` 用于能力协商 |
| `assistant_chunk` | `session`, `text` | 流式助手文本（可多次） |
| `assistant_done` | `session`, `text?` | 助手文本收尾（可选，chunk 已足够时省略） |
| `tool_request` | `id`, `tool`, `params`, `session` | 请求在 Buddy 本地执行某工具 |
| `task_done` | `session`, `text`, `turns`, `stopped?` | 任务结束 |
| `error` | `code`, `message` | 协议/推理错误 |
| `models` | `models:string[]`, `default` | 应答 `list_models`：可用模型清单，默认模型排最前 |
| `ping` | `ts` | 心跳（客户端回 `pong`） |

#### 能力协商与强制重新部署（v1.1 起）

服务端通道是独立部署的外挂组件，升级 Buddy 客户端**不会**自动更新它。
如果客户端连上一个旧通道，就会带着残缺能力静默运行（例如拿不到模型清单、
`list_models` 收到 `unknown_type`）——这类问题极难排查。因此握手即协商：

1. 服务端 welcome 携带 `channel_version`（例如 `1.1`）；
2. 客户端内置 `REQUIRED_CHANNEL_VERSION`，比较 major.minor；
3. **不满足 → 立即断开通道并 reject 握手**，错误码 `channel_outdated`，
   提示语明确要求「在 Buddy 里重新执行一次部署，或到服务器上重跑 deploy.sh」；
4. 该状态会被记住（`SessionManager._channelOutdated`），后续发消息直接快速失败，
   不会反复重试握手；重新部署成功后自动清空。

> 约束：给通道加新的消息类型 / 改变协议语义时，**必须同时抬 `CHANNEL_VERSION`
> 和客户端的 `REQUIRED_CHANNEL_VERSION`**，否则旧服务端会与新客户端悄悄错配。

#### 模型清单与选择（v1.1）

通道模式下 Buddy 没有可直连的 HTTP 推理端点，因此模型清单必须由服务端代拉：

1. Buddy 连接后发 `list_models`；
2. 服务端 GET 上游 `{upstream_base}/models`（`buddy-proxy.env` 的 `BUDDY_UPSTREAM_BASE`，
   自动归一到 `.../models`），把 `data[].id` 平铺成清单；
3. 上游不可达时，用 `config.yaml` 里 `custom_providers/providers` 声明的模型名兜底；
4. 返回的清单里，服务端当前默认模型永远排第一位，且清单不会为空。

用户选中的模型通过 `user_message.model` 透传，服务端按会话记住它，
后续轮次（工具结果回灌后再问）继续用同一个模型。

---

## 4. Agent 循环（服务端）

```
on user_message:
  messages = [system] + history + [user]
  turns = 0
  while turns < MAX_TURNS:
    turns += 1
    r = call_llm(messages, TOOL_SCHEMAS)          # 复用 Hermes 上游；mock 模式走脚本
    emit assistant_chunk(r.content)               # 文本流式回传
    if r.tool_calls 为空:
      emit task_done(r.content); break
    for call in r.tool_calls:
      pending[call.id] = Future()
      emit tool_request(id, call.tool, call.params)
      result = await pending[call.id]  (超时 300s, 可被 cancel 中断)
      messages.append({ role:"tool", tool_call_id, content: result.text })
      if result.blocked: messages 追加"被安全规则拦截"提示，让模型换路
  if turns 达上限: emit task_done(..., stopped="max_turns")
```

**系统提示（服务端构造）**：声明 Buddy 是 Windows 本地助手、工具在用户机器执行、工作区受限、
危险命令会被拦截；与现有 `buildSystemPrompt` 保持一致。

---

## 5. 工具目录（服务端广播给 LLM）

与 `src/tools/index.js` 的 `TOOL_DEFINITIONS` 七项保持一致，由服务端持有权威 schema：
`run_command` / `read_file` / `write_file` / `list_dir` / `find_files` / `search_content` / `system_info`。
Buddy 端按 `tool` 名本地执行，未知工具回 `tool_rejected`。

---

## 6. 错误与超时

- `tool_request` 超过 `TOOL_TIMEOUT`（默认 300s）未回：服务器把"工具执行超时"作为 tool 消息回灌，避免死等。
- `cancel`：中止在途 LLM 调用或工具等待，发 `task_done(stopped="aborted")`。
- 断线：正在等待 `tool_result` 的循环收到连接关闭即中止该任务。
- 鉴权失败：握手返回 HTTP 401。

---

## 7. 部署

- 与 8811 推理代理同机部署，`server-bootstrap.js` 第 4 步写入 `buddy-channel.py` 并启动（systemd 或 nohup）。
- 端口 `8822`（避开 Gateway 22122 / 代理 8811 / hermes proxy 8645）。
- Buddy 连接页新增"通道模式"：填 Hermes 主机 + API Key，推理端点留空时推导 `:8822` 的 WS 通道。
