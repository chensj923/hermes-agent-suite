# 微信推广草稿 · Hermes 路线图 5.0 → 10.0

创建：2026-09-19。正文文件：`hermes-roadmap-5-10.html`（纯片段，无 html/head/body，符合微信安全样式子集，自检通过：无 flex/gradient/class/id/comment，1 个 table 布局）。

## 草稿元信息（draft/add 用）

| 字段 | 值 |
|---|---|
| title | Hermes 5.0 → 10.0：让 AI 记住你、跟着你、替你动手 |
| author | 陈嗣俊 |
| digest | 在电脑上聊一半，手机上就失忆？Hermes Agent Suite 公开未来六个大版本路线图：全平台、跨端记忆、全端同步、推理平台、具身智能管家。 |
| content | `hermes-roadmap-5-10.html` 全文 |
| content_source_url | （可选）仓库页或博客链接 |
| thumb_media_id | 上传 `cover-roadmap-900x500.png`（add_material type=image）后取得 |
| need_open_comment | 1 |
| only_fans_can_comment | 0 |

## 备选标题

1. Hermes 5.0 → 10.0：让 AI 记住你、跟着你、替你动手（主推）
2. 你的 AI 助手，为什么换个设备就失忆了？
3. 从桌面宠儿到智能管家：Hermes 的下一个五年

## 发布步骤（凭据走环境变量，勿入库）

```bash
export WX_APPID=xxx WX_APPSECRET=xxx
# 1) 取 access_token（40164 = 去 IP 白名单加本机公网 IP）
# 2) 上传封面 cover-roadmap-900x500.png → thumb_media_id
# 3) draft/add，content = hermes-roadmap-5-10.html 原文
# 4) draft/get 校验 content 长度与关键样式
```

## 内容红线自检（已过）

- 无内网 IP / 端口 / 路径 / 凭据
- 所有「规划中」功能均带徽章标注，文末有免责说明
- 开源协议 MIT 与仓库地址已注明
