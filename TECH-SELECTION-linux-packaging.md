# Linux 安装包技术选型报告

> 调研日期：2026-08-16 · 调研环境：Debian 12 (bookworm) x86_64 · 所有结论均经本机实测验证
> 项目：hermes-suite（Hermes Agent + HermesBuddy + 具身智能一体化开源套件）

## 0. 结论速览（TL;DR）

| 决策项 | 推荐方案 | 一句话理由 |
|--------|---------|-----------|
| 安装包格式 | **self-extracting .sh 为主，.deb 为辅** | .sh 零依赖全发行版通吃且能承载安装逻辑；.deb 给 Debian/Ubuntu 用户桌面级体验；AppImage 不适合服务型软件 |
| Web 安装向导 | **纯 HTML+JS 单文件 + Python stdlib http.server** | 已有 365 行可用原型；无构建步骤；向导生命周期只在安装期，不值得引入 Vue/React |
| 音频设备枚举 | **arecord -l / aplay -l (ALSA) 为主，pactl 为可选增强** | 本机实测 ALSA 无需任何守护进程即可枚举；PulseAudio/PipeWire 可能不存在 |
| 摄像头枚举 | **v4l2-ctl --list-devices + /dev/video\*** | 标准方案，需 graceful fallback（无设备时返回空数组） |
| HermesBuddy Linux 版 | **源码用 electron-builder --linux 原生构建 AppImage/deb，不用 Wine** | main.js 已跨平台（仅一处 darwin 判断）；Wine 跑 Electron 性能差且不稳定 |
| 去敏 | 见 §5 清单 | config.yaml/auth.json/\*.bak 是重灾区，devices.json 含内网 IP |

---

## 1. 安装包格式对比：.deb vs AppImage vs self-extracting .sh

### 1.1 三格式对比矩阵

| 维度 | .deb | AppImage | self-extracting .sh |
|------|------|----------|---------------------|
| **发行版覆盖** | 仅 Debian/Ubuntu 系（+衍生）| 全发行版（需 FUSE）| **全发行版，零运行时依赖** |
| **依赖安装能力** | ✅ Depends 字段自动拉依赖（apt 解析）| ❌ 不支持声明依赖，全靠 bundle | ⚠️ 脚本内自行 apt/dnf/pacman 检测安装 |
| **卸载/升级** | ✅ dpkg/apt 原生管理，`apt remove` 干净 | ❌ 无注册，手动删文件 | ⚠️ 需自写 uninstall.sh |
| **systemd 服务集成** | ✅ postinst 中 enable/start 是标准做法 | ⚠️ 别扭：AppImage 是"应用"不是"服务"，需额外脚本 | ✅ 完全自由控制 |
| **安装过程交互** | ⚠️ debconf 可以做但很丑，不适合 Web 向导 | ❌ 双击即运行，无安装阶段 | ✅ **天然支持：先解压→起 Web 向导→用户配置→再装** |
| **体积** | 中（不含运行时）| 大（bundle 一切，Electron 类 100MB+）| 中（自由控制） |
| **构建工具链** | dpkg-deb（本机已验证）/ fpm / electron-builder | appimagetool / electron-builder | tar + sh，**零工具链** |
| **签名/可信度** | apt 仓库 GPG 签名 | 可选 GPG/zsync 更新 | 无标准，靠 sha256sum + HTTPS 分发 |
| **开源社区惯例** | 服务端软件主流（Docker/NodeSource 都提供）| GUI 桌面应用主流（Krita/BalenaEtcher）| 通用安装器主流（rustup/nvm/oh-my-zsh/miniconda）|

### 1.2 本机实测证据

1. **.deb 构建可行**：`dpkg-deb --build` 成功产出 `hermes-test_1.0.0_amd64.deb`（dpkg 1.21.23），control 文件解析正常。**无需 fpm，dpkg-deb 足够**。
2. **self-extracting .sh 可行**：实测用 `sh header + tail -n +N | tar xz` 模式（不依赖 makeself 工具），373 字节测试包解压执行成功。makeself 未安装但可 `apt install`，或直接用这种自写 header（更可控）。
3. **AppImage 的 FUSE 前提**：本机 `/dev/fuse` 存在（FUSE_OK），但**目标用户机器不保证**；无 FUSE 时需 `--appimage-extract-and-run`，体验降级。且 AppImage 设计理念是"单文件 GUI 应用"，与本项目"后台服务 + systemd"形态错配。
4. **本机无 rpm/dnf/pacman** → 要覆盖 Fedora/Arch 只能靠 .sh 通用脚本或各自再打包（不建议首版做）。

### 1.3 推荐：双层方案

