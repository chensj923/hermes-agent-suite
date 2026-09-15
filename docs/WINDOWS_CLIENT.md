# Hermes Buddy — Windows 客户端 / Windows Client

> 中文在前，English follows each section.

## 1. 定位 / Positioning

Buddy 不是一个远程 agent 的 Web 包装。它做的是**让远端 Hermes 做决策、让本机 Windows 做执行**。连接页提供两种模式：

- **本地模式（默认）**：本机跑 ReAct 循环，决策在本地。把消息、工具 schema、本地工作区描述发给 **Hermes 主机上的推理直通代理**（`:8811`，由「服务端准备脚本」一键部署）。
  它复用 Hermes 自己配好的上游模型，**原样透传 tools**，因此**上游密钥永远不出服务器**，Buddy 只需认 Hermes 一个地址。
  连接时会自动探测端点能力；误填成 Gateway 的 22122（服务端 agent 端点）会自动纠正或明确报错。
- **通道模式（推荐，密钥不出服务器）**：决策在 **Hermes 服务端外挂通道**（`hermes-buddy-channel`，监听 `:8822`，同样由「服务端准备脚本」一键部署），本机只做命令筛选 + 本地执行。
  Buddy 通过 WebSocket 连上通道，服务端跑 Agent 循环并把 `tool_call` 卸载下来；客户端先过命令护栏（`guard.js`）再在 Windows 本地执行，结果经 `tool_result` 回传。
  这是飞书式 WS 通道：服务端是"大脑"，客户端是"手"。
- **执行**：本机 Electron 主进程按 function name 调本地工具（PowerShell / 文件系统 / Git…），把结果回灌给模型，直到模型不再要工具为止。
- **落点**：所有执行强制限制在用户选的工作区目录里；越界路径与黑名单命令由工具层的 `guard.js` 拦截。

> Buddy is **not** a thin web shell for a remote agent. The remote Hermes makes decisions; the local Windows side executes. Tools run on this machine through Electron's main process; the LLM only sees the standard OpenAI tool-calling contract.

## 2. 结构 / Layout

```
apps/hermes-buddy-desktop/
  src/main.js                  Electron 主进程：窗口、IPC、单例锁、冒烟入口
  src/preload.js               contextBridge 白名单（buddyApi），渲染层唯一入口
  src/connection-store.js      DPAPI(safeStorage) 凭据存储 + 字段规范化
  src/session-manager.js       编排：brain / loop / tools / workspace / 记忆 / 技能
  src/workspace.js             工作目录校验 + AGENTS.md 初始化 + 路径越界拦截
  src/tools/                   run_command / read_file / write_file / list_dir / find_files / search_content / system_info
    guard.js                   黑名单命令 + 工作区越界检查
    shell.js                   PowerShell 5.1 执行器（临时脚本 + UTF-8 + 超时）
    files.js                   纯 Node fs 实现
    index.js                   ToolRegistry：注册 + 权限档位 + OpenAI schema
  src/agent/
    brain.js                   Hermes LLM 客户端（标准 function calling + 流式）
    loop.js                    ReAct 循环：tool_calls → 本地执行 → 结果回灌
    channel.js                 通道模式 WS 客户端（零依赖 RFC6455；握手 + 帧编解码 + 工具回传）
    prompts.js                 系统提示词：身份 + 环境 + 记忆 + 技能 + 工具链
  src/channel-template.js      buddy-channel.py 源码模板（随安装包打进 asar，服务端准备脚本读取）
  src/memory.js                MEMORY.md + 每日日志（项目级 + 全局级）
  src/skills.js                技能加载（内置 + 工作区），注入到提示词
  src/toolchain.js             检测 + 一键安装 PowerShell / Git / ripgrep / Node / Python
  src/update-checker.js        GitHub Release 版本比较（手动更新）
  src/logger.js                JSON 行日志 + 密钥脱敏
  src/renderer/                index.html / styles.css / app.js
  skills/                      内置技能 Markdown
    windows-shell.md           PowerShell 约定与陷阱
    file-editing.md            文件读写最佳实践
    git-workflow.md            提交、分支、推送约定
packages/
  hermes-connection/           Gateway 客户端（保留：用于部署登记与降级路径）
  hermes-provisioning/         部署清单契约 + 设备校验
  hermes-capability-registry/  能力清单
  hermes-buddy-channel/        **服务端外挂通道（飞书式 WS 通道）**：零依赖 Python，监听 :8822，
                                Agent 循环 + 7 工具调度，buddy-channel.py 是单一事实来源
```

