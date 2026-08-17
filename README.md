# Hermes Agent Suite

一站式 AI Agent 套件 · 开源版安装配置

## 概述

Hermes Agent Suite 是基于 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的开源 AI Agent 套件，提供：

- 🤖 **Hermes Agent 核心** - AI 引擎 + Skills + Plugins
- 👁️ **具身智能** - 视觉识别 + 语音交互 + 结晶反射引擎
- 📚 **知识库** - AnythingLLM 文档检索
- 🖥️ **HermesBuddy 桌面端** - 可视化管理界面（Windows / Linux）
- 🏠 **IoT 智能家居** - 小米/涂鸦设备控制

## 安装

```bash
# 下载安装包后执行
bash hermes-suite-v1.x.x-linux-x86_64.sh
```

安装向导会引导你完成：
1. 环境检查（Python / Node.js / Git）
2. 模型配置（API Key / Provider）
3. 硬件设备发现（摄像头 / 麦克风 / 扬声器 / GPU）
4. 功能模块选择
5. 结晶体系配置（云服务商 AK/SK + 基板模型）
6. HermesBuddy 桌面客户端下载

## 服务端口

| 服务 | 端口 | 说明 |
|------|------|------|
| Setup Wizard / Dashboard | 9800 | 安装向导与状态面板 |
| HermesBuddy Server | 8700 | API 代理（需客户端访问） |
| Crystal Reflex | 9124 | 结晶反射引擎 |
| Image Service (OCR) | 9121 | 视觉识别 API |
| Hermes Gateway | - | Agent 网关（systemd） |

## 结晶反射引擎

Crystal Reflex 使用 Qwen3-0.6B 作为基板模型：

- **默认行为**：首次启动自动从 ModelScope/HuggingFace 下载 Qwen3-0.6B（约1.2GB）
- **微调模型**：如已训练结晶微调模型，设置环境变量 `CRYSTAL_MODEL_PATH=/path/to/model`
- **训练流程**：使用 LLaMA-Factory 进行 SFT 全参微调，配置见 `crystallization/qwen3_06b_full.yaml`

## 项目结构

```
hermes-suite/
├── build-installer.sh          # 自解压安装包构建脚本
├── scripts/
│   ├── setup-server.py         # Web 安装向导后端
│   ├── detect-devices.sh       # 硬件设备检测脚本
│   └── sanitize.py             # 发布前去敏脚本
├── web-setup/
│   └── index.html              # Web 安装向导前端 (SPA)
├── crystallization/
│   ├── crystal_reflex.py       # 结晶反射推理服务
│   ├── reflection_engine.py    # 反射引擎
│   ├── analyzer.py             # 分析器
│   ├── kv_cache_optimizer.py   # KV Cache 优化
│   ├── export_training_data.py # 训练数据导出
│   ├── qwen3_06b_full.yaml     # LLaMA-Factory 训练配置
│   └── deploy_training.sh      # 训练部署脚本
├── workbuddy/                   # HermesBuddy 服务端
├── ocr-service/                 # 视觉识别服务
├── DESIGN.md                   # 架构设计文档
└── TECH-SELECTION-linux-packaging.md  # 技术选型文档
```

## 从源码构建

```bash
# 1. 准备打包目录
mkdir -p /tmp/hermes-pkg
cp -r scripts web-setup crystallization workbuddy ocr-service /tmp/hermes-pkg/

# 2. 放入 HermesBuddy 客户端
cp HermesBuddy-Setup-1.4.2.exe /tmp/hermes-pkg/buddy-dist/
cp HermesBuddy-1.4.2.AppImage /tmp/hermes-pkg/buddy-dist/

# 3. 去敏
python3 scripts/sanitize.py --source /tmp/hermes-pkg --dest /tmp/hermes-pkg

# 4. 构建安装包
cd /tmp/hermes-pkg
tar czf /tmp/payload.tar.gz --exclude='./data/.setup_complete' .
cat build-installer.sh /tmp/payload.tar.gz > hermes-suite-v1.x.x-linux-x86_64.sh
chmod +x hermes-suite-v1.x.x-linux-x86_64.sh
```

## HermesBuddy 桌面客户端构建

```bash
cd desktop/
npm install
# Windows
npx electron-builder --win --x64
# Linux (在 Linux 上构建)
ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" npx electron-builder --linux AppImage --x64
```

## 技术栈

- **后端**: Python 3 (http.server, transformers, torch)
- **前端**: 原生 HTML/CSS/JS SPA
- **桌面端**: Electron + electron-builder
- **AI 模型**: Qwen3-0.6B (结晶反射), 火山视觉 (图片识别)
- **IoT**: python-miio
- **知识库**: AnythingLLM

## License

MIT

## Author

陈嗣俊
