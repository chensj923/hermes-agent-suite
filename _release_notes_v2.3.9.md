# Hermes Buddy v2.3.9-dev

## 重大架构订正：推理端点与 Gateway 彻底解耦

v2.3.6 曾认为「LLM 与 Gateway 同端口 22122」，v2.3.8 曾认为「hermes proxy 是本地推理端点、默认 8800」——
**两条都被 2026-09-14 的实测证伪。**

### 实测结论
- **22122 的 `/v1/chat/completions` 是服务端 agent 端点**：无视请求里的 `tools`、注入 1.2~4 万 token
  自有系统提示、在服务器本地执行命令（真的跑了 `ls /root`）后返回文字。
- **换 `model` 名绕不过去**：填 `hermes-agent` 和填底层真实模型名 `ark-code-latest`，两次请求的
  `prompt_tokens` 分别为 39881 / 39896，都返回 `tool_calls: null`，都在服务器上执行了命令。
- **`hermes proxy` 不是本地推理端点**：它把请求转发给 OAuth 供应商（Nous Portal / xai）；
  子命令是 `start`（不是 `run`），默认端口 **8645**（不是 8800）。
- **服务器上没有任何纯推理端点**：端口扫描只发现 22122 与 8200。

### 因此 Buddy 的正确用法
「推理端点（LLM）」必须是**原生支持 function calling 的 OpenAI 兼容端点**，与 Gateway 完全解耦：
- 火山方舟 Ark：`https://ark.cn-beijing.volces.com/api/v3/chat/completions`
- DeepSeek / 通义 / 本地 vLLM / Ollama
- 或服务器上的 `hermes proxy start --host 0.0.0.0 --port 8645`

## 本次改动
- **连接页**：「推理端点（LLM）」改为必填并给出示例与警告；主机框只推导 Gateway，不再推导推理端点；
  未填推理端点时直接拦下并说明原因。
- **服务端准备脚本第 4 步重写为「侦察上游模型端点」**：
  - 4a 打印配置里的模型与供应商
  - 4b 打印上游密钥（**默认打码**，`SHOW_KEYS=1` 才显示完整值，方便把输出贴出来求助）与非机密 URL
  - 4c `hermes model list` / `hermes proxy providers` / `hermes proxy status`
  - 4d 在 Hermes 包源码里 grep `chat/completions` 线索
  - 4e 用**正确子命令** `hermes proxy start --host 0.0.0.0 --port 8645` 尝试起代理
  - 4f 给出「Buddy 该填什么」的结论
  - 第 2 步改为打印**全部 TCP 监听端口**
- **连接时的端点探测**：agent 端点候选端口改为 8645/8800/8000；找不到时给出可直接照做的错误提示
  （列出 Ark / DeepSeek / hermes proxy 三种填法），不再瞎猜端口。
- 文档 `docs/WINDOWS_CLIENT.md` 端口约定与准备流程同步订正，并记录了两次误判的版本历史。
- 附带侦察工具脚本：`scripts/_probe_endpoint.js`、`_probe_openapi.js`、`_probe_model_passthrough.js`、
  `_scan_ports.js`、`_gen_recon.js`。

## 验证
- 全量测试 77/77 通过。
