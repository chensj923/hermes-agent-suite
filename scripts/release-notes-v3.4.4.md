# Hermes Buddy v3.4.4

## 修复
- **修复启动即崩溃**（主进程 JavaScript 错误）：v3.4.3 在 `src/main.js` 的 SSH 检查脚本中，bash 变量 `${CHANNEL_VER:-none}` 未在 JS 模板字符串中转义，导致安装版启动时直接报 `SyntaxError: Missing } in template expression`（main.js:591），客户端完全无法使用。现已正确转义为 `\${CHANNEL_VER:-none}`。

## 说明
- 本版本包含 v3.4.3 的全部功能（"已有 Hermes"路径检测到服务端通道版本过旧时自动升级部署），v3.4.3 因该崩溃 bug 未曾发布，直接由 v3.4.4 替代。
- 通道协议版本 1.1：支持模型列表透传（list_models）与会话级模型选择。
- 安装程序仅清理缓存（Chromium 缓存 / logs / server-deploy），保留连接配置与智能体配置。

## 升级提示
直接安装即可；若连接提示"服务端通道版本过旧"，客户端会自动对服务器重新部署通道（需 SSH 信息），或到服务器上重跑 deploy.sh。
