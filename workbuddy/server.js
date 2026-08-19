#!/usr/bin/env node
/**
 * WorkBuddy Server — Hermes Agent 桌面化前端的服务层
 * 职责:
 *   1. 静态托管前端 (public/)
 *   2. 代理 Hermes api_server (/hb-api/* → 127.0.0.1:22122)，服务端注入 Bearer key，浏览器不接触密钥
 *   3. SSE 透传 (chat/stream + runs/events)
 *   4. 专家(profile)管理: 直接读写 ~/.hermes/profiles/，配置即 Hermes 原生对象
 *   5. UI 访问令牌 (UI_TOKEN)，防止局域网任意设备裸访问
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Office 文件解析
let XLSX, mammoth;
try { XLSX = require('xlsx'); } catch (e) {}
try { mammoth = require('mammoth'); } catch (e) {}

const HERMES_HOME = process.env.HERMES_HOME || '/root/.hermes';
const PORT = parseInt(process.env.WORKBUDDY_PORT || '8700', 10);
const API_HOST = process.env.HERMES_API_HOST || '127.0.0.1';
const API_PORT = parseInt(process.env.HERMES_API_PORT || '22122', 10);

// ---------- 密钥加载 ----------
function loadEnvKey() {
  try {
    const lines = fs.readFileSync(path.join(HERMES_HOME, '.env'), 'utf8').split('\n');
    for (const line of lines) {
      if (line.startsWith('API_SERVER_KEY=')) return line.slice('API_SERVER_KEY='.length).trim();
    }
  } catch (e) { /* ignore */ }
  return '';
}
const HERMES_KEY = process.env.API_SERVER_KEY || loadEnvKey();

function loadUiToken() {
  const p = path.join(HERMES_HOME, '.workbuddy_ui_token');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
}
let UI_TOKEN = process.env.WORKBUDDY_UI_TOKEN || loadUiToken();

// ---------- 工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isSafeProfileName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(name) && !name.includes('..');
}

// ---------- Hermes API 代理 ----------
function proxyToHermes(req, res, targetPath) {
  const method = req.method;
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(method) || req.headers['content-length'];
  const headers = { 'Authorization': 'Bearer ' + HERMES_KEY };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers['content-length']) headers['Content-Length'] = req.headers['content-length'];
  if (!hasBody) headers['Content-Length'] = 0;

  const opts = { host: API_HOST, port: API_PORT, method, path: targetPath, headers };
  const upstream = http.request(opts, (up) => {
    const isSSE = (up.headers['content-type'] || '').includes('text/event-stream');
    const respHeaders = { 'Content-Type': up.headers['content-type'] || 'application/json' };
    if (isSSE) { respHeaders['Cache-Control'] = 'no-cache'; respHeaders['X-Accel-Buffering'] = 'no'; }
    res.writeHead(up.statusCode || 502, respHeaders);
    up.pipe(res);
    up.on('end', () => { upstreamDone = true; });
  });
  let upstreamDone = false;
  upstream.on('error', (e) => {
    if (!res.headersSent) sendJson(res, 502, { error: 'hermes api unreachable: ' + e.message });
    else res.end();
  });
  // 客户端中断时才销毁上游（不能监听 req.close——GET 请求体为空会立刻触发）
  res.on('close', () => { if (!upstreamDone) upstream.destroy(); });
  if (hasBody) req.pipe(upstream);
  else upstream.end();
}

// ---------- 专家 (profile) 管理 ----------
function profileDir(name) { return path.join(HERMES_HOME, 'profiles', name); }

function listProfiles() {
  const dir = path.join(HERMES_HOME, 'profiles');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const soul = path.join(dir, name, 'SOUL.md');
    const cfg = path.join(dir, name, 'config.yaml');
    const meta = { name, has_soul: fs.existsSync(soul), has_config: fs.existsSync(cfg), soul_preview: '', model: '' };
    if (meta.has_soul) {
      try { meta.soul_preview = fs.readFileSync(soul, 'utf8').slice(0, 300); } catch (err) {}
    }
    if (meta.has_config) {
      try {
        const txt = fs.readFileSync(cfg, 'utf8');
        const m = txt.match(/^\s*default:\s*(.+)$/m);
        if (m) meta.model = m[1].trim();
      } catch (err) {}
    }
    out.push(meta);
  }
  return out;
}

