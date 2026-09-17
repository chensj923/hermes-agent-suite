# Hermes Buddy v3.7.0 发布说明

> 本次发布涵盖 v3.5.0 之后的全部改动（v3.6.x 系列此前未发到 GitHub）。
> 核心主题：**多模态输入**、**记忆闭环与结晶**、**按智能体隔离的对话历史**、**启动稳定性**。

## 新增：按智能体分组的对话历史（v3.7.0）

之前所有智能体共用一份对话记录，切换智能体看到的是全局混合历史，而且重开客户端后全空——「聊过什么」完全没有留存。

- **按 `agentId` 隔离**：transcript 改为按智能体从 `agentTranscripts` 取，切到哪个智能体就看到它自己的历史。
- **问答成对记忆**：`remember()` 同时记 user 提问与 assistant 回复，两条发送路径（通道 / 直连 Brain）都补记，历史不再只有问没有答。
- **落盘持久化**：新增 `saveTranscript()` / `loadTranscript()`，写到 `transcripts/<agentId>.json`；启动时在所有 `loadHistory()` 调用点旁同步加载。重开 Buddy 历史完整回来。
- **清空当前对话**：聊天头部新增清空按钮，确认后同时清 messages + transcript 及两个落盘文件；清缓存时连 `transcripts` 目录一并清理。
- 测试：55/55 全过（含 history-persist 5 项 + 真实用户场景 e2e 6 项）。

## 新增：记忆闭环 + 会话持久化 + 结晶（v3.6.0 ~ v3.6.9）

Buddy 从「每次对话都从零开始」变成「跨会话、跨设备记得住」。

- **记忆功能闭环（协议 1.4）**：`remember` 工具（第 8 工具）写入 global / project 两层记忆；上下文注入 `buildContextBlock()` 汇总 memory + AGENTS + skills + workspace + 时间（12000 字上限），经 `systemExtra` 每轮刷新注入。
- **服务端会话持久化 + resume**：session 落到 `HERMES_HOME/buddy-sessions/<sid>.json`，断线重连可续上。
- **结晶 1.5**：`_crystallizeInBackground()` 把 globalMem / projectMem / AGENTS.md 经 `channel.syncMemory` 送到服务端 `HERMES_HOME/buddy-memory/{GLOBAL,AGENTS,PROJECT}.md`，`_build_system_prompt()` 自动注入——换客户端、清本地记忆后仍能继承已结晶的知识。
- **修复结晶被覆盖**：客户端注入 `system_extra` 时会整体覆盖已注入的结晶记忆，导致换机后继承不到。改为保留现有 system 消息（含结晶），只替换本机上下文段。
- **修复记忆不生效**：服务端每轮 + resume 后都刷新 `system_extra`；`setWorkspace` 时把记忆注入 ToolRegistry；客户端新增记忆诊断面板。
- **连接版本嗅探**：已保存连接列表里显示对端 profile 版本，一眼看出服务端是不是旧版。
- 配套测试：`test-crystallization-e2e.py` 16 项断言（结晶落盘 / 注入 system prompt / resume 继承 / 不与结晶冲突）、`session-persist.test.js`、`history-persist.test.js`。

## 新增：多模态输入（图片 / 文件 / 语音 / 视频）

- 归一化入口 `parts.js#partsToContent()`，支持 text / image(base64) / file / audio(转写) / video(转写 + 关键帧)。
- **语音视频原始文件不出本机**，只把转写文本与关键帧送上游。
- 图片超过 1MB 或长边超过 1600px 才压缩（JPEG 0.82）；单次发送预算 3MB，单文件上限 50MB。
- 转写走本地 whisper.cpp（只吃 16bit PCM WAV，渲染层重采样到 16k 单声道），ffmpeg 可选；错误处理取末尾 3 行并剥时间戳。
- 媒体引擎一键安装；附件区明确标注大小限额，图片本地处理过程可视化。
- 修：录音中直接点发送会漏发附件；录音本地转 16k WAV 后 whisper 转写不再失败。

## 修复：启动与错误提示

- **启动即静默退出**：部分 Windows 10 机器上 GPU 进程崩溃会导致 Electron 无声退出（无日志、无 crash dump，exit code=0）。现在全局禁用硬件加速并加 `no-sandbox`，优先保证能起来。
- **错误提示更准**：区分「连不上」与「被掐断」，上游错误带上实际地址，不再误导成「附件太大」。

## 升级说明

- 通道版本 **CHANNEL_VERSION = 1.5**（1.1 模型透传 / 1.2 错误帧 code+hint / 1.3 多模态 / 1.4 持久化 resume / 1.5 结晶）。
- 服务端建议升级到带结晶修复的 1.5 通道版本：exe 内已附带 `server-deploy.tar.gz`，在 Buddy 里执行部署 / 升级即可把现有服务端升上去。
- 历史与记忆目录位于 `%APPDATA%\@hermes\buddy-desktop`（`history/<agentId>.json`、`transcripts/<agentId>.json`、`memory/`）。

## 已知问题

- 未签名安装包，Windows SmartScreen 可能拦截，选择「仍要运行」即可。
- 语音 / 视频转写依赖本地 whisper.cpp，首次使用需通过「媒体引擎一键安装」下载模型。
