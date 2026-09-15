# Hermes Buddy v3.4.5

## 问题
聊天时上游返回：

```
上游返回 404: {"error":{"code":"UnsupportedModel","message":"The requested model does not support the coding plan feature..."}}
```

原因：上游 `/models` 会把账号下所有模型都列出来，但真正可用于当前端点的只是一部分——
火山方舟 Ark 的 **coding plan** 端点只接受特定模型，选到不支持的模型就直接 404 `UnsupportedModel`。
旧版会把整段 JSON 原样甩到聊天窗口（还套一层 `Error invoking remote method 'buddy:chat'`），
既看不懂也没有下一步。

## 修复
- **服务端（通道 v1.2）**识别 `UnsupportedModel` / `ModelNotFound` 等错误码（以及 "model does not support" 语义）：
  1. 记进 `UNSUPPORTED_MODELS`；
  2. **本轮自动改用默认模型重试一次**，并发一条状态提示「模型 X 不被上游支持，已自动改用默认模型 Y」——聊天不中断；
  3. 后续 `list_models` 不再返回该模型，客户端也会刷新下拉，用户不会再选到它；
  4. 默认模型本身也不被支持时（没有可回退目标）才报错，并附可操作建议（改选模型）。
- **客户端**：`error` 帧现在带 `code` / `hint`；聊天窗口剥掉 Electron 的
  `Error invoking remote method 'buddy:chat':` 外壳，只显示真正的原因；
  会话内记住被拒绝过的模型，不再重复发送注定失败的请求；模型下拉会自动刷新。
- 上游其它 HTTP 错误也改为「状态码 + `error.message`」的简短格式，不再整段 JSON 糊脸。

## ⚠️ 需要重新部署服务端通道
通道协议版本由 **1.1 抬到 1.2**（错误帧与模型清单字段有变化）。首次连接旧服务端会提示
「服务端通道版本过旧（1.1），当前客户端需要 1.2 及以上」：

- 走「已有 hermes」向导：客户端会自动上传并重新部署通道，无需手工操作；
- 已保存的连接：在 Buddy 里对该服务器重新执行一次部署，或到服务器上重跑 `deploy.sh`。

## 验证
- 通道端到端冒烟 17 项全过（含新增：模型被上游打回 → 自动改用默认模型 → 从清单移除）；
- 单元测试 88/88 通过。

## 其他
- 文档：`docs/WS_TOOL_CHANNEL.md`（新增「上游拒绝某个模型时的自动回退（v1.2）」）、
  `docs/WINDOWS_CLIENT.md` §9 模型不被上游接受的处理。