function getProfile(name) {
  if (!isSafeProfileName(name)) return null;
  const dir = profileDir(name);
  if (!fs.existsSync(dir)) return null;
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return null; } };
  return { name, soul: read('SOUL.md'), config: read('config.yaml') };
}

function createProfile(name, soul, model) {
  if (!isSafeProfileName(name)) return { error: 'invalid profile name (小写字母/数字/-/_)' };
  const dir = profileDir(name);
  if (fs.existsSync(dir)) return { error: 'profile 已存在' };
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOUL.md'), soul || `# ${name}\n\n你是一个专家助理。\n`);
  const cfg = model
    ? `model:\n  default: ${model}\n`
    : `# 继承全局默认模型\n`;
  fs.writeFileSync(path.join(dir, 'config.yaml'), cfg);
  return { ok: true, name };
}

function updateProfileSoul(name, soul) {
  if (!isSafeProfileName(name)) return { error: 'invalid profile name' };
  const dir = profileDir(name);
  if (!fs.existsSync(dir)) return { error: 'profile 不存在' };
  fs.writeFileSync(path.join(dir, 'SOUL.md'), soul);
  return { ok: true };
}

// ---------- 项目管理 ----------
const PROJECTS_FILE = path.join(__dirname, 'projects.json');

function loadProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch (e) { return []; }
}
function saveProjects(list) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2));
}

function isSafeAbsPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.includes('..') && p.length < 300;
}

function createProject(body) {
  const name = (body.name || '').trim();
  const projPath = (body.path || '').trim();
  if (!name || !isSafeProfileName(name.toLowerCase())) return { error: '项目名非法（字母/数字/-/_）' };
  if (!isSafeAbsPath(projPath)) return { error: '目录必须是绝对路径且不含 ..' };
  const projects = loadProjects();
  if (projects.some(p => p.name === name)) return { error: '项目已存在' };
  // 目录存在则直接写 AGENTS.md，不存在则创建
  try { fs.mkdirSync(projPath, { recursive: true }); } catch (e) { return { error: '无法创建目录: ' + e.message }; }
  const agentsMd = [
    `# ${name} — 项目上下文`,
    '',
    `> 此文件由 WorkBuddy 前端生成（${new Date().toISOString()}），Hermes 在此目录工作时自动读取。`,
    '',
    body.context || '（暂无项目说明）',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(projPath, 'AGENTS.md'), agentsMd);
  const entry = { id: 'proj_' + Date.now().toString(36), name, path: projPath, context: body.context || '', agents_md: true, created_at: Date.now() / 1000 };
  projects.push(entry);
  saveProjects(projects);
  return { ok: true, project: entry };
}

// ---------- 连接器管理 ----------
const CONNECTORS_FILE = path.join(__dirname, 'connectors.json');

function loadConnectorsFile() {
  try { return JSON.parse(fs.readFileSync(CONNECTORS_FILE, 'utf8')); } catch (e) { return []; }
}

function listConnectors() {
  // 合并：文件里的自定义连接器 + config.yaml 已注册的 mcp_servers
  const custom = loadConnectorsFile();
  const cfgPath = path.join(HERMES_HOME, 'config.yaml');
  const mcpNames = [];
  try {
    const txt = fs.readFileSync(cfgPath, 'utf8');
    const m = txt.match(/^mcp_servers:\n((?:[ \t]+.*\n?)+)/m);
    if (m) {
      for (const line of m[1].split('\n')) {
        const n = line.match(/^  ([a-z0-9_-]+):/i);
        if (n) mcpNames.push(n[1]);
      }
    }
  } catch (e) {}
  const fromCfg = mcpNames.filter(n => !custom.some(c => c.name === n))
    .map(n => ({ name: n, type: 'mcp', enabled: true, endpoint: '(config.yaml mcp_servers)', source: 'hermes' }));
  return [...custom, ...fromCfg];
}

