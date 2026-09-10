# Hermes Buddy — Windows 客户端 / Windows Client

> 中文在前，English follows each section.

## 1. 定位 / Positioning

Buddy 不是一个远程 agent 的 Web 包装。它做的是**让远端 Hermes 做决策、让本机 Windows 做执行**：

- **决策**：把消息、工具 schema、本地工作区描述发给 Hermes 侧的 OpenAI 兼容端点（默认 `:8800/v1/chat/completions`）。Hermes 走标准 function calling 返回要做什么。
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
    prompts.js                 系统提示词：身份 + 环境 + 记忆 + 技能 + 工具链
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
```

## 3. 数据流 / Data flow

```
render → IPC(buddyApi) → main.js
                              ↓
                  ┌───────────┴────────────┐
                  │                        │
          SessionManager             Window Dialog
                  │                        │
   brain.chat() ───→ Hermes :8800         危险命令弹窗
   (OpenAI compat)   (function calling)   (用户点头/拒绝)
                  │                        │
                  ↓                        │
           AgentLoop.run()                 │
                  │                        │
           tools.invoke() ←─── onConfirm()─┘
                  │
                  ↓
         Shell / fs (workspace)
```

每个对话回合：

1. 渲染层发 `chat({requestId, text})` 给主进程。
2. 主进程把 system prompt（含身份、技能、记忆、工作区描述、工具链现状）和历史消息塞进 OpenAI chat completion 请求。
3. 模型返回 tool_calls → 本地工具跑 → 结果拼回 messages → 再发模型 → 直到模型停止调用工具。
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

打开 Buddy，看到「连接你自己的 Hermes」表单：

| 字段 | 必填 | 填什么 | 备注 |
|------|------|--------|------|
| 推理端点（LLM） | **是** | `http://192.168.0.246:8800/v1/chat/completions` | Hermes 模型服务的 OpenAI 兼容端点。Buddy 真正在用这个，必须能通。 |
| Hermes Gateway 地址 | 否 | `http://192.168.0.246:22122` | **Hermes 服务端默认端口是 22122，不是 22124**。用于会话登记与部署清单；留空 Buddy 仍能干活（降级模式）。 |
| 部署管理地址 | 否 | 留空按 Gateway 同主机 `:8700` 推导 | 不通不影响本地工具链路 |
| API Key | **是** | `~/.hermes/data/.env` 中的 `API_SERVER_KEY` | 走 Windows DPAPI 加密保存 |
| Profile | 否 | 默认 `buddy` | Gateway 会话用的名字 |
| 默认模型 | 否 | `hermes-agent` | 留空时是 hermes-agent |
| 工作目录 | **是** | `D:\work\buddy` | 强制绝对路径，首次使用会建好 |
| 权限档位 | 否 | `读 + 写`（推荐） | 控制工具集是否启用危险动作 |

### 8.1 端口约定

- **22122**：Hermes Linux 服务端的 Gateway API 默认端口（`POST /api/sessions`）
- **8800**：Hermes LLM router（`POST /v1/chat/completions`，OpenAI 兼容 + function calling）
- **8700**：Hermes 部署管理服务（`/api/provisioning/products`）
- **22124**：仅 Windows 端 Buddy Gateway 端口（**非 Hermes 默认**，仅当你在 Windows 上跑了 hermes-buddy-gateway 时才用）

> 旧版本文档把 22124 列为默认是错的——它只是 Windows 端 Buddy 自身的 gateway。Hermes Linux 服务端实际是 22122。Buddy 现在会在 Gateway 留空时自动从 LLM 端点推导到 :22122；不通也只是降级，不会阻塞。

点「验证并配置 Buddy」后会发生：

1. 验证 LLM 端点：`POST /v1/chat/completions` 探测；不通就拒绝进入。
2. 初始化工作目录：建 `.hermes/`、写 AGENTS.md 模板、复制技能到 `.hermes/skills/`。
3. 登记 Gateway（可选）：如果用户填了 baseUrl 就做健康检查 + 创建会话 + 部署清单；任一失败或没填都降级继续。
4. 加密保存凭据。

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