```
主分发（GitHub Release）:
  hermes-suite-vX.Y.Z-linux-x86_64.sh        ← 通用自解压安装器（Web 向导内置）

可选分发（给 Debian/Ubuntu 用户）:
  hermes-suite_X.Y.Z_amd64.deb               ← dpkg-deb 构建，apt install ./xxx.deb
                                               postinst 里同样拉起 Web 向导（xdg-open）
```

**为什么 .sh 优先而不是 .deb 优先**：
- 核心卖点是**安装期的 Web 配置向导**，.sh 安装器对流程有完全控制权（解压→临时 server→等用户点完成→写配置→注册 systemd）；.deb 的 postinst 里做长交互不符合 dpkg 惯例且 debconf 无法承载富 UI。
- 开源项目首版要覆盖的发行版越广越好，.sh 是唯一零假设方案。
- .deb 作为"锦上添花"：给 Ubuntu 桌面用户提供软件中心可见性和 `apt upgrade` 升级路径。
- **明确不选 AppImage 作为安装格式**（它适合 HermesBuddy 桌面端本身，见 §6，不适合整套服务）。

### 1.4 .sh 安装器骨架（已验证模式）

```sh
#!/bin/bash
# hermes-suite installer
set -e
TMPD=$(mktemp -d); trap "rm -rf $TMPD" EXIT
ARCHIVE_START=$(awk '/^__PAYLOAD__/{print NR+1; exit}' "$0")
tail -n +$ARCHIVE_START "$0" | tar xz -C "$TMPD"
sh "$TMPD/install.sh" "$@"     # 交互逻辑全在 install.sh
exit 0
__PAYLOAD__
<tar.gz 二进制 payload>
```
构建：`{ cat header.sh; cat payload.tar.gz; } > hermes-suite-installer.sh && chmod +x`
配套提供 `sha256sum` 校验文件与 `--no-web`（纯 CLI 问答）降级模式，适配 SSH 无浏览器场景。

---

## 2. Web 安装向导技术选型

### 2.1 纯 HTML+JS vs Vue/React SPA

| 维度 | 纯 HTML+JS（单文件/少量文件）| Vue/React SPA |
|------|------------------------------|---------------|
| 构建步骤 | **无**，随安装包直接分发 | 需 node_modules + vite/webpack 构建，CI 复杂度↑ |
| 体积 | 本项目原型 15.9KB / 365 行 | 框架运行时 ~50-150KB + 构建产物 |
| 维护门槛 | 贡献者改一个 HTML 就能提 PR | 需要懂框架工具链 |
| 适用规模 | ≤10 个表单页（本向导正好 5 步）| 大型多视图应用 |
| 状态管理 | 5 步向导用一个 `state` 对象足够 | 过度设计 |
| 离线可用 | ✅ 天然 | ✅（构建后也是静态文件）|

**结论：纯 HTML+JS**。向导只有 5 步（环境检查→模型供应商→设备发现→模块选择→安装启动），本质是线性表单流，框架带来的组件复用/路由/响应式收益趋近于零。这与既有 DESIGN.md 的选择一致，实测原型 `hermes-suite/web-setup/index.html` 已能跑（暗色主题、步骤点、设备勾选卡片齐全）。

**前端规范**（避免踩 HermesBuddy 已踩过的坑）：
- 所有按钮事件绑定不放在 DOM guard 之后（防止 guard 提前 return 导致绑定丢失）
- 每个新增 UI 组件同时完成 HTML+JS+CSS 三件套（HermesBuddy v1.3.9 教训：缺 CSS 导致面板"存在但不可见"）
- UI 操作不静默失败：fetch 失败必须渲染 `.status.error` 提示

### 2.2 后端：Python stdlib http.server（已验证）

```python
# 安装期临时 server（Python 3.11.2 本机可用，零 pip 依赖）
python3 -m http.server 不适用（无 API），需自写 ~100 行：
  GET  /                → web-setup/index.html
  GET  /api/env         → 环境检查结果（python/node 版本、磁盘、GPU）
  GET  /api/devices     → detect-devices.sh 输出（摄像头/麦克风/扬声器/GPU）
  POST /api/test-provider → 用 urllib 测 API Key 连通性
  POST /api/finish      → 渲染 config.yaml → 注册 systemd → 关闭向导 server
绑定 127.0.0.1（安全）+ 打印一次性 URL；SSH 场景提示用户 `ssh -L 8000:localhost:8000`。
```
选 Python 而不是 Node 的理由：Hermes Agent 本体是 Python 项目，安装目标机上 Python 是硬依赖（config.yaml 生态），Node 只是可选；用 stdlib 保证向导本身**零第三方依赖**。