function createConnector(body) {
  const name = (body.name || '').trim().toLowerCase();
  if (!isSafeProfileName(name)) return { error: '连接器名非法' };
  const endpoint = (body.endpoint || '').trim();
  if (!endpoint) return { error: '端点必填' };
  const list = loadConnectorsFile();
  if (list.some(c => c.name === name)) return { error: '连接器已存在' };
  const entry = { name, type: body.type || 'api', endpoint, enabled: true, created_at: Date.now() / 1000 };
  if (entry.type === 'mcp') {
    // MCP: command + args 拆分，写入 config.yaml 的 mcp_servers 段
    const parts = endpoint.split(/\s+/);
    const yamlBlock = [
      `  ${name}:`,
      `    command: ${parts[0]}`,
      `    args:`,
      ...parts.slice(1).map(a => `      - ${a}`),
      '',
    ].join('\n');
    try {
      const cfgPath = path.join(HERMES_HOME, 'config.yaml');
      let txt = fs.readFileSync(cfgPath, 'utf8');
      if (/^mcp_servers:/m.test(txt)) {
        txt = txt.replace(/^mcp_servers:\n/m, 'mcp_servers:\n' + yamlBlock);
      } else {
        txt += '\nmcp_servers:\n' + yamlBlock;
      }
      fs.writeFileSync(cfgPath, txt);
      entry.in_hermes_config = true;
      entry.note = '已写入 config.yaml，gateway 重启后 Hermes 原生加载';
    } catch (e) { return { error: '写入 config.yaml 失败: ' + e.message }; }
  }
  list.push(entry);
  fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(list, null, 2));
  return { ok: true, connector: entry };
}

// ---------- Session Log (JSONL) ----------
const SESSIONS_LOG_DIR = path.join(HERMES_HOME, 'sessions');
try { fs.mkdirSync(SESSIONS_LOG_DIR, { recursive: true }); } catch (e) {}

function appendSessionLog(sessionId, event) {
  if (!sessionId || typeof sessionId !== 'string') return;
  // 安全检查 session_id
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
  const file = path.join(SESSIONS_LOG_DIR, sessionId + '.jsonl');
  const line = JSON.stringify({ ts: Date.now() / 1000, ...event }) + '\n';
  try { fs.appendFileSync(file, line); } catch (e) {}
}

function readSessionLog(sessionId, limit = 200) {
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return [];
  const file = path.join(SESSIONS_LOG_DIR, sessionId + '.jsonl');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - limit);
    return lines.slice(start).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