## 3. 数据流 / Data flow

**本地模式（决策在本地，直连推理端点）**：

```
render → IPC(buddyApi) → main.js
                              ↓
                  ┌───────────┴────────────┐
                  │                        │
          SessionManager             Window Dialog
                  │                        │
    brain.chat() ─→ Hermes:8811 直通代理 ─→ 上游模型    危险命令弹窗
    (OpenAI compat)  (原样透传 tools)   (Ark/DeepSeek/…)  (用户点头/拒绝)
                  │                        │
                  ↓                        │
           AgentLoop.run()                 │
                  │                        │
           tools.invoke() ←─── onConfirm()─┘
                  │
                  ↓
         Shell / fs (workspace)
```

**通道模式（决策在 Hermes 服务端外挂通道，本机只执行）**：

```
render → IPC(buddyApi) → main.js → ChannelClient(WS :8822)
                                                    │
                                                    ↓
                                          hermes-buddy-channel（服务端）
                                            Agent 循环 + LLM 推理
                                                    │ tool_request（卸载工具调用）
                                                    ↓
                                          ChannelClient 过命令护栏
                                                    │ 放行 / 拦截
                                                    ↓
                                          tools.invoke() → Shell / fs（workspace）
                                                    │ tool_result / tool_rejected
                                                    ↑__________________________________│
                                            assistant_chunk / task_done 流式回传渲染层
```

每个对话回合（两种模式通用）：

1. 渲染层发 `chat({requestId, text})` 给主进程。
2. 本地模式：主进程把 system prompt + 历史塞进 OpenAI chat 请求，模型返回 tool_calls → 本地工具跑 → 回灌 → 直到停止。
   通道模式：主进程把消息经 WS 发给服务端通道，服务端的 Agent 循环负责推理，把工具调用卸载回本机执行。
3. 模型返回 tool_calls → 本地工具跑 → 结果拼回（本地模式直接回灌 messages；通道模式经 `tool_result` 回灌服务端）→ 直到模型停止调用工具。
4. 文本增量经 25ms 合批后走 IPC 推给渲染层；工具事件（开始 / 完成 / 拦截 / 通知）独立推。
5. 主进程把这一轮摘要追加进当日工作日志。

## 4. 安全边界 / Security boundaries

| 边界 | 实现 |
|------|------|
| API Key 不落明文 | `safeStorage`（Windows DPAPI），不可用时拒绝保存 |
| 换机/损坏配置 | 解不开就隔离成 `.decrypt-failed`，要求重新配置 |
| 渲染层零凭据 | `contextIsolation + sandbox + 白名单 preload`，CSP 锁死 `connect-src` |
| 无外部导航 | `will-navigate` 拦截；新窗口只放 `github.com` / `ghfast.top` |
| 工作区越界 | `Workspace.resolve()` 用 `path.relative` 前缀校验；工具拒绝相对路径回退越界 |
| 命令黑名单 | `guard.js`：rm -rf 之类 / 改注册表 / 杀进程 / 启停服务等 |
| 权限档位 | `read`（只读）/ `read-write`（推荐，删除/系统级需确认）/ `full`（不拦截） |
| 危险命令人工确认 | 主进程挂起等渲染层 `replyConfirm`，超时默认拒绝 |
| 日志脱敏 | `gh*_` / `sk-` / `Bearer ` / 凭据字段名一律 `[redacted]` |
| 单实例 | `app.requestSingleInstanceLock()`，第二个进程直接退出 |

## 5. 工作区约定 / Workspace conventions

Buddy 在用户指定的工作区里维护一个 `.hermes/` 目录：

```
<workspace>/
  .hermes/
    AGENTS.md                 给 Hermes 看的项目级操作约定（可手写）
    persona.md                用户定义的角色与语气
    memory-project.md         项目级长期记忆
    skills/<name>.md          项目级技能（覆盖同名内置技能）
```

全局记忆（`~/.hermes/buddy/memory-global.md`）和工具链检测结果会出现在系统提示词里。AGENTS.md 由 Buddy 自动创建初始模板，用户可直接编辑。

> The `.hermes/` folder is owned by Buddy. Edit it freely; Buddy will only overwrite AGENTS.md when the workspace is first created.

