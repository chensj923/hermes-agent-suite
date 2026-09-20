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

  function setThinking(on, text) {
    elThinking.hidden = !on;
    elSuggestion.hidden = Boolean(on);
    elReason.hidden = Boolean(on) || !elReason.textContent;
    elActions.hidden = Boolean(on);
    if (on) elTopicBox.hidden = true;
    if (on && text) elThinkingText.textContent = text;
  }

  // v4.10.27：当前是否处于「需要用户给主题」的状态
  let needTopic = false;

  function show(data) {
    setThinking(false);
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
      // 窗口刚 show/focus，稍等一拍再聚焦输入框，否则焦点会被窗口抢回去
      setTimeout(() => { try { elTopicInput.focus(); } catch (_) {} }, 60);
    }
  }

  if (api && api.onSuggestion) {
    api.onSuggestion(show);
  }
  if (api && api.onThinking) {
    api.onThinking((data) => setThinking(true, (data && data.text) || '思考中…'));
  }

  function decide(choice, topic) {
    if (api && api.decide) api.decide(choice, topic || '');
  }

  function readTopic() {
    return elTopicBox.hidden ? '' : String(elTopicInput.value || '').trim();
  }

  btnGenerate.addEventListener('click', () => {
    if (needTopic && !readTopic()) {
      // 没有正文素材又不给主题 → 别浪费一次远端生成，直接提示
      elTopicHint.textContent = '请先输入要写的主题（或点「稍后」跳过）';
      elTopicHint.classList.add('warn');
      try { elTopicInput.focus(); } catch (_) {}
      return;
    }
    decide('generate', readTopic());
  });
  btnLater.addEventListener('click', () => decide('later'));
  btnNever.addEventListener('click', () => decide('never'));

  // 输入框里回车 = 生成并插入；Esc = 稍后
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
  setThinking(true, '思考中…');
})();
