# v3.3.3

## 修复

### WS 通道握手 401（v3.3.1 修复）
- **deploy.sh 步骤重排**：API_SERVER_KEY 写入 .env 和 .api_server_key 移到通道启动之前，通道启动时即可读到正确密钥
- **deploy.sh 第 4 步**：改为重启 Gateway + 重启通道服务，确保通道读到最新密钥
- **systemd service**：移除硬编码 `Environment=API_SERVER_KEY=...`（该值在 key 变化后不更新，是 401 的源头）
- **expected_token() 增强**（4 个 Python 文件同步）：新增 .api_server_key 文件读取作为 fallback

### sudo 丢失上游环境变量（v3.3.2 修复）
- **deploy.sh**：`exec sudo "$0" "$@"` 改为 `exec sudo -E env BUDDY_UPSTREAM_BASE="$BUDDY_UPSTREAM_BASE" ...`，sudo 不再丢失环境变量
- **main.js**：环境变量传递从 `VAR='value'` 前缀改为 `env VAR="value"` + `sudo -E env` 语法

### buddy-proxy.env 不写入（v3.3.3 修复）
- **deploy.sh**：FORCE_WRITE 检查从 sys.exit(0) 之后移到之前，全新部署时 config.yaml 不存在不再导致脚本提前退出
- **deploy.sh**：FORCE_WRITE 块使用环境变量值（用户在 UI 填的）而非 config.yaml 发现的空值

## 升级说明
安装 v3.3.3 后，在目标服务器重新执行全新部署即可。