## 6. 工具一览 / Tool catalog

通过 OpenAI function calling schema 暴露给 Hermes：

| 工具 | 权限档位要求 | 说明 |
|------|--------------|------|
| `run_command` | read-write 及以上 | PowerShell 5.1；强制 UTF-8 输出；超时与字节截断由工具层控制 |
| `read_file` | read 及以上 | UTF-8 解码失败自动回退 latin1；最大 2 MB |
| `write_file` | read-write 及以上 | 自动创建父目录；覆盖提示通过返回 `created` 标记 |
| `list_dir` | read 及以上 | 递归控制深度与条数，避免大目录刷屏 |
| `find_files` | read 及以上 | `*` / `**` 通配，工作区内 |
| `search_content` | read 及以上 | ripgrep → PowerShell `Select-String` 降级 |
| `system_info` | read 及以上 | OS / 架构 / PowerShell 版本 |

> 任何工具的越界路径都会立即返回 `blocked: true`，模型收到提示后会改换方式或停下来说明。

## 7. 安装与启动 / Install & launch

### 7.1 用户安装（已发布）

```bash
# 默认安装到当前用户目录（不需管理员权限）
hermes-suite-windows-x86_64.exe
```

安装脚本会：
- 创建开始菜单与桌面快捷方式（`Hermes Buddy`）。
- 不安装任何系统服务，不写注册表自启。
- 不自动安装 Git / Node 等依赖——Buddy 检测到缺什么，在「设置 → 本机工具」一键安装（用 winget 优先、PowerShell Gallery 兜底；失败会给出可执行的 PowerShell 命令让用户手动跑）。
- **安装/升级时清空本机旧缓存与配置**（v3.4.1+），保证新版本从干净状态启动。

#### 7.1.1 安装时清理说明 / Install-time cleanup

安装（含覆盖升级）时会先结束正在运行的 `Hermes Buddy.exe`，然后删除：

| 路径 | 内容 |
| --- | --- |
| `%APPDATA%\@hermes\buddy-desktop` | 连接配置、智能体配置、日志、服务端部署包、Electron 各类缓存（**userData 全清**） |
| `%APPDATA%\hermesbuddy-desktop`、`%APPDATA%\Hermes Buddy` | 早期版本遗留目录（兜底） |
| `%LOCALAPPDATA%\@hermesbuddy-desktop-updater` 等 | electron-updater 下载缓存，单份 80MB 上下 |

卸载时同样清理以上目录。

两点需要注意：

1. **userData 目录名是 `@hermes\buddy-desktop`，不是 `Hermes Buddy`** —— 因为 `package.json` 的 `name` 是 `@hermes/buddy-desktop`，Electron 会把 scope 保留成一级目录；`productName`（`Hermes Buddy`）只影响快捷方式和窗口标题。改安装脚本时别再弄错。
2. **升级后需要重新填一次连接信息**，服务端若仍是旧通道，Buddy 会提示重新部署（通道版本协商）。
3. `%APPDATA%\Hermes` 与 `%LOCALAPPDATA%\hermes` 属于另一个 Hermes 应用，安装脚本**不会**碰。

### 7.2 开发运行

```bash
# 在仓库根目录
npm install                # workspace 内 @hermes/* 自动 link
npm test                   # 全部包的 node --test（93 项）
npm run start:buddy:win    # 开发启动（PowerShell 包装，清理 ELECTRON_RUN_AS_NODE）
npm run smoke:buddy        # 启动→加载→退出，退出码即结果
npm run build:buddy:win    # 输出 apps/hermes-buddy-desktop/dist/hermes-suite-windows-x86_64.exe
```

**Gotcha**: PowerShell 启动 Electron 时会继承 `ELECTRON_RUN_AS_NODE=1`，导致 `app` 变 `undefined`。`scripts/dev-buddy.ps1` 已经清掉这个变量。无 GPU 环境（远程会话、容器）冒烟时也要 `--disable-gpu --no-sandbox`。

## 8. 首次配置 / First-time setup

> **v3.0 起：连接页不再是「一张长表单 + 连接模式二选一」，而是三步向导 + 已保存连接列表（v3.1.0 起支持多网关切换与通道路径前缀）。**
> 同时**本地模式已移除** —— v2.3.10 之后只有**通道模式**一种：决策在 Hermes 服务端外挂通道 `:8822`，
> 本机只做工具筛选与执行。因此你**不需要再自己找推理端点和 API Key**，向导会替你办好。

