'use strict';

/**
 * 浮窗渲染脚本（仅 UI 接线，逻辑全在主进程）。
 * 通过 predictPanelApi（preload 暴露）接收步骤/建议、回传决策。文本一律 textContent，不拼 HTML。
 *
 * v4.10.40：以「聊天小框」形式实时展示预测流水线每一步。窗口常驻、可滚动、
 * 不自动消失；用户点 × 才关闭。
 */

(function () {
  const api = window.predictPanelApi;
  const $ = (id) => document.getElementById(id);

  const elSteps = $('steps');
  const elThinking = $('thinking');
  const elThinkingText = $('thinking-text');
  const elCard = $('card');
  const elSuggestion = $('suggestion');
  const elReason = $('reason');
  const elActions = $('actions');
  const btnGenerate = $('btn-generate');
  const btnLater = $('btn-later');
  const btnNever = $('btn-never');
  const btnClose = $('btn-close');
  // v4.10.27：主题输入（空白文档等没有正文素材的场景）
  const elTopicBox = $('topic-box');
  const elTopicHint = $('topic-hint');
  const elTopicInput = $('topic-input');

  // 不同意图给个轻量标签色，纯视觉
  const INTENT_LABEL = {
    word_writing: '写作',
    data_entry: '填表',
    collecting_material: '资料整理',
    api_lookup: '查接口',
    reading_or_thinking: '思考',
  };

  /** 步骤行按主进程下发的 id 去重更新；跨轮 id 不同 → 追加。 */
  const stepEls = new Map();
  const MAX_STEPS = 60;

  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function upsertStep(data) {
    const id = data && data.id;
    if (!id) return;
    let row = stepEls.get(id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'step';
      const ico = document.createElement('span');
      ico.className = 'step-ico';
      const body = document.createElement('div');
      body.className = 'step-body';
      const title = document.createElement('div');
      title.className = 'step-title';
      const detail = document.createElement('div');
      detail.className = 'step-detail';
      const time = document.createElement('div');
      time.className = 'step-time';
      body.appendChild(title);
      body.appendChild(detail);
      body.appendChild(time);
      row.appendChild(ico);
      row.appendChild(body);
      row._title = title;
      row._detail = detail;
      row._time = time;
      stepEls.set(id, row);
      elSteps.appendChild(row);
      // 超出上限裁剪最旧
      while (elSteps.childElementCount > MAX_STEPS) {
        const first = elSteps.firstElementChild;
        if (first) {
          elSteps.removeChild(first);
          // 同步清理 map（若最旧的正好是某个被引用的 id）
          for (const [k, v] of stepEls) { if (v === first) { stepEls.delete(k); break; } }
        } else break;
      }
    }
    const status = (data.status || 'pending');
    row.className = 'step status-' + status;
    row._title.textContent = data.title || '';
    row._detail.textContent = data.detail || '';
    row._time.textContent = fmtTime();
    // 始终滚到最新
    requestAnimationFrame(() => { try { elSteps.scrollTop = elSteps.scrollHeight; } catch (_) {} });
  }

  function clearSteps() {
    stepEls.clear();
    while (elSteps.firstChild) elSteps.removeChild(elSteps.firstChild);
  }

  function showThinking(on, text) {
    elThinking.hidden = !on;
    if (on && text) elThinkingText.textContent = text;
  }

  // v4.10.27：当前是否处于「需要用户给主题」的状态
  let needTopic = false;

  function showCard(data) {
    showThinking(false);
    const d = data || {};
    const label = INTENT_LABEL[d.intent] || '';
    elSuggestion.textContent = (label ? '【' + label + '】' : '') + (d.suggestion || '这里或许可以帮到你');
    elReason.textContent = d.reason || '';
    elReason.hidden = !d.reason;

    needTopic = Boolean(d.needTopic);
    elTopicBox.hidden = !needTopic;
    elTopicHint.classList.remove('warn');
    if (needTopic) {
      elTopicHint.textContent = d.topicHint || '没有识别到正文，输入你想写的主题';
      elTopicInput.value = '';
      setTimeout(() => { try { elTopicInput.focus(); } catch (_) {} }, 60);
    }
    elCard.hidden = false;
  }

  function hideCard() {
    elCard.hidden = true;
  }

  // ---- 渲染层监听主进程推送 ----
  if (api && api.onStep) api.onStep((data) => upsertStep(data));
  if (api && api.onClear) api.onClear(() => clearSteps());
  if (api && api.onThinking) api.onThinking((data) => showThinking(true, (data && data.text) || '思考中…'));
  if (api && api.onThinkingStop) api.onThinkingStop(() => showThinking(false));
  if (api && api.onSuggestion) api.onSuggestion((data) => showCard(data));
  if (api && api.onCardHide) api.onCardHide(() => hideCard());
  if (api && api.onClose) api.onClose(() => { try { window.close(); } catch (_) {} });

  function decide(choice, topic) {
    if (api && api.decide) api.decide(choice, topic || '');
  }

  function readTopic() {
    return elTopicBox.hidden ? '' : String(elTopicInput.value || '').trim();
  }

  btnGenerate.addEventListener('click', () => {
    if (needTopic && !readTopic()) {
      elTopicHint.textContent = '请先输入要写的主题（或点「稍后」跳过）';
      elTopicHint.classList.add('warn');
      try { elTopicInput.focus(); } catch (_) {}
      return;
    }
    decide('generate', readTopic());
  });
  btnLater.addEventListener('click', () => decide('later'));
  if (btnNever) btnNever.addEventListener('click', () => decide('never'));
  btnClose.addEventListener('click', () => { if (api && api.close) api.close(); });

  elTopicInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnGenerate.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      decide('later');
    }
  });

  // 首屏默认进入思考态：窗口刚 show 出来时先显示转圈，避免先闪出空建议 + 按钮
  showThinking(true, '思考中…');
})();
