# Hermes Buddy v3.4.7 发布说明

## 修复：完整部署安装 Hermes 本体必须显式报错

之前「完整部署」在 223 上出现过**装失败却报成功**的情况：deploy.sh 创建了空 venv 目录，
但 `uv pip install hermes-agent` 失败后只是 WARN + `return 0` 被静默吞掉，客户端误以为 Hermes 已装好。

- `install_hermes()` 所有失败分支改为 `return 1` 并打印 `[deploy][FAIL] ...`。
- 安装后**真正校验**：`hermes` 命令或 `hermes_agent` 模块不存在即判失败（空 venv 不再误判成功）。
- 外层记录 `HERMES_INSTALL_FAILED` 并提示「请排查后重新执行完整部署」，客户端可据此报错，
  而不是让一次不完整的部署看起来完成。

## 修复：内部 / 私有 PyPI 镜像自动信任

内部镜像常为 HTTP 或自签证书，uv/pip 默认会拒绝。现在根据 `HERMES_INDEX_URL` /
`HERMES_EXTRA_INDEX_URL` 的 host 自动加 `--trusted-host`（pip）/ `--allow-insecure`（uv），
在向导「Hermes 安装源」填内部源即可直接装，无需手工加参数。

## 工程

- 新增 `.gitattributes`：强制 `*.sh` / `*.py` 用 LF，防止 Windows `core.autocrlf` 把脚本转 CRLF、
  重建部署包后 Linux 端 `#!/bin/bash^M` shebang 失效。
- `deploy/deploy.sh` 纳入 git 版本库（`.gitignore` 加例外，与 `build-installer.sh` 并列）。

## 完整部署成功的判断依据（三条必须全过）

1. `/root/.hermes/venv/bin/hermes --version` 退出 0（hermes 命令可用）
2. `test -f /root/.hermes/config.yaml`（配置存在）
3. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:22122/health` == 200（Gateway 在监听）

任一条不满足即「安装未完成」，客户端应返回错误并提示重新执行完整部署。