打开 Buddy，进入**连接向导**：

**第 1 步 · 选择部署状态**

| 选项 | 什么时候选 | 向导会做什么 |
|---|---|---|
| **已部署 Hermes** | 服务器上已经跑着 Hermes | SSH 上去体检：`.hermes` 目录、`hermes` CLI、22122 / 8822 / 8811 端口监听、通道 `/health` 版本，**并自动取回 API Key** |
| **全新部署** | 服务器还是裸机 / 没装过 | SSH 上去推送部署包并跑 `deploy.sh`（装直通代理 `:8811` + WS 通道 `:8822`，注册 systemd 开机自启），完成后同样体检并取回 API Key |

**第 2 步 · 填 SSH 凭据**

| 字段 | 必填 | 填什么 |
|---|---|---|
| 服务器地址 | **是** | `192.168.0.246`（IP 或域名） |
| SSH 用户 | 否 | 默认 `root` |
| SSH 端口 | 否 | 默认 `22` |
| 认证方式 | **是** | 密码，或私钥文件路径 |

向导会实时打印 SSH / 部署日志。取回的 API Key 会自动填进第 3 步，你不用手动复制。

**第 3 步 · 确认并连接**

| 字段 | 必填 | 填什么 | 备注 |
|---|---|---|---|
| Hermes 主机 | **是** | `192.168.0.246` | 由第 2 步自动填充。填了它，Gateway 自动推导为 `:22122`、通道自动推导为 `ws://<host>:8822/api/buddy/channel` |
| API Key | **是** | `A4Ux-...` | 由 SSH 体检自动取回（服务端 `~/.hermes/.api_server_key` 或 `data/.env` 的 `API_SERVER_KEY`），走 Windows DPAPI 加密保存 |
| 通道地址（WS） | 否 | 留空 | 留空 = 自动推导。只有部署到非默认端口或走了 wss 反向代理时才手填 |
| Hermes Gateway 地址 | 否 | `http://192.168.0.246:22122` | **默认端口是 22122，不是 22124**。用于会话登记；留空/不通只降级，不影响聊天和本机工具 |
| 部署管理地址 | 否 | 留空按 Gateway 同主机 `:8700` 推导 | 不通不影响本地工具链路 |
| Profile | 否 | 默认 `buddy` | Gateway 会话用的名字 |
| 工作目录 | **是** | `D:\work\buddy` | 强制绝对路径，首次使用会建好 |
| 权限档位 | 否 | `读 + 写`（推荐） | 控制工具集是否启用危险动作 |
| 通道路径前缀 | 否 | `/api/buddy/channel` | 仅当服务端通道经过反向代理、带了非默认路径前缀时才改（如 `/prefix/buddy`）；留空用默认路径 |

**已配置后再启动**：自动恢复连接；恢复失败就跳到第 3 步让你确认参数。

### 8.3 多网关（已保存连接）与通道前缀（v3.1.0）

- **多网关管理**：连过的 Hermes 主机都会被 DPAPI 加密保存为一条"连接"。连接页会先列出**已保存的连接**，
  点「连接」秒切并直连，点「删除」移除本地配置（不碰服务端）；点「＋ 新建连接」回到向导，
  **向导第一步左上角会出现「← 返回已保存连接」，随时退回列表**（v3.1.1 补的细节）。
  侧边栏「管理连接」随时回到这个列表。这借鉴了 Hermes Desktop 的多网关思路，但 Buddy 的每条连接都是
  **通道模式**（决策在服务端、手在本地），与 Desktop 的纯远程 Gateway 不同。
- **通道路径前缀**：若服务端通道走了反代、URL 带了非默认前缀，在高级设置里填「通道路径前缀」即可，
  不用改整段 WS 地址。
- **新增智能体 vs 配置智能体（界面已区分）**：侧边栏「＋ 新智能体」打开的是**独立新建弹窗**（名称 / 工作目录 /
  模型 / 权限），创建后自动打开该智能体的配置面板；齿轮图标才是「配置当前智能体」。两者入口不同、不会混淆。
  聊天框下方的**工作目录标签**现在严格跟随**当前激活智能体**的配置：若智能体单独设了工作目录就显示它并标注
  「来自智能体配置」，否则回落到连接默认并标注「连接默认」——修复了 3.0 里标签与设置不一致的问题。


### 8.1 端口约定

