# Hermes Agent Suite — 开源产品化方案

## 产品定位
一站式 AI Agent 套件，整合三大系统：
1. **Hermes Agent** — 核心 AI 引擎（CLI + Gateway + Skills + Plugins）
2. **HermesBuddy** — 桌面管理界面（Electron，跨平台）
3. **Embodied Intelligence** — 具身智能层（视觉/语音/IoT）

## 安装包架构

```
hermes-suite-installer.sh (自解压脚本)
├── install.sh                    # 主安装脚本
├── web-setup/                    # Web 配置向导（纯 HTML+JS）
│   ├── index.html               # 单页应用
│   ├── setup.js                 # 安装逻辑
│   └── style.css
├── hermes-agent/                 # Hermes Agent 核心
│   ├── pyproject.toml
│   ├── src/
│   └── skills/
├── hermesbuddy/                  # 桌面客户端源码
│   ├── desktop/
│   └── server.js
├── embodied/                     # 具身智能模块
│   ├── crystal-reflex/
│   ├── smart-home/
│   └── voice-bridge/
├── scripts/                      # 辅助脚本
│   ├── detect-devices.sh        # 硬件检测
│   ├── setup-model-router.py    # 模型路由配置
│   └── generate-config.py       # 配置文件生成
└── templates/                    # 配置模板
    ├── config.yaml.tpl
    ├── model-router.tpl
    └── systemd/*.service.tpl
```

## 安装流程（5步）

### Step 1: 环境检查
- Python ≥ 3.11
- Node.js ≥ 18
- Docker (可选)
- GPU 驱动 (可选)
- 磁盘空间 ≥ 10GB

### Step 2: 模型供应商配置
Web UI 表单：
- Provider 选择（OpenAI / Anthropic / DeepSeek / Volcengine / Qwen / Local LM Studio / Ollama）
- API Key 输入
- Model 选择（下拉列表，根据 provider 动态加载）
- 连接测试按钮
- 支持多 provider fallback 链配置

### Step 3: 硬件设备发现
自动检测并展示：
- 📷 摄像头：`v4l2-ctl --list-devices` + `/dev/video*`
- 🎤 麦克风：`arecord -l` + PulseAudio sources
- 🔊 扬声器：`aplay -l` + PulseAudio sinks
- 🖥️ GPU：`nvidia-smi` / `lspci | grep VGA`

用户在 Web UI 中勾选要启用的设备。

### Step 4: 功能模块选择
复选框：
- [x] Hermes Agent 核心
- [x] HermesBuddy 桌面客户端
- [ ] 具身智能（视觉+语音）
- [ ] IoT 智能家居
- [ ] 知识库（AnythingLLM）
- [ ] 微信公众号集成

### Step 5: 安装 & 启动
- 生成去敏后的配置文件
- 安装 Python/Node 依赖
- 注册 systemd 服务
- 下载 HermesBuddy EXE（Windows 用户）或构建 Linux 版
- 启动 gateway + web dashboard
- 输出访问地址和初始密码

## 去敏策略

| 类别 | 处理方式 |
|------|---------|
| API Keys | 替换为 `YOUR_API_KEY_HERE` 占位符 |
| AppSecret | 替换为空字符串，安装时由用户填入 |
| SSH 密码 | 移除，改为 SSH key 认证引导 |
| 私有 IP | 保留 localhost，其余替换为 `<YOUR_SERVER_IP>` |
| state.db | 不包含，安装后自动创建 |
| session 历史 | 不包含 |
| crystallization.db | 清空数据，保留 schema |
| .env 文件 | 只保留变量名，值留空 |

## 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| 安装包格式 | self-extracting .sh | 零依赖，任何 Linux 发行版可用 |
| Web 向导 | 纯 HTML+JS（无框架） | 最小依赖，内嵌在安装包中 |
| 后端服务 | Python HTTP server | 安装过程中临时启动，完成后切换为 systemd |
| 设备检测 | shell 脚本 | v4l2/alsa/pactl/nvidia-smi |
| 进程管理 | systemd | Linux 标准 |
| 桌面客户端 | Electron (跨平台构建) | 已有代码基础 |

## 开源仓库结构

```
hermes-suite/
├── README.md
├── LICENSE (Apache 2.0)
├── installer/
│   ├── build.sh              # 构建安装包脚本
│   ├── install.sh            # 主安装脚本
│   └── web-setup/
├── agent/                    # Hermes Agent 核心
├── buddy/                    # HermesBuddy
├── embodied/                 # 具身智能
├── docs/
│   ├── getting-started.md
│   ├── configuration.md
│   └── architecture.md
└── docker/                   # Docker Compose 部署（备选）
```
