'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_SIZE = 1024 * 1024; // 1MB，超过就滚一次，桌面端不需要更复杂的策略
// 日志会被用户贴到 issue 里，凡是像密钥的字段一律打掉。
const REDACT_KEYS = /^(apikey|api_key|key|token|password|secret|authorization)$/i;
const REDACT_VALUE = /\b(gh[pous]_[A-Za-z0-9]{6,}|sk-[A-Za-z0-9]{6,})\b/g;

function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') return value.replace(REDACT_VALUE, '[redacted]');
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = REDACT_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

function createLogger({ dir, level = 'info', console: consoleImpl = console } = {}) {
  const threshold = LEVELS[level] || LEVELS.info;
  const file = dir ? path.join(dir, 'buddy.log') : null;
  if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }

  const write = (levelName, message, extra) => {
    if ((LEVELS[levelName] || 0) < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: levelName, msg: message, ...(extra ? redact(extra) : {}) });
    if (levelName === 'error') consoleImpl.error(line); else consoleImpl.log(line);
    if (!file) return;
    try {
      try { if (fs.statSync(file).size > MAX_SIZE) fs.renameSync(file, `${file}.old`); } catch (_) {}
      fs.appendFileSync(file, `${line}\n`);
    } catch (_) { /* 日志失败不影响主流程 */ }
  };

  return {
    file,
    debug: (message, extra) => write('debug', message, extra),
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra)
  };
}

module.exports = { createLogger, redact, LEVELS };
