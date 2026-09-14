'use strict';

/**
 * Hermes 推理直通代理（Inference Pass-through Proxy）—— Python 源码模板。
 *
 * 为什么需要它（架构背景，2026-09-14 实测定论）：
 * - Buddy 的架构是「决策在远端、工具在本地执行」，要求端点具备一种语义：
 *   「收到 messages + tools，返回一个 tool_call，但**不执行**它」。
 * - Hermes Gateway（22122）的 /v1/chat/completions 是另一种语义：
 *   「收到 messages，在**服务端**跑完整 agent 循环（含工具），返回最终文本」。
 *   实测：请求里的 tools 被完全忽略、注入约 1.2 万 token 自有系统提示、
 *   在服务器本地真的执行 `ls /root`。
 * - 路由表实测：22122 上只有 /v1/models、/v1/chat/completions、/v1/responses、
 *   /health、/api/sessions 五个端点；/api/proxy、/api/passthrough、/api/inference、
 *   /api/models、/api/providers 全是 404，也没有 openapi.json。
 *   **即 Hermes 当前没有对外暴露任何「纯推理」能力。**
 * - hermes proxy 只转发 OAuth 供应商（nous/xai），不是本地模型代理，也用不上。
 *
 * 结论：在不动 Hermes 源码的前提下，正确做法是在 Hermes 主机上跑一个极薄的
 * 直通代理——它复用 Hermes 自己配好的上游（base_url / model / api_key），
 * 对外提供标准 OpenAI 兼容接口并**原样透传 tools**，用 Gateway 的 API Key 鉴权。
 * 这样：
 *   · Buddy 只填「Hermes 主机 + API Key」，不碰任何上游供应商配置；
 *   · 上游密钥永远不出服务器；
 *   · 换供应商只改 Hermes 配置，所有 Buddy 客户端自动跟随。
 *
 * 设计约束：
 * - 零第三方依赖（只許标准库），因为不能假设服务器装了什么；
 * - 不自己实现 YAML 全量解析：优先 pyyaml（Hermes 自己依赖它），失败降级到内置子集解析器；
 * - 上游路径自动探测（方舟有 /api/v3 与 /api/coding/v3 两种形态）；
 * - 支持 stream（SSE）透传，否则 Buddy 的流式输出会坏。
 *
 * 源码单一事实来源：packages/hermes-buddy-proxy/buddy-inference-proxy.py
 * （安装包用 src/buddy-inference-proxy.py；开发期回退到 packages 路径）。
 * 既供「生成服务端准备脚本」以 heredoc 内嵌，也供「服务端部署压缩包」直接携带真实文件。
 */

const fs = require('fs');
const path = require('path');

function pythonSource() {
  const candidates = [
    path.join(__dirname, 'buddy-inference-proxy.py'),
    path.resolve(__dirname, '..', '..', 'packages', 'hermes-buddy-proxy', 'buddy-inference-proxy.py'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { /* 下一个 */ }
  }
  throw new Error('找不到 buddy-inference-proxy.py（请确认已随安装包打包到 src/ 或 packages/）');
}

module.exports = { pythonSource };