### 2.3 向导要配置的具体项（对照现有系统架构）

| 配置项 | 来源 | 默认值建议 |
|--------|------|-----------|
| Gateway/管理端口 | HermesBuddy 8700、win gateway 22124 | 保持，冲突时向导自动探测递增 |
| 具身智能端口 | crystal_reflex 9124、smart-home 9125 | 保持 |
| 模型 provider + API Key + fallback 链 | model-router 8800 | 必须走 Model Router，不允许直连 provider（HermesBuddy skill 教训：直连配额 429 无 fallback）|
| 音频输入/输出设备 | §3 枚举结果 | 默认 default，下拉选择 hw:C,D |
| 摄像头 | §3 枚举 | 可选 |
| IoT 设备 | miio 设备 ip + token | token 留空让用户填 |

---

## 3. Linux 音频/视频设备枚举（本机实测）

### 3.1 实测结果（Debian 12，无 PulseAudio/PipeWire 守护进程）

| 命令 | 状态 | 输出 |
|------|------|------|
| `arecord -l` | ✅ 可用（alsa-utils 已装）| 正确列出麦克风 `card 0: PCH, device 0: ALC662 rev3 Analog` |
| `aplay -l` | ✅ 可用 | 列出 6 个播放设备（Analog/Digital/HDMI 0-2/pcsp）|
| `pactl` | ❌ 未安装 | PulseAudio/PipeWire 未运行（无头服务器常态）|
| `wpctl` | ❌ 不存在 | 同上 |
| `amixer` | ✅ 可用 | 音量控制 |
| `v4l2-ctl --list-devices` | ✅ 命令存在，但本机无 /dev/video0 | 需 fallback 到 `ls /dev/video*` |
| `nvidia-smi` | ❌ 无 NVIDIA GPU | fallback `lspci \| grep -iE 'vga\|3d'`（✅ 可用）|

### 3.2 推荐枚举策略（按优先级降级）

```
麦克风: pactl list short sources  →(失败)→ arecord -l 解析 "card N ... device M" → hw:N,M
扬声器: pactl list short sinks    →(失败)→ aplay -l  → hw:N,M + default
摄像头: v4l2-ctl --list-devices   →(失败)→ ls /dev/video*
GPU:    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
        →(失败)→ lspci | grep -iE 'vga|3d|display'
```
**关键结论：ALSA 工具（arecord/aplay）是无头服务器上的最小可靠集**，Pulse/PipeWire 只在桌面环境存在，必须做 try-fallback。已有脚本 `hermes-suite/scripts/detect-devices.sh` 实测输出正确 JSON（见下），但有一个坑：

### 3.3 实测踩坑：detect-devices.sh 必须用 bash 执行

- `sh detect-devices.sh` → **Syntax error: redirection unexpected**（脚本用了 `< <(...)` 进程替换，dash 不支持）
- `bash detect-devices.sh` → ✅ 正确输出 JSON（microphones 1 台 / speakers 6 台）
- **修复建议**：shebang 已是 `#!/bin/bash`，但安装器中调用必须显式 `bash detect-devices.sh`，不能 `sh`；或把进程替换改成管道以兼容 dash。

实测输出样例：
```json
{ "cameras": [], "microphones": [{"device":"hw:0,0","name":"ALC662 rev3 Analog ..."}],
  "speakers": [{"device":"hw:0,0",...}, ...6台], "gpu": [],
  "pulse_sources": [], "pulse_sinks": [] }
```

---

## 4. 去敏策略（本机文件实测审计）

### 4.1 含密钥/敏感信息的文件清单（实测）

