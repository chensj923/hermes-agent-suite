## Hermes Buddy v3.4.2

Windows 客户端（`hermes-suite-windows-x86_64.exe`，80.5MB）。
v3.4.2 包含 v3.4.0 与 v3.4.1 的全部改动。

### 新增：智能体可以选择模型了（v3.4.0）

通道模式下「智能体配置」里只有一个默认模型 —— 原因是**通道模式本地没有推理端点**，
`session-manager` 的 `brain` 被置为 `null`，`models()` 必然抛异常后退回默认模型，
而不是模型列表没透传。

做法：WS 通道协议升到 **v1.1**，新增 `list_models` 请求。
- 服务端 `buddy-channel.py` 新增 `models_url()` / `list_upstream_models()`：
  向上游拉真实模型清单；上游不可达时退回 `config.yaml` 里声明的模型名；
  **当前默认模型永远排第一，清单永不为空**。
- `user_message` 新增 `model?` 字段，服务端按会话记住，工具结果回灌后的后续轮次继续用同一模型。
- 客户端 `channel.listModels()`、`session-manager` 在通道模式改走通道查询。
  UI 的模型下拉无需改动，自动列出真实模型。

### 新增：通道版本协商，旧服务端强制重新部署（v3.4.0）

以后给通道加新能力，**不再静默降级**。服务端 welcome 带 `channel_version`，
客户端内置 `REQUIRED_CHANNEL_VERSION = 1.1`：

- 不满足 → 立即断开并拒绝握手，错误码 `channel_outdated`，
  提示「服务端通道版本过旧（x.y），当前客户端需要 1.1 及以上。请重新执行一次部署」。
- 已判定过旧会被记住，后续发消息直接快速失败，不会反复重试握手空转；
  重新部署成功后自动恢复。
- 错误**不**包成「连不上 WS 通道」，也**不**匹配断线重连正则 —— 避免你去查网络、
  也避免自动重连循环。

> ⚠️ 服务端跑的是旧通道时，装了这个版本再连会**直接被挡下并提示重新部署**，
> 这是预期行为。**重新部署一次服务端即可**（Buddy 的自动部署，或到服务器上重跑 `deploy.sh`）。

### 新增：安装/升级时清理本机缓存（v3.4.1 / v3.4.2）

安装（含覆盖升级）时先结束正在运行的 `Hermes Buddy.exe`，然后清理：
- Electron/Chromium 各类缓存、`logs\`、`server-deploy\`（下次启动按当前版本重新解压）
- electron-updater 下载缓存（`%LOCALAPPDATA%\@hermesbuddy-desktop-updater` 等，单份 80MB 上下）

**只清缓存**，连接配置（`buddy.connection`）与智能体/模型选择（`agents.json`）**保留**，
升级不需要重填连接信息。卸载时才整个删除 userData。

> 顺带修正：原安装脚本删的是 `%APPDATA%\Hermes Buddy`，但真实 userData 是
> `%APPDATA%\@hermes\buddy-desktop`（`package.json` 的 `name` 是 `@hermes/buddy-desktop`，
> Electron 保留 scope 作一级目录）—— 也就是说卸载**从来没真正删干净过**。
> 注意：`%APPDATA%\Hermes`、`%LOCALAPPDATA%\hermes` 属于另一个 Hermes 应用，安装脚本不会碰。

### 修复

- **WS 握手偶发超时**（真 bug）：`channel.js` 的 `req.on('upgrade', (res, socket) => ...)`
  忽略了第三个参数 `head`。Node 会把紧跟 101 响应已到达的字节放进 `head` 而不走 `data` 事件，
  服务端 welcome 发得快时就被丢弃 —— 表现为**随机的「8 秒内未收到 welcome」**。
- **握手未完成却判定为连接成功**：`_onClose()` 原本无条件 `resolve()`，
  意味着服务端没回 welcome 就断连也会被当成成功，要等到发消息时才暴露。已加 `_welcomed` 标记。

### 验证

- `scripts/test-channel-models-smoke.js`：起假上游 + 本地通道 + 真实客户端，
  断言模型清单透传、指定模型真的生效、**旧服务端必须被拒绝**。共 9 项断言，连跑 5 次稳定。
- 单元测试 88/88 通过。

### 相关文档

- `docs/WS_TOOL_CHANNEL.md`：新增 `list_models` 与「能力协商与强制重新部署」章节，
  并记下约定 —— **以后给通道加新消息类型，必须同时抬服务端 `CHANNEL_VERSION`
  和客户端 `REQUIRED_CHANNEL_VERSION`**。
- `docs/WINDOWS_CLIENT.md` §7.1.1：安装时清理说明。