- **22122**：Hermes Linux 服务端 Gateway API 默认端口（`POST /api/sessions`）。
  ⚠️ 它上面的 `/v1/chat/completions`（api_server 平台）是**服务端 agent 端点**：实测（2026-09-13/14）会
  无视请求里的 tools、注入 1.2~4 万 token 的自有系统提示、在服务器本地执行命令——Buddy **不能**用它。
  补充实测：把 `model` 换成底层真实模型名（`ark-code-latest`）结果完全一样，**换模型名绕不过去**。
- **8822**：**Buddy WS 工具通道（服务端外挂组件 `hermes-buddy-channel`）**，通道模式专用。
  它读 Hermes 自己的 `config.yaml` + `.env`，在 Hermes 主机上跑 Agent 循环（复用上游 LLM）、把 `tool_call`
  经 WebSocket 卸载给已连接的 Buddy 客户端；客户端过命令护栏后在 Windows 本地执行，结果回传。
  零第三方依赖（只用 Python 标准库），由「服务端准备脚本」第 4h 步部署，注册为 systemd 服务 `hermes-buddy-channel`，
  开机自启；鉴权复用 `API_SERVER_KEY`（与 8811 同源）。通道地址默认 `ws(s)://<host>:8822/api/buddy/channel`。
- **8811**：**Buddy 推理直通代理**（v2.3.10 起，由「服务端准备脚本」第 4 步在 Hermes 主机上部署）。
  它读 Hermes 自己的 `config.yaml`（`model.base_url` / `name` / `api_key`），对外提供标准 OpenAI 兼容
  `/v1/chat/completions`，**原样透传 tools**、不做任何 agent 编排、不注入系统提示，用 Gateway 的 API Key 鉴权。
  零第三方依赖（只用 Python 标准库），注册为 systemd 服务 `hermes-buddy-inference`，开机自启。
- **8645**：`hermes proxy` 的默认端口。注意它**不是本地推理端点**，而是把请求转发给 OAuth 供应商
  （Nous Portal / xai）的代理；子命令是 `start`（不是 `run`）。它需要 OAuth 登录，当前环境用不上。
- **外部 / 自建推理端点**：火山方舟 Ark、DeepSeek、通义、本地 vLLM、Ollama 等，
  只要原生支持 function calling 就能直接填进 Buddy 的「推理端点」（高级用法，密钥存在本机）。
- **8700**：Hermes 部署管理服务（`/api/provisioning/products`）
- **22124**：仅 Windows 端 Buddy Gateway 端口（**非 Hermes 默认**，仅当你在 Windows 上跑了 hermes-buddy-gateway 时才用）

> 版本历史教训：v2.3.6 曾认为「LLM 与 Gateway 同端口 22122」，v2.3.8 曾认为「hermes proxy 是本地推理端点、默认 8800」，
> v2.3.9 曾让用户把上游供应商地址 + 密钥填进 Windows 客户端 —— 三条都被实测或架构评审证伪。
> **当前（v2.3.10）结论：Hermes 不对外提供纯推理能力（22122 上只有 5 个端点，全是 agent 语义或管理用途），
> 所以在 Hermes 主机上补一层零依赖直通代理 `:8811`；Buddy 只认 Hermes 一个地址，上游密钥不出服务器。**

### 8.2 为什么 Buddy 不能直接用 22122（架构说明）

Buddy 与 Hermes 的 `/v1/chat/completions` 是**两种正交的 API 语义**，不是同一件事的两种配置：

| | Buddy 需要的语义 | Hermes 22122 的语义 |
|---|---|---|
| 收到 | `messages` + `tools` | `messages` |
| 返回 | 一个 `tool_call`（**不执行**） | 最终文本（**已在服务端执行完工具**） |

实测证据：向 22122 发带 `tools` 的请求，`tool_calls` 恒为 `null`、`prompt_tokens` 恒为 12178（被注入自有系统提示）、
在服务器 `/root` 真的跑了 `ls`；换成底层真实模型名 `ark-code-latest` 结果完全一样。
`/v1/responses` 同理。22122 的路由表只有 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、
`/health`、`/api/sessions`，`/api/proxy`、`/api/passthrough`、`/api/inference`、`/api/models` 全是 404。

所以 v2.3.10 在 Hermes 主机上补了直通代理：它只做"转发 + 鉴权"，把 Hermes 配好的上游以 Buddy 需要的语义暴露出来。