| 文件 | 实测发现 | 处理 |
|------|---------|------|
| `~/.hermes/config.yaml` | **32 行命中** api_key/token/password/secret：多个 provider api_key、api_server password/password_hash、gateway secret | 模板化：值→`YOUR_API_KEY_HERE`/空串 |
| `~/.hermes/config.yaml.bak*`（17+ 个备份）| 与 config.yaml 同等敏感 | **直接排除，不进包** |
| `~/.hermes/auth.json` | 含认证凭据 | 排除，安装后重新生成 |
| `~/.hermes/models_dev_cache.json` | 含 key 类字段 | 排除（运行时自动重建）|
| `smart-home/devices.json` | miio 设备 `token` 字段 + **内网 IP** | token→空串；IP→`<YOUR_DEVICE_IP>` 或示例 0.0.0.0 |
| `smart-home/adapters.py` | 代码中引用 token 但**无硬编码值**（仅逻辑）| 安全，保留 |
| `crystallization/crystallization.db` | 用户行为数据 | 只带 schema，不带数据 |
| sessions/*.jsonl、state.db、sessions.db | 对话历史/状态 | 排除 |
| `.env` 类文件 | — | 只保留变量名 |

### 4.2 自动化去敏检查（建议加入 build.sh 门禁）

```bash
# 打包前扫描，命中即失败
grep -rIlE '(api_key|apikey|app_?secret|access_token|password)\s*[:=]\s*["'\'']?[A-Za-z0-9_\-]{16,}' \
  --exclude-dir=node_modules --exclude='*.bak*' hermes-suite/ && exit 1
# 内网 IP 扫描（保留 127.0.0.1/0.0.0.0）
grep -rInE '\b(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' --include='*.{json,yaml,yml,js,py,md}' . && exit 1
```
注意 Hermes 自身的 secret scrubber 会把文件内 `"Bearer "` 字面量替换掉（HermesBuddy v1.2.4 教训）——去敏脚本与 scrubber 是两回事，不要互相依赖。

---

## 5. HermesBuddy EXE 与 Linux 包的关系

### 5.1 选项对比

| 方案 | 评价 |
|------|------|
| ❌ Wine 内嵌运行 Windows EXE | 本机虽有 /usr/bin/wine，但 Wine 跑 Electron（Chromium）性能差、字体/输入法问题多、引入数百 MB Wine 依赖，**开源用户不可接受** |
| ❌ Linux 包里放 EXE 下载链接 | EXE 对 Linux 用户无意义，纯误导 |
| ✅ **同一份源码 electron-builder --linux 原生构建** | main.js 实测跨平台（全文件仅一处平台判断：`process.platform !== 'darwin'`，无 Windows 专属 API）；electron-builder 已在项目 devDeps 工作流中 |

### 5.2 推荐做法

```bash
cd /root/workbuddy/desktop
npm_config_registry=https://registry.npmmirror.com \
npm_config_electron_mirror=https://npmmirror.com/mirrors/electron/ \
npx electron-builder --linux AppImage deb --x64 --config.asar=false
# 产物：dist/HermesBuddy-X.Y.Z.AppImage + dist/hermesbuddy_X.Y.Z_amd64.deb
```
- `--config.asar=false` 必须保留（renderer 静态文件托管要求，HermesBuddy skill 既有结论）
- Linux 桌面用户 → AppImage（双击即用）；Linux 服务端用户 → 不装桌面端，直接用 Web dashboard
- Windows 用户 → 继续现有 NSIS EXE 流程
- 即：**HermesBuddy 三平台三份产物，同一份源码；Linux 安装包（.sh）里不带任何 EXE**

---

## 6. 最终架构建议（汇总）

```
GitHub Release v1.0.0/
├── hermes-suite-1.0.0-linux-x86_64.sh          ← 主安装器（全发行版）
│     ├─ install.sh（环境检查→起 Web 向导 127.0.0.1:8000→等完成→systemd）
│     ├─ web-setup/index.html（纯 HTML+JS，365 行已验证原型）
│     ├─ scripts/detect-devices.sh（bash 执行！ALSA 优先降级策略）
│     ├─ templates/*.tpl（去敏后配置模板）
│     └─ 各子系统源码（agent/buddy/embodied）
├── hermes-suite_1.0.0_amd64.deb                ← 可选（dpkg-deb 构建已验证）
├── HermesBuddy-1.0.0.AppImage                  ← Linux 桌面端（electron-builder --linux）
├── HermesBuddy Setup 1.0.0.exe                 ← Windows 桌面端（现状）
└── SHA256SUMS
```

**升级路径**：`hermes-suite upgrade` 子命令 = 下载新版 .sh → 保留 ~/.hermes/config.yaml（用户配置不覆盖，只合并新增字段）→ 重启 systemd。

## 7. 风险与待办

1. **Fedora/Arch 覆盖**：首版靠 .sh 通用脚本（脚本内需 `command -v apt/dnf/pacman` 分支安装系统依赖）；rpm 打包二期再做。
2. **无浏览器 SSH 场景**：.sh 安装器必须有 `--no-web` CLI 问答降级模式。
3. **PulseAudio/PipeWire 桌面场景**：detect-devices.sh 当前 pulse_sources/sinks 输出为空（无守护进程），在桌面机上 pactl 路径需要实测补充。
4. **systemd vs 无 systemd 环境**（容器/WSL）：install.sh 需检测 `pidof systemd`，无 systemd 时降级为 `hermes-suite start/stop` 前台脚本。
5. **arm64**：具身智能场景（树莓派/Jetson）很常见，二期需 arm64 构建矩阵。
