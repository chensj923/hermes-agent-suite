# Hermes Buddy v3.0.0

**第一个正式版。** 从 v2.3.9 到 v3.0 这段时间，Buddy 从一个"要手填一堆端点才能跑起来"的客户端，
变成"**填 SSH 就能用**"的一体化工具。同时修掉了那个困扰了连续四个版本的连接超时。

---

## 核心变化：连接向导（填 SSH 就行）

以前要连上自己的 Hermes，你得知道 Gateway 端口、推理端点、WS 通道地址，还得自己上服务器翻 API Key ——
任何一项填错就是一句没有信息量的"连接失败"。

v3.0 把这些全部内建进**三步向导**：

| 步骤 | 你做什么 | Buddy 做什么 |
|---|---|---|
| **1. 选部署状态** | 点「已部署 Hermes」或「全新部署」 | — |
| **2. 填 SSH 凭据** | IP、用户（默认 root）、端口（默认 22）、密码或私钥 | SSH 连上去；全新部署则先推送部署包跑 `deploy.sh`（装直通代理 `:8811` + WS 通道 `:8822`，注册 systemd 开机自启）；然后体检 `.hermes` 目录、`hermes` CLI、22122/8822/8811 端口、通道 `/health` 版本，**并自动取回 API Key** |
| **3. 确认并连接** | 看一眼自动填好的主机和 Key，点连接 | 连 WS 通道；Gateway 会话登记转后台异步，成败都不影响聊天 |

部署日志实时打印在向导里，不用再去翻终端。再次启动时自动恢复连接，恢复失败才回落到第 3 步让你确认参数。

新增 IPC `buddy:ssh-check`：用 ssh2 纯 JS 客户端（不依赖本机 ssh/scp 命令行）完成远端体检与取 Key。

---

## 修掉了：连接超时（20 秒）

v2.3.20 ~ v2.3.23 用户点连接一律报 `连接超时（20 秒）`，而服务端日志显示 WS 握手**已经 101 成功**。

**根因**是代码 bug，不是网络：`channel.js` 里调用了 `this._startHeartbeat()` / `_stopHeartbeat()`，
却从没定义这两个方法。异常抛在 `req.on('upgrade')` **事件回调**里，逃出了 Promise 的 try/catch，
导致 `openPromise` **既不 resolve 也不 reject，永久悬挂** —— 真实的 `TypeError` 被事件循环吞掉，
最后只能等主进程 20 秒的 IPC 兜底，于是你看到的永远是那句没有信息量的超时提示。

修复：

- 补上 `_startHeartbeat()` / `_stopHeartbeat()`（25 秒 WS ping 保活，防 NAT/代理掐长连接；`unref`，可重复启停不泄漏定时器）。
- `req.on('upgrade')` 整段包 try/catch：任何初始化异常都走 `fail()` 并 `socket.destroy()`，
  **从机制上保证 `openPromise` 一定会 settle**，不再有悬挂可能。
- 扫描全项目 26 个文件的所有 `this._xxx()` 调用，确认没有第二颗同类地雷。

修复后实测 `connect()` **10 毫秒**返回并拿到 sessionId（原本卡死 20 秒）。

---

## 其它稳定性修复（v2.3.10 ~ v2.3.23）

- **架构**：移除本地模式，只保留通道模式 —— 决策在服务端外挂通道，本机只做工具筛选与执行。
- **断线自愈**：WS 断开后自动重建握手，不再陷入"断开 → 手动重连 → 又断开"的死循环。
- **卸载清理**：卸载程序杀残留进程并清 `%APPDATA%\Hermes Buddy`，解决 `window.buddy is not defined` 类旧缓存问题（`customUnInstall` 宏）。
- **安装**：安装前强制杀掉正在运行的旧 `Hermes Buddy.exe`，避免旧 asar 覆盖不掉。
- **服务端部署**：`deploy.sh` 改用 `systemctl restart` 并显式 `pkill` 旧进程（此前 `enable --now` 不会重启已运行的服务）；修复 `CHANNEL_VERSION` 未定义导致的 `NameError`。
- **诊断**：通道模式下不再误查 `llmUrl`（此前会卡在"LLM 不可达"）。
- **超时保护**：WS 握手加 10 秒 HTTP 超时，IPC `buddy:connect` 加全局超时，杜绝 `reply was never sent`。
- **Gateway 非阻塞**：通道模式下 Gateway 会话登记改为后台 fire-and-forget，改用 Electron `net.fetch`（跟随系统代理、读 Windows 证书库），不再拖垮连接流程。

## 测试

全量 **91/91 通过**。新增 `test/channel.test.js`（5 个用例）：

- WS 帧 mask 位与长度编码
- 正常握手后 `connect()` resolve 并拿到 sessionId
- **回归锁**：握手后初始化抛异常时 `connect()` 必须 reject，不能永久悬挂
- 服务端拒绝握手（401）时快速失败
- 心跳方法存在且可安全重复启停

## 安装

下载 `hermes-suite-windows-x86_64.exe`，默认装到当前用户目录（不需要管理员权限）。
服务端要求：Linux + systemd，Hermes 已部署（或让向导帮你部署）。
