'use strict';

/**
 * 建议动作执行器（Electron 主进程专用）。
 *
 * 预测浮窗里的「生成/插入」落到这里执行。所有动作都在主进程发生，
 * 绝不下发到渲染进程（API Key / 远端调用同样只在主进程），满足 v4.0 安全约束。
 *
 * 当前支持的动作：
 *   - clipboard: 把建议文本写入剪贴板，并先把旧值存起来，延迟一段时间再恢复，
 *     避免「建议一插就把用户正在用的内容冲掉」的竞态；恢复失败也无妨（旧值已尽力保留）。
 *   - 其余动作类型（SendInput 直接键入、打开链接等）在本版留作扩展点。
 */

const DEFAULT_RESTORE_MS = 8000;

class ActionExecutor {
  /**
   * @param {object} opts
   * @param {object} opts.clipboard  Electron clipboard 实例（注入便于测试）
   * @param {object} opts.logger
   * @param {number} [opts.restoreMs=8000]
   */
  constructor({ clipboard, logger, restoreMs = DEFAULT_RESTORE_MS } = {}) {
    if (!clipboard) throw new Error('ActionExecutor 需要 clipboard');
    this.clipboard = clipboard;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.restoreMs = restoreMs;
    this._restoreTimer = null;
  }

  /**
   * 执行一个建议动作。
   * @param {object} action { type:'clipboard', text }              写入并在 restoreMs 后恢复旧值
   *                          { type:'clipboard-keep', text }      写入且不恢复（v4.10.2，生成内容用）
   *                          { type:'noop' }
   * @returns {Promise<{ok:boolean, type:string, message:string}>}
   */
  async execute(action) {
    const type = (action && action.type) || 'noop';
    if (type === 'clipboard') {
      return this._fillClipboard(String(action.text || ''), false);
    }
    if (type === 'clipboard-keep') {
      return this._fillClipboard(String(action.text || ''), true);
    }
    if (type === 'noop' || !action) {
      return { ok: true, type: 'noop', message: '无需执行' };
    }
    // 未知动作：安全拒绝，避免静默做不该做的事
    this.logger.warn('action-unknown', { type });
    return { ok: false, type, message: '不支持的动作类型：' + type };
  }

  async _fillClipboard(text, keep) {
    if (!text) return { ok: true, type: 'clipboard', message: '内容为空，跳过' };
    // 先保存旧值（含富文本/文件等类型，一律转字符串尽力保存）
    let previous = '';
    try { previous = this.clipboard.readText() || ''; } catch (_) { previous = ''; }

    try {
      this.clipboard.writeText(text);
    } catch (e) {
      return { ok: false, type: 'clipboard', message: '写入剪贴板失败：' + e.message };
    }

    // keep=true（v4.10.2 生成内容）：不启动恢复定时器——用户点「生成并插入」
    // 拿到的是真生成的内容，8 秒后被旧值冲掉等于功能白做。
    if (keep) {
      this.logger.info('clipboard-filled-keep', { len: text.length });
      return { ok: true, type: 'clipboard-keep', message: '已将生成内容写入剪贴板（' + text.length + ' 字，不会自动恢复）' };
    }

    // 延迟恢复旧值，避免冲掉用户当前内容。恢复失败仅记录，不影响本次插入。
    if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
    this._restoreTimer = setTimeout(() => {
      try { if (previous) this.clipboard.writeText(previous); }
      catch (e) { this.logger.warn('clipboard-restore-failed', { error: e.message }); }
      finally { this._restoreTimer = null; }
    }, this.restoreMs);

    this.logger.info('clipboard-filled', { len: text.length });
    return { ok: true, type: 'clipboard', message: '已将建议写入剪贴板（' + text.length + ' 字）' };
  }

  /** 立即取消待恢复的旧值（用户主动操作后调用，避免误恢复）。 */
  cancelRestore() {
    if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
  }
}

module.exports = { ActionExecutor, DEFAULT_RESTORE_MS };
