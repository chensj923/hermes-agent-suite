'use strict';

/**
 * 浮窗渲染脚本（仅 UI 接线，逻辑全在主进程）。
 * 通过 predictPanelApi（preload 暴露）接收建议、回传决策。文本一律 textContent，不拼 HTML。
 */

(function () {
  const api = window.predictPanelApi;
  const $ = (id) => document.getElementById(id);

  const elSuggestion = $('suggestion');
  const elReason = $('reason');
  const elThinking = $('thinking');
  const elThinkingText = $('thinking-text');
  const elActions = $('actions');
  const btnGenerate = $('btn-generate');
  const btnLater = $('btn-later');
  const btnNever = $('btn-never');

  // 不同意图给个轻量标签色，纯视觉
  const INTENT_LABEL = {
    word_writing: '写作',
    data_entry: '填表',
    collecting_material: '资料整理',
    api_lookup: '查接口',
    reading_or_thinking: '思考',
  };

  function setThinking(on, text) {
    elThinking.hidden = !on;
    elSuggestion.hidden = Boolean(on);
    elReason.hidden = Boolean(on) || !elReason.textContent;
    elActions.hidden = Boolean(on);
    if (on && text) elThinkingText.textContent = text;
  }

  function show(data) {
    setThinking(false);
    const d = data || {};
    const label = INTENT_LABEL[d.intent] || '';
    elSuggestion.textContent = (label ? '【' + label + '】' : '') + (d.suggestion || '这里或许可以帮到你');
    elReason.textContent = d.reason || '';
    elReason.hidden = !d.reason;
  }

  if (api && api.onSuggestion) {
    api.onSuggestion(show);
  }
  if (api && api.onThinking) {
    api.onThinking((data) => setThinking(true, (data && data.text) || '思考中…'));
  }

  function decide(choice) {
    if (api && api.decide) api.decide(choice);
  }

  btnGenerate.addEventListener('click', () => decide('generate'));
  btnLater.addEventListener('click', () => decide('later'));
  btnNever.addEventListener('click', () => decide('never'));

  // 首屏占位
  show({});
})();