function listSessionLogs() {
  try {
    const files = fs.readdirSync(SESSIONS_LOG_DIR).filter(f => f.endsWith('.jsonl'));
    return files.map(f => {
      const sessionId = f.replace('.jsonl', '');
      const stat = fs.statSync(path.join(SESSIONS_LOG_DIR, f));
      return { session_id: sessionId, size: stat.size, mtime: stat.mtime.toISOString() };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch (e) { return []; }
}

// ---------- 日志系统 ----------
const LOG_DIR = path.join(HERMES_HOME, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.WORKBUDDY_LOG_LEVEL || 'info'] ?? 1;
const LOG_FILE = path.join(LOG_DIR, 'workbuddy.log');
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB

function logMsg(level, msg, extra) {
  if ((LOG_LEVELS[level] ?? 1) < CURRENT_LOG_LEVEL) return;
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra || {}) }) + '\n';
  process.stdout.write(entry);
  try {
    // 简单轮转：超过 MAX_LOG_SIZE 就重命名
    try { if (fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch (e) {}
    fs.appendFileSync(LOG_FILE, entry);
  } catch (e) {}
}

function readLogs(limit = 200, level) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    let lines = text.trim().split('\n').filter(Boolean);
    if (level && LOG_LEVELS[level] !== undefined) {
      lines = lines.filter(l => { try { return LOG_LEVELS[JSON.parse(l).level] >= LOG_LEVELS[level]; } catch (e) { return false; } });
    }
    const start = Math.max(0, lines.length - limit);
    return lines.slice(start).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// ---------- 认证 ----------
function checkUiToken(req) {
  if (!UI_TOKEN) return true; // 未配置令牌则不拦截（本地信任）
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/ui/login') return true;
  const auth = req.headers['x-workbuddy-token'] || url.searchParams.get('token') || '';
  return auth === UI_TOKEN;
}

// ---------- 静态文件 ----------
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(__dirname, 'public', rel));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 权限拦截器 ----------
const WRITE_PATTERNS = [
  /\brm\b/, /\bdel\b/, /\brmdir\b/, /\bmove\b/, /\bcopy\b/, /\bxcopy\b/,
  /\becho\s*>/, /\bwrite_file\b/, /\bpatch\b/, /\bmkdir\b/, /\bmkfile\b/,
  /\bformat\b/, /\bdiskpart\b/, /\breg\s+delete\b/, /\breg\s+add\b/,
  /\bnet\s+share\b/, /\bschtasks\b.*\/create/i, /\bpowershell.*remove/i,
  /\bRemove-Item\b/, /\bSet-Content\b/, /\bNew-Item\b/, /\bOut-File\b/,
  />\s*\//, />>\s*\//, /\btee\b/, /\bsed\s+-i\b/, /\bawk.*>/,
];
const DELETE_PATTERNS = [
  /\brm\b/, /\bdel\b/, /\brmdir\b/, /\bRemove-Item\b/, /\brd\s+\/s\b/,
  /\bformat\b/, /\bdiskpart\b/,
];

function checkPermViolation(command, permLevel) {
  if (permLevel === 'full') return null;
  const cmd = command.toLowerCase();
  if (permLevel === 'read') {
    for (const p of WRITE_PATTERNS) {
      if (p.test(cmd)) return `只读模式禁止执行写操作: "${command}" 匹配规则 ${p}`;
    }
  } else if (permLevel === 'read-write') {
    for (const p of DELETE_PATTERNS) {
      if (p.test(cmd)) return `读写模式禁止删除操作: "${command}" 匹配规则 ${p}`;
    }
  }
  return null;
}

// 写入权限拦截规则文件供 terminal_tool.py 读取
const PERM_DENY_FILE = '/tmp/hermesbuddy_perm_deny';
function writePermDenyFile(permLevel) {
  try {
    if (permLevel === 'full') {
      // 完全访问：清空 deny 文件
      fs.writeFileSync(PERM_DENY_FILE, '# full access - no restrictions\n');
    } else if (permLevel === 'read') {
      // 只读：禁止所有写操作
      fs.writeFileSync(PERM_DENY_FILE, [
        '# HermesBuddy workspace permission: READ-ONLY',
        '\\brm\\b', '\\bdel\\b', '\\brmdir\\b', '\\bmove\\b', '\\bcopy\\b', '\\bxcopy\\b',
        '\\becho\\s*>', '\\bwrite_file\\b', '\\bpatch\\b', '\\bmkdir\\b',
        '\\bformat\\b', '\\bdiskpart\\b', '\\breg\\s+(delete|add)\\b',
        '\\bRemove-Item\\b', '\\bSet-Content\\b', '\\bNew-Item\\b', '\\bOut-File\\b',
        '>\\s*/', '>>\\s*/', '\\btee\\b', '\\bsed\\s+-i\\b',
      ].join('\n') + '\n');
    } else if (permLevel === 'read-write') {
      // 读写：禁止删除
      fs.writeFileSync(PERM_DENY_FILE, [
        '# HermesBuddy workspace permission: READ-WRITE (no delete)',
        '\\brm\\b', '\\bdel\\b', '\\brmdir\\b', '\\bRemove-Item\\b', '\\brd\\s+/s\\b',
        '\\bformat\\b', '\\bdiskpart\\b',
      ].join('\n') + '\n');
    }
  } catch (e) {
    logMsg('error', 'writePermDenyFile failed', { error: e.message });
  }
}

// ---------- 主路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // 登录
    if (p === '/api/ui/login') {
      const body = await readBody(req);
      let tok = '';
      try { tok = JSON.parse(body).token || ''; } catch (e) {}
      if (!UI_TOKEN || tok === UI_TOKEN) return sendJson(res, 200, { ok: true });
      return sendJson(res, 401, { error: '令牌错误' });
    }

    if (!checkUiToken(req)) return sendJson(res, 401, { error: 'unauthorized' });

    // Hermes 代理: /hb-api/<path...>
    if (p.startsWith('/hb-api/')) {
      const target = p.slice('/hb-api'.length) + url.search;
      // Session Log + 权限拦截: chat 请求
      if (req.method === 'POST' && target.includes('/chat')) {
        const sidMatch = target.match(/\/sessions\/([^/]+)\/chat/);
        const sid = sidMatch ? sidMatch[1] : null;
        if (sid) {
          // 读取 body 副本用于日志 + 权限提取
          const rawBody = await readBody(req);
          let userMsg = '';
          let model = '';
          let workdir = '';
          let permLevel = 'full'; // 默认不限制
          try {
            const j = JSON.parse(rawBody);
            userMsg = (j.message || '').slice(0, 500);
            model = j.model || '';
            workdir = j.workdir || '';
            // 从 system_message 提取权限级别
            const sm = j.system_message || '';
            if (sm.includes('只读模式')) permLevel = 'read';
            else if (sm.includes('读写模式')) permLevel = 'read-write';
            else if (sm.includes('完全访问')) permLevel = 'full';
          } catch (e) {}
          appendSessionLog(sid, { type: 'chat_request', user_message: userMsg, model, workdir, perm: permLevel });
          logMsg('info', 'chat_request', { session_id: sid, model, perm: permLevel });

          // 写入权限拦截规则文件（terminal_tool.py 执行前读取）
          writePermDenyFile(permLevel);

          // 用自定义代理方式发送
          const proxyOpts = { host: API_HOST, port: API_PORT, method: req.method, path: target,
            headers: { 'Authorization': 'Bea'+'rer ' + HERMES_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) } };
          const upstream = http.request(proxyOpts, (up) => {
            const isSSE = (up.headers['content-type'] || '').includes('text/event-stream');
            const respHeaders = { 'Content-Type': up.headers['content-type'] || 'application/json' };
            if (isSSE) { respHeaders['Cache-Control'] = 'no-cache'; respHeaders['X-Accel-Buffering'] = 'no'; }
            res.writeHead(up.statusCode || 502, respHeaders);
            let respChunks = '';
            let sseBuffer = '';
            up.on('data', (c) => {
              const chunk = c.toString();
              // SSE 权限拦截：实时检测 tool progress 事件
              if (isSSE && permLevel !== 'full') {
                sseBuffer += chunk;
                const lines = sseBuffer.split('\n');
                sseBuffer = lines.pop(); // 保留未完成的行
                for (const line of lines) {
                  if (!line.startsWith('data: ')) { res.write(line + '\n'); continue; }
                  const jsonStr = line.slice(6).trim();
                  if (!jsonStr || jsonStr === '[DONE]') { res.write(line + '\n'); continue; }
                  try {
                    const evt = JSON.parse(jsonStr);
                    // 检测 hermes.tool.progress 事件
                    if (evt.type === 'hermes.tool.progress' && evt.data?.tool === 'terminal' && evt.data?.status === 'running') {
                      const cmd = (evt.data.label || '').toLowerCase();
                      const violation = checkPermViolation(cmd, permLevel);
                      if (violation) {
                        // 注入拦截消息到 SSE 流
                        const interceptEvt = {
                          type: 'hermes.permission.intercept',
                          data: {
                            blocked_command: evt.data.label,
                            reason: violation,
                            perm_level: permLevel,
                            timestamp: Date.now(),
                          }
                        };
                        res.write(`data: ${JSON.stringify(interceptEvt)}\n\n`);
                        appendSessionLog(sid, { type: 'permission_intercept', command: evt.data.label, reason: violation, perm: permLevel });
                        logMsg('warn', 'permission_intercept', { session_id: sid, command: evt.data.label, reason: violation });
                      }
                    }
                  } catch (e) { /* not JSON, pass through */ }
                  res.write(line + '\n');
                }
              } else {
                res.write(c);
              }
              if (!isSSE && respChunks.length < 5000) respChunks += chunk;
            });
            up.on('end', () => {
              // flush remaining buffer
              if (sseBuffer) res.write(sseBuffer);
              res.end();
              appendSessionLog(sid, { type: 'chat_response', status: up.statusCode, preview: respChunks.slice(0, 500) });
              logMsg('info', 'chat_response', { session_id: sid, status: up.statusCode });
            });
          });
          upstream.on('error', (e) => {
            logMsg('error', 'proxy_error', { session_id: sid, error: e.message });
            if (!res.headersSent) sendJson(res, 502, { error: 'hermes api unreachable: ' + e.message });
            else res.end();
          });
          upstream.write(rawBody);
          upstream.end();
          return;
        }
      }
      return proxyToHermes(req, res, target);
    }

    // Session Log API
    if (p === '/api/session-logs' && req.method === 'GET') {
      return sendJson(res, 200, { logs: listSessionLogs() });
    }
    if (p.startsWith('/api/session-logs/') && req.method === 'GET') {
      const sid = decodeURIComponent(p.split('/')[3] || '');
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      return sendJson(res, 200, { events: readSessionLog(sid, limit) });
    }

    // Session Log 写入 API（前端主动记录）
    if (p === '/api/session-logs' && req.method === 'POST') {
      const rawBody = await readBody(req);
      try {
        const { session_id, event } = JSON.parse(rawBody);
        if (!session_id || !event) return sendJson(res, 400, { error: 'missing session_id or event' });
        appendSessionLog(session_id, event);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // 日志 API
    if (p === '/api/logs' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      const level = url.searchParams.get('level') || undefined;
      return sendJson(res, 200, { logs: readLogs(limit, level) });
    }

    // Office 文件读取 API
    if (p === '/api/read-file' && req.method === 'POST') {
      const rawBody = await readBody(req);
      try {
        const { file_path } = JSON.parse(rawBody);
        if (!file_path) return sendJson(res, 400, { error: 'missing file_path' });
        const ext = path.extname(file_path).toLowerCase();
        let content = '';
        let type = 'text';

        if ((ext === '.xlsx' || ext === '.xls') && XLSX) {
          const wb = XLSX.readFile(file_path);
          const sheets = wb.SheetNames.map(name => {
            const ws = wb.Sheets[name];
            return `=== Sheet: ${name} ===\n${XLSX.utils.sheet_to_csv(ws)}`;
          });
          content = sheets.join('\n\n');
          type = 'xlsx';
        } else if (ext === '.docx' && mammoth) {
          const result = await mammoth.extractRawText({ path: file_path });
          content = result.value;
          type = 'docx';
        } else if (ext === '.csv' || ext === '.txt' || ext === '.json' || ext === '.md' || ext === '.log') {
          content = fs.readFileSync(file_path, 'utf-8');
          type = ext.slice(1);
        } else {
          return sendJson(res, 400, { error: `Unsupported file type: ${ext}. Supported: xlsx, xls, docx, csv, txt, json, md, log` });
        }
        return sendJson(res, 200, { content, type, file_path, size: fs.statSync(file_path).size });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // 模型列表 API (从 model-router 获取)
    if (p === '/api/models' && req.method === 'GET') {
      const modelRouterUrl = 'http://localhost:8800/v1/models';
      const httpReq = http.request(modelRouterUrl, (mr) => {
        let body = '';
        mr.on('data', c => body += c);
        mr.on('end', () => {
          try { return sendJson(res, 200, JSON.parse(body)); }
          catch (e) { return sendJson(res, 200, { data: [{ id: 'hermes-agent' }] }); }
        });
      });
      httpReq.on('error', () => sendJson(res, 200, { data: [{ id: 'hermes-agent' }] }));
      httpReq.end();
      return;
    }

    // 专家管理
    if (p === '/api/experts' && req.method === 'GET') return sendJson(res, 200, { experts: listProfiles() });
    if (p === '/api/experts' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return sendJson(res, 200, createProfile(body.name, body.soul, body.model));
    }
    if (p.startsWith('/api/experts/')) {
      const name = decodeURIComponent(p.split('/')[3] || '');
      if (req.method === 'GET') {
        const prof = getProfile(name);
        return prof ? sendJson(res, 200, prof) : sendJson(res, 404, { error: 'not found' });
      }
      if (req.method === 'PATCH') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (typeof body.soul !== 'string') return sendJson(res, 400, { error: 'soul required' });
        return sendJson(res, 200, updateProfileSoul(name, body.soul));
      }
    }

    // 项目管理
    if (p === '/api/projects' && req.method === 'GET') return sendJson(res, 200, { projects: loadProjects() });
    if (p === '/api/projects' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return sendJson(res, 200, createProject(body));
    }

    // 连接器管理
    if (p === '/api/connectors' && req.method === 'GET') return sendJson(res, 200, { connectors: listConnectors() });
    if (p === '/api/connectors' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return sendJson(res, 200, createConnector(body));
    }

    // 健康检查
    if (p === '/api/ui/health') {
      const ok = !!HERMES_KEY;
      return sendJson(res, 200, { ok, hermes_api: `${API_HOST}:${API_PORT}`, has_key: ok, ui_auth: !!UI_TOKEN });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[workbuddy] serving on http://0.0.0.0:${PORT} | hermes api -> ${API_HOST}:${API_PORT} | key=${HERMES_KEY ? 'loaded' : 'MISSING'} | ui_auth=${UI_TOKEN ? 'on' : 'off'}`);
});
