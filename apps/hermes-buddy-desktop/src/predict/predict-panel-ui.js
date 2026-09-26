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
  // v4.11.0：应用标签 + 这个应用最常用的 3 个行为
  const elAppTag = $('app-tag');
  const elBehaviors = $('behaviors');

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
    // v4.12.6：新一轮标题（__flow__）插入前先清空上一轮所有步骤，
    // 否则跨轮步骤无限堆积（面板越拉越长、旧轮残留 = "框体错位/堆叠"）。
    if (id === '__flow__') clearSteps();
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

  /**
   * v4.11.0：渲染「这个应用最常用的 3 个行为」。
   * 用户点哪个就按哪个直接做，不必再让模型猜现在在干嘛。
   */
  // v4.11.0：首选行为 id——主按钮「按「X」生成」回传它，保证与点该行为等价
  let firstBehaviorId = '';
  function renderBehaviors(d) {
    firstBehaviorId = '';
    while (elBehaviors.firstChild) elBehaviors.removeChild(elBehaviors.firstChild);
    const list = Array.isArray(d && d.behaviors) ? d.behaviors : [];
    if (!list.length) {
      elBehaviors.hidden = true;
      btnGenerate.textContent = '生成并插入';
      return;
    }
    for (const b of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'behavior';
      const name = document.createElement('span');
      name.className = 'b-name';
      name.textContent = b.name || '';
      const hint = document.createElement('span');
      hint.className = 'b-hint';
      hint.textContent = b.hint || '';
      btn.appendChild(name);
      btn.appendChild(hint);
      if (b.auto) {
        const flag = document.createElement('span');
        flag.className = 'b-flag';
        flag.textContent = '常用';
        btn.appendChild(flag);
      }
      btn.addEventListener('click', () => {
        if (needTopic && !readTopic()) {
          elTopicHint.textContent = '请先输入要写的主题（或点「稍后」跳过）';
          elTopicHint.classList.add('warn');
          try { elTopicInput.focus(); } catch (_) {}
          return;
        }
        decide('behavior', readTopic(), b.id);
      });
      elBehaviors.appendChild(btn);
    }
    elBehaviors.hidden = false;
    firstBehaviorId = String(list[0].id || '');
    // 主按钮跟着首选行为走，避免「直接生成」和「点行为」两条路径给出不同结果
    btnGenerate.textContent = '按「' + (list[0].name || '首选') + '」生成';
  }

  /** v4.11.0：渲染应用标签（识别到哪个应用 / 哪一类 / 是否游戏）。 */
  function renderAppTag(d) {
    while (elAppTag.firstChild) elAppTag.removeChild(elAppTag.firstChild);
    const p = d && d.appProfile;
    if (!p) { elAppTag.hidden = true; return; }
    const name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = p.name || '';
    elAppTag.appendChild(name);
    if (p.isGame) {
      const g = document.createElement('span');
      g.className = 'app-game';
      g.textContent = '游戏';
      elAppTag.appendChild(g);
    } else if (p.categoryLabel) {
      const c = document.createElement('span');
      c.className = 'app-cat';
      c.textContent = p.categoryLabel;
      elAppTag.appendChild(c);
    }
    elAppTag.hidden = false;
  }

  function showCard(data) {
    showThinking(false);
    const d = data || {};
    const label = INTENT_LABEL[d.intent] || '';
    elSuggestion.textContent = (label ? '【' + label + '】' : '') + (d.suggestion || '这里或许可以帮到你');
    elReason.textContent = d.reason || '';
    elReason.hidden = !d.reason;
    renderAppTag(d);
    renderBehaviors(d);

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

  function decide(choice, topic, behaviorId) {
    if (api && api.decide) api.decide(choice, topic || '', behaviorId || '');
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
    decide('generate', readTopic(), firstBehaviorId);
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