> 旧版本文档把 22124 列为默认是错的——它只是 Windows 端 Buddy 自身的 gateway。Hermes Linux 服务端实际是 22122。Buddy 现在会在 Gateway 留空时自动从 LLM 端点推导到 :22122；不通也只是降级，不会阻塞。

点「验证并配置 Buddy」后会发生：

1. 验证 LLM 端点：`POST /v1/chat/completions` 探测；不通就拒绝进入。
2. 初始化工作目录：建 `.hermes/`、写 AGENTS.md 模板、复制技能到 `.hermes/skills/`。
3. 登记 Gateway（可选）：如果用户填了 baseUrl 就做健康检查 + 创建会话 + 部署清单；任一失败或没填都降级继续。
4. 加密保存凭据。

### 8.2 服务端一次性准备 / Server-side one-time prep

**关键事实**：Hermes 服务端默认**不**对外监听 gateway / LLM 端口，且 `API_SERVER_KEY` 只在服务端 `/root/.hermes/.api_server_key` 或 `data/.env` 里。Buddy 是客户端，必须服务端配合。

服务端至少要给三样：

| 项 | 默认状态 | 需要做什么 |
|----|----------|-----------|
| **推理直通代理 `:8811`** | 未部署 | 跑一次「生成服务端准备脚本」即可自动部署（见下），它会读 Hermes 自己的上游配置 |
| **WS 工具通道 `:8822`** | 未部署 | 同样的「服务端准备脚本」第 4h 步一并部署 `buddy-channel.py`（飞书式通道），注册 systemd 服务 `hermes-buddy-channel`；**通道模式必选** |
| API Key | 服务端随机生成 | 用「生成服务端准备脚本」最后一步打印出来；Gateway、推理端点、WS 通道**共用同一个 Key** |
| Gateway `:22122` 对外（可选） | 通常绑 `0.0.0.0` | 只用于会话登记/部署清单；不通 Buddy 仍能干活（降级模式） |

**最省事的做法（只需要填主机 + API Key）**：

1. 在 Buddy 连接页填「Hermes 主机」（如 `192.168.0.246`）和 API Key，**推理端点留空**。
2. 点「生成服务端准备脚本」 —— 复制脚本到 Hermes 主机以 root 身份执行一次：
   - 检查 Hermes 进程状态 + pid 文件 + **全部 TCP 监听端口**
   - 看 `config.yaml` 里的 `host` / `bind` 字段，提醒 127.0.0.1 改成 0.0.0.0
   - **第 4 步（核心）：部署 Buddy 推理直通代理** ——
     (a) 打印 Hermes 正在用的上游模型与凭证（密钥打码）；
     (b) 写出零依赖 Python 代理（只用标准库）并注册为 systemd 服务 `hermes-buddy-inference`，开机自启；
     (c) 自动探测上游 chat 路径（方舟有 `/api/v3` 与 `/api/coding/v3` 两种形态）并**实测 function calling**；
     (d) 把验证通过的上游写进 `~/.hermes/buddy-proxy.env`，再经代理复验一次
   - **第 4h 步（通道模式需要）：部署 WS 工具通道** —— 从安装包内提取 `buddy-channel.py`（零依赖 Python），
     写 `buddy-proxy.env` 同级的 `buddy-channel.env`，`nohup` 启动并在 `:8822` 监听 `/api/buddy/channel`，
     用最小 function-calling 请求实测透传；注册 systemd 服务 `hermes-buddy-channel`，开机自启。
   - 重启 gateway（优先 systemd / `hermes gateway restart`，绝不带 `--host`、绝不盲杀）
   - 打印 API Key 与最终该填的三项
3. 回到 Buddy 点「验证并配置 Buddy」。若端点不支持 function calling，Buddy 会在连接时明确告诉你。
4. 想看完整密钥就 `SHOW_KEYS=1 ./脚本.sh`（默认打码，方便把输出贴出来求助）。

### 8.2 服务端部署压缩包（v2.3.10+，随安装包自带）

除了运行时动态生成准备脚本，Buddy 安装包还自带一份**完整的服务端部署压缩包**（`hermes-buddy-server-deploy.tar.gz`，约 18 KB），包含：

| 文件 | 说明 |
|------|------|
| `buddy-inference-proxy.py` | 推理直通代理（端口 8811），零依赖 Python |
| `buddy-channel.py` | WS 工具通道（端口 8822），零依赖 Python |
| `deploy.sh` | Hermes 侧执行脚本：部署两个组件 + 探测上游 + 写 env + 健康检查（依赖 systemd） |
| `deploy.ps1` | Windows 侧推送脚本：用 OpenSSH 的 scp/ssh 一键推送到 Hermes 并远程执行 deploy.sh |
| `start-channel.sh` | **独立启动脚本**（v3.1.1+，Docker / 无 systemd）：不依赖 systemd，前台或 `--daemon` 拉起 `buddy-channel.py` |
| `docker-compose.example.yml` / `Dockerfile.example` | Docker 通道部署示例（sidecar 容器或独立镜像） |
| `README.md` | 压缩包说明 |

**三种部署方式：**

1. **手动拷贝**：点连接页「生成服务端准备脚本」-> 弹窗里的「导出部署包」按钮，把 `.tar.gz` 拷到 Hermes，解开跑 `sudo bash deploy.sh`。
2. **一键推送**（Windows 有 OpenSSH 密钥）：在同一个弹窗里点「部署到服务器 ▾」，填 Hermes 主机 + SSH 私钥，点「推送并部署」--deploy.ps1 会 scp 压缩包到 Hermes 并 ssh 解压执行 deploy.sh，全程实时回显输出。
3. **Docker / 无 systemd**（v3.1.1+）：点弹窗里「下载通道脚本 (Docker/手动)」按钮，把 `start-channel.sh` 下载到本地后传到 Hermes 主机，执行 `bash start-channel.sh`（前台，适合容器主进程）或 `bash start-channel.sh --daemon`（后台）。脚本会自动探测 `HERMES_HOME` / `API_SERVER_KEY` / `buddy-channel.py`，找不到时可用 `BUDDY_CHANNEL_DOWNLOAD=1` 从 GitHub 拉取。完整 Docker 编排见部署包内 `docker-compose.example.yml` 与 `Dockerfile.example`。

> 两种部署方式与「生成准备脚本」**并存**：准备脚本是运行时把 Python 源码以 heredoc 内嵌到 bash 里生成；压缩包是把真实 `.py` 文件 + 执行脚本直接打包。两条路径部署的组件完全相同，用户按场景选。

> If the Hermes Linux server has gateway / LLM ports bound to `127.0.0.1` (the default), Buddy cannot reach them. Use **"先诊断"** to see which ports are blocked, then **"生成服务端准备脚本"** to get a copy-paste script that fixes the bind address and prints the API key. The whole loop runs from the Buddy connect screen — no SSH skills required on the Buddy user side.

## 9. 日常使用 / Day-to-day

- **顶部状态条**：左侧显示当前 LLM 端点 + profile；中间状态点（绿=就绪、黄=忙、红=错）；右侧权限徽章显示当前档位。
- **工作目录**：聊天页底部的小灰条显示当前工作目录，点「设置 → 工作区」可切换。
- **工具调用**：聊天流里每条工具调用是一张卡片，显示名称、参数、耗时、输出（最多 8000 字）。
- **危险命令**：run_command 触发了黑名单或权限档位要求确认时，会弹出模态对话框；超时（120s）默认拒绝。
- **停止**：聊天中可点「停止」立即中断当前回合。
- **记忆**：每天 Buddy 会自动追加一条「执行了 N 个操作：…」，可到「设置 → 记忆」编辑长期记忆。
- **技能**：内置 3 个（windows-shell / file-editing / git-workflow）；可在「设置 → 技能」新增工作区级技能，会覆盖同名内置技能。

## 10. 更新策略 / Update strategy

没有引入 `electron-updater`：NSIS 静默更新需要代码签名证书，且大陆直连 GitHub 不稳定。
当前实现为「检查 latest release → 比对语义化版本 → 给出 ghfast.top 镜像下载地址」，
安装动作由用户运行新安装包完成。

## 11. 待办 / Open items

- 设备发现 UI：`hermes-provisioning` 已能校验设备清单，界面上还没有勾选列表。
- `packages/hermes-device-agent`：仍只有 README，localhost IPC 服务未实现。
- 会话历史持久化：目前只保存在主进程内存，重启即清空。
- 工具调用卡片在输出过长时折叠/展开按钮尚未实现（目前是滚动框）。
- 中文菜单项需要安装包做成多语言（当前 NSIS 默认英文）。