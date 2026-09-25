'use strict';

/**
 * v4.11.0：应用画像库（本地规则的"大脑"）。
 *
 * 背景：旧版只有 3 条手写场景规则（WPS 写作 / 润色 / 微信回复），
 * 覆盖不到的应用一律走「截图 → 本机 3B VL → 远端盲猜」，实测触发率和准确度都很差。
 *
 * 本模块把"规则"变成一张可枚举的表：收录网络常见软件约 100 种，按类别分组，
 * 每种给出 3 个最常用的行为（behavior）。命中应用后直接把它最常用的 3 件事
 * 摆在用户面前（而不是让模型瞎猜现在在干嘛），用户点哪个就按哪个走。
 *
 * 游戏单独建库：游戏里不能"代写"，但可以干三件有价值的事——
 *   1) 攻略推荐（这关怎么过 / 这个 boss 怎么打 / 养成路线）
 *   2) 过程推荐（看着当前画面给即时建议：打法、路线、资源分配）
 *   3) 任务建议（今天优先做哪些日常 / 周常 / 活动）
 *
 * 纯 JS、零 Electron 依赖，node --test 可直接加载。
 */

/** 意图元数据：标签 + 默认是否可把生成结果插进文档 + 兜底话术。 */
const INTENT_META = {
  word_writing: { label: '写作', canInsert: true, fallback: '要不要我帮你起草或续写这段内容？' },
  doc_polish: { label: '润色', canInsert: true, fallback: '需要我帮你润色或改写这段文字吗？' },
  doc_summary: { label: '总结', canInsert: true, fallback: '需要我把这份内容总结成要点吗？' },
  doc_outline: { label: '列大纲', canInsert: true, fallback: '需要我先给你列一份写作大纲吗？' },
  doc_translate: { label: '翻译', canInsert: true, fallback: '需要我把这段内容翻译一下吗？' },
  doc_review: { label: '校对', canInsert: false, fallback: '需要我帮你检查错别字和表述吗？' },
  data_entry: { label: '填表', canInsert: true, fallback: '这个字段需要我帮忙填吗？' },
  data_formula: { label: '写公式', canInsert: false, fallback: '需要我帮你写这个公式吗？' },
  data_chart: { label: '做图表', canInsert: false, fallback: '需要我告诉你这组数据该用什么图表吗？' },
  data_analysis: { label: '数据分析', canInsert: true, fallback: '需要我帮你分析这份数据并给出结论吗？' },
  code_write: { label: '写代码', canInsert: true, fallback: '需要我帮你写这段代码吗？' },
  code_debug: { label: '排错', canInsert: false, fallback: '卡在报错上了？把报错贴给我，我帮你查。' },
  code_review: { label: '代码审查', canInsert: false, fallback: '需要我 review 一下这段代码吗？' },
  code_explain: { label: '解释代码', canInsert: false, fallback: '这段代码看不懂？我给你讲一遍。' },
  api_lookup: { label: '查文档', canInsert: false, fallback: '需要我帮你查这个接口/API 的用法吗？' },
  search_summary: { label: '检索总结', canInsert: true, fallback: '需要我把这个页面/搜索结果总结成要点吗？' },
  translate: { label: '翻译', canInsert: true, fallback: '需要我翻译屏幕上这段外文吗？' },
  collecting_material: { label: '整理资料', canInsert: true, fallback: '复制的资料要我帮你整理成笔记吗？' },
  reading_or_thinking: { label: '阅读思考', canInsert: false, fallback: '需要我帮你梳理思路或找资料吗？' },
  message_reply: { label: '回复', canInsert: true, fallback: '需要我帮你起草一条回复吗？' },
  message_summary: { label: '聊天摘要', canInsert: false, fallback: '需要我把这段聊天总结成要点吗？' },
  media_edit: { label: '剪辑处理', canInsert: false, fallback: '需要我给你一套剪辑/处理思路吗？' },
  media_script: { label: '脚本字幕', canInsert: true, fallback: '需要我帮你写脚本或字幕文案吗？' },
  design_idea: { label: '创意', canInsert: false, fallback: '需要我给你几个设计方向吗？' },
  design_caption: { label: '文案', canInsert: true, fallback: '需要我帮你写配图文案吗？' },
  file_organize: { label: '文件整理', canInsert: false, fallback: '需要我给你一套归档整理方案吗？' },
  learning_note: { label: '学习笔记', canInsert: true, fallback: '需要我把这个知识点整理成笔记吗？' },
  dict_lookup: { label: '查词', canInsert: false, fallback: '需要我解释这个词吗？' },
  game_guide: { label: '攻略推荐', canInsert: false, fallback: '需要我给你这份游戏的过关/养成攻略吗？' },
  game_live: { label: '过程推荐', canInsert: false, fallback: '需要我看着当前画面给即时建议吗？' },
  game_quest: { label: '任务建议', canInsert: false, fallback: '需要我告诉你现在优先做哪些任务吗？' },
  context_switch: { label: '切换', canInsert: false, fallback: '进入新窗口啦——需要我帮你做点什么吗？' },
  generic_help: { label: '通用', canInsert: false, fallback: '需要我帮你做点什么吗？' },
};

/** 行为构造器：id / 显示名 / 意图 / 给用户的建议话术 / 交给远端的生成方向。 */
function B(id, name, intent, suggestion, prompt, insert) {
  const meta = INTENT_META[intent] || INTENT_META.generic_help;
  return {
    id,
    name,
    intent,
    suggestion: suggestion || meta.fallback,
    prompt: prompt || '',
    // 生成结果是否能直接打进当前窗口。默认取意图元数据，可显式覆盖。
    insert: insert === undefined ? meta.canInsert : !!insert,
  };
}

/** 画像构造器。exe / winClass 都小写比对。 */
function P(id, name, category, exe, behaviors, winClass) {
  return {
    id,
    name,
    category,
    exe: (exe || []).map((s) => String(s).toLowerCase()),
    winClass: (winClass || []).map((s) => String(s).toLowerCase()),
    behaviors,
  };
}

/** 游戏类统一行为：攻略 / 过程 / 任务。游戏里绝不代写，只给建议。 */
const GAME_BEHAVIORS = [
  B('guide', '攻略推荐', 'game_guide',
    '需要我给你这份游戏的攻略吗？告诉我卡在哪一关/哪个 boss。',
    '你是资深游戏攻略作者。根据截图里的游戏画面，给出这一关/这个 boss 的具体打法：推荐阵容或装备、关键机制、注意事项、容易翻车的点。不清楚具体游戏时先说明，再给通用思路。用中文，分条列出，控制在 300 字内。'),
  B('live', '过程推荐', 'game_live',
    '需要我看着当前画面给即时建议吗？',
    '你在陪玩家打游戏，只能看到这一帧画面。用中文给出下一步具体建议：现在该做什么、走哪条路线、资源怎么分配、有什么风险。不要复述画面，只给行动建议，控制在 200 字内。'),
  B('quest', '任务与养成建议', 'game_quest',
    '需要我告诉你现在优先做哪些日常/周常吗？',
    '你是游戏效率规划助手。根据当前游戏画面与进度，给出今天优先做的任务清单（日常/周常/活动/养成），按性价比排序，并说明为什么。用中文分条列出，控制在 300 字内。'),
];

/**
 * 应用画像表（约 100 种，按常见软件排行整理）。
 * 注意顺序：包含匹配取"最长命中"，且过短的 exe 片段（<4 字符）不参与包含匹配，
 * 避免 qq 误吃 qqbrowser、wps 误吃 wpscloudsvr 之类。
 */
const APP_PROFILES = [
  // ---------------- 办公 / 文档 ----------------
  P('wps', 'WPS 文字', 'office', ['wps.exe'], [
    B('draft', '起草正文', 'word_writing', '需要我帮你起草这份文档吗？告诉我主题就行。',
      '根据窗口标题与屏幕内容确定主题，直接写出可用的中文正文段落（不要写"以下是…"这类元说明），600~1000 字。'),
    B('polish', '润色改写', 'doc_polish', '需要我帮你润色或续写这段内容吗？',
      '对文档中的文字做润色：修正语病、统一术语、让表达更专业流畅，保持原意。直接输出润色后的正文。'),
    B('outline', '列大纲', 'doc_outline', '需要我先给你列一份写作大纲吗？',
      '根据主题输出一份结构化写作大纲：一级标题 + 每个标题下 3~5 个要点。中文，只输出大纲本身。'),
  ]),
  P('wps-et', 'WPS 表格', 'office', ['et.exe'], [
    B('formula', '写公式', 'data_formula', '需要我帮你写这个公式吗？',
      '给出可直接粘贴的 WPS/Excel 公式，并解释每个参数的含义。'),
    B('analysis', '数据分析', 'data_analysis', '需要我帮你分析这份数据并给出结论吗？',
      '基于表格数据给出分析结论：趋势、异常值、关键指标，并给出可执行建议。中文分条列出。'),
    B('chart', '图表建议', 'data_chart', '需要我告诉你这组数据该用什么图表吗？',
      '根据数据类型推荐合适的图表类型，并说明 X/Y 轴与指标怎么选。'),
  ]),
  P('wps-ppt', 'WPS 演示', 'office', ['wpp.exe'], [
    B('outline', '写大纲', 'doc_outline', '需要我帮你梳理这份 PPT 的结构吗？',
      '输出这份演示的完整页级大纲：每页标题 + 要点 3~5 条。中文。'),
    B('script', '写讲稿', 'media_script', '需要我帮你写每页的讲稿吗？',
      '按页输出演讲者讲稿，口语化、可直接念，每页 80~150 字。'),
    B('caption', '优化文案', 'design_caption', '需要我帮你精简页面文案吗？',
      '把页面文字改写成更短更有力的 PPT 文案：每页不超过 3 行、每行不超过 15 字。'),
  ]),
  P('word', 'Microsoft Word', 'office', ['winword.exe'], [
    B('draft', '起草正文', 'word_writing', '需要我帮你起草这份文档吗？告诉我主题就行。',
      '根据窗口标题与屏幕内容确定主题，直接写出可用的中文正文段落（不要元说明），600~1000 字。'),
    B('polish', '润色改写', 'doc_polish', '需要我帮你润色或续写这段内容吗？',
      '对文档中的文字做润色：修正语病、统一术语、保持原意。直接输出润色后的正文。'),
    B('review', '校对检查', 'doc_review', '需要我帮你检查错别字和表述吗？',
      '检查文档中的错别字、标点、数字与逻辑问题，按"原文 → 建议"格式列出。'),
  ]),
  P('excel', 'Microsoft Excel', 'office', ['excel.exe'], [
    B('formula', '写公式', 'data_formula', '需要我帮你写这个公式吗？',
      '给出可直接粘贴的 Excel 公式，并解释参数含义与适用版本。'),
    B('analysis', '数据分析', 'data_analysis', '需要我帮你分析这份数据并给出结论吗？',
      '基于表格数据给出分析结论：趋势、异常值、关键指标，并给可执行建议。中文分条列出。'),
    B('chart', '图表建议', 'data_chart', '需要我告诉你这组数据该用什么图表吗？',
      '根据数据类型推荐图表类型，说明 X/Y 轴与指标选择。'),
  ]),
  P('powerpoint', 'Microsoft PowerPoint', 'office', ['powerpnt.exe'], [
    B('outline', '写大纲', 'doc_outline', '需要我帮你梳理这份 PPT 的结构吗？',
      '输出页级大纲：每页标题 + 要点 3~5 条。'),
    B('script', '写讲稿', 'media_script', '需要我帮你写每页的讲稿吗？',
      '按页输出可念的口语化讲稿，每页 80~150 字。'),
    B('caption', '优化文案', 'design_caption', '需要我帮你精简页面文案吗？',
      '把页面文字改成更短更有力的 PPT 文案。'),
  ]),
  P('onenote', 'OneNote', 'office', ['onenote.exe', 'onename'], [
    B('note', '整理笔记', 'learning_note', '需要我把这个知识点整理成笔记吗？',
      '把内容整理成结构化笔记：核心概念 → 要点 → 例子 → 待确认问题。'),
    B('summary', '总结要点', 'doc_summary', '需要我把这页笔记总结成要点吗？',
      '提炼这页笔记的关键结论与待办，控制在 5 条内。'),
    B('draft', '继续写', 'word_writing', '需要我帮你接着写下去吗？',
      '延续已有内容继续写，保持风格一致。'),
  ]),
  P('notepad', '记事本', 'office', ['notepad.exe'], [
    B('draft', '起草内容', 'word_writing', '需要我帮你写这段内容吗？',
      '根据主题写出可直接使用的中文正文，不带元说明。'),
    B('polish', '整理排版', 'doc_polish', '需要我帮你整理这段文本吗？',
      '整理文本：分段、对齐、去掉冗余空行与重复内容。输出整理后的文本。'),
    B('note', '转成笔记', 'learning_note', '需要我把这段内容整理成结构化笔记吗？',
      '把文本整理成结构化笔记：核心概念 → 要点 → 例子。'),
  ]),
  P('notepadpp', 'Notepad++', 'office', ['notepad++.exe'], [
    B('code', '写代码', 'code_write', '需要我帮你写这段代码吗？',
      '根据上下文写出代码，只输出代码块，不加解释。'),
    B('debug', '排错', 'code_debug', '卡在报错上了？把报错贴给我，我帮你查。',
      '根据报错信息定位原因并给出修改方案，给出修改后的代码。'),
    B('polish', '整理文本', 'doc_polish', '需要我帮你整理这段文本吗？',
      '整理文本：去重、排序、格式规范化。输出整理后的文本。'),
  ]),
  P('typora', 'Typora', 'office', ['typora.exe'], [
    B('draft', '起草正文', 'word_writing', '需要我帮你起草这篇文章吗？',
      '用 Markdown 写出正文，含标题层级、列表与必要代码块。'),
    B('polish', '润色改写', 'doc_polish', '需要我帮你润色这段 Markdown 吗？',
      '润色 Markdown 正文，保持 Markdown 语法正确。'),
    B('outline', '列大纲', 'doc_outline', '需要我先给你列一份写作大纲吗？',
      '输出 Markdown 大纲：一级/二级标题 + 要点。'),
  ]),
  P('obsidian', 'Obsidian', 'office', ['obsidian.exe'], [
    B('note', '整理笔记', 'learning_note', '需要我把这个知识点整理成笔记吗？',
      '输出 Obsidian 风格笔记：含 frontmatter、双链 [[ ]] 与标签 #。'),
    B('summary', '总结要点', 'doc_summary', '需要我把这篇笔记总结成要点吗？',
      '提炼关键结论与待办，控制在 5 条内。'),
    B('draft', '继续写', 'word_writing', '需要我帮你接着写下去吗？',
      '延续已有内容继续写，保持风格一致。'),
  ]),
  P('notion', 'Notion', 'office', ['notion.exe'], [
    B('draft', '起草内容', 'word_writing', '需要我帮你起草这页内容吗？',
      '写出 Notion 页面内容，用 Markdown 表达，含标题与待办列表。'),
    B('outline', '列大纲', 'doc_outline', '需要我先给你列一份结构大纲吗？',
      '输出页面结构大纲：分区标题 + 每个分区的要点。'),
    B('summary', '总结要点', 'doc_summary', '需要我把这页总结成要点吗？',
      '提炼关键结论与待办，控制在 5 条内。'),
  ]),
  P('acrobat', 'Adobe Acrobat', 'office', ['acrord32.exe', 'acrobat.exe'], [
    B('summary', '总结这份 PDF', 'doc_summary', '需要我把这份 PDF 总结成要点吗？',
      '总结屏幕上这份 PDF 的核心内容：结论、关键数据、待办。中文分条列出。'),
    B('translate', '翻译', 'doc_translate', '需要我翻译屏幕上这段外文吗？',
      '把屏幕上的外文翻译成中文，保持段落结构。'),
    B('note', '做读书笔记', 'learning_note', '需要我把这份资料整理成笔记吗？',
      '整理成结构化笔记：核心概念 → 要点 → 可行动项。'),
  ]),
  P('foxit', '福昕阅读器', 'office', ['foxitreader.exe', 'foxitpdfreader.exe'], [
    B('summary', '总结这份 PDF', 'doc_summary', '需要我把这份 PDF 总结成要点吗？',
      '总结屏幕上这份 PDF 的核心内容。中文分条列出。'),
    B('translate', '翻译', 'doc_translate', '需要我翻译屏幕上这段外文吗？',
      '把屏幕上的外文翻译成中文。'),
    B('note', '做笔记', 'learning_note', '需要我把这份资料整理成笔记吗？',
      '整理成结构化笔记。'),
  ]),
  P('sumatra', 'SumatraPDF', 'office', ['sumatrapdf.exe'], [
    B('summary', '总结这份 PDF', 'doc_summary', '需要我把这份 PDF 总结成要点吗？', '总结屏幕上这份 PDF 的核心内容。'),
    B('translate', '翻译', 'doc_translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('note', '做笔记', 'learning_note', '需要我把这份资料整理成笔记吗？', '整理成结构化笔记。'),
  ]),
  P('wpspdf', 'WPS PDF', 'office', ['wpspdf.exe'], [
    B('summary', '总结这份 PDF', 'doc_summary', '需要我把这份 PDF 总结成要点吗？', '总结屏幕上这份 PDF 的核心内容。'),
    B('translate', '翻译', 'doc_translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('note', '做笔记', 'learning_note', '需要我把这份资料整理成笔记吗？', '整理成结构化笔记。'),
  ]),
  P('xmind', 'XMind', 'office', ['xmind.exe'], [
    B('outline', '生成导图结构', 'doc_outline', '需要我帮你生成这份导图的分支结构吗？',
      '输出中心主题 + 一级分支 + 二级分支，用缩进列表表达，方便直接录入。'),
    B('idea', '头脑风暴', 'design_idea', '需要我给这个主题多想几个分支吗？',
      '围绕主题给出 8~12 个分支方向，覆盖不同角度。'),
    B('summary', '总结要点', 'doc_summary', '需要我把这份导图总结成一段话吗？',
      '把导图内容压缩成一段连贯的中文概述。'),
  ]),
  P('mindmanager', 'MindManager', 'office', ['mindmanager.exe'], [
    B('outline', '生成导图结构', 'doc_outline', '需要我帮你生成这份导图的分支结构吗？', '输出中心主题 + 分支，用缩进列表。'),
    B('idea', '头脑风暴', 'design_idea', '需要我给这个主题多想几个分支吗？', '给出 8~12 个分支方向。'),
    B('summary', '总结要点', 'doc_summary', '需要我把这份导图总结成一段话吗？', '压缩成一段连贯概述。'),
  ]),
  P('visio', 'Visio', 'office', ['visio.exe'], [
    B('outline', '设计图结构', 'doc_outline', '需要我帮你设计这张图的结构吗？',
      '给出图形结构：节点、连线关系、分层。用文字描述清楚可直接照着画。'),
    B('explain', '解释这张图', 'code_explain', '这张流程图看不懂？我给你讲一遍。', '解释图的结构与流程含义。'),
    B('review', '检查遗漏', 'doc_review', '需要我帮你检查这张图有没有遗漏吗？', '列出图中可能缺失的节点与异常分支。'),
  ]),

  // ---------------- 浏览器 ----------------
  P('chrome', 'Google Chrome', 'browser', ['chrome.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？',
      '总结当前网页的核心内容：结论、关键数据、可行动项。中文分条列出，300 字内。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？',
      '把屏幕上的外文翻译成中文，保持段落结构。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？',
      '把页面内容整理成可保存的笔记：来源 → 要点 → 我的结论。'),
  ]),
  P('edge', 'Microsoft Edge', 'browser', ['msedge.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？', '总结当前网页的核心内容，中文分条列出，300 字内。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？', '整理成可保存的笔记。'),
  ]),
  P('firefox', 'Firefox', 'browser', ['firefox.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？', '总结当前网页的核心内容。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？', '整理成可保存的笔记。'),
  ]),
  P('browser360', '360 安全浏览器', 'browser', ['360se.exe', '360chrome.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？', '总结当前网页的核心内容。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？', '整理成可保存的笔记。'),
  ]),
  P('qqbrowser', 'QQ 浏览器', 'browser', ['qqbrowser.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？', '总结当前网页的核心内容。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？', '整理成可保存的笔记。'),
  ]),
  P('sogou', '搜狗浏览器', 'browser', ['sogouexplorer.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？', '总结当前网页的核心内容。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？', '整理成可保存的笔记。'),
  ]),
  P('opera', 'Opera', 'browser', ['opera.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？', '总结当前网页的核心内容。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？', '整理成可保存的笔记。'),
  ]),
  P('vivaldi', 'Vivaldi', 'browser', ['vivaldi.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？', '总结当前网页的核心内容。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？', '整理成可保存的笔记。'),
  ]),
  P('brave', 'Brave', 'browser', ['brave.exe'], [
    B('summary', '总结这个页面', 'search_summary', '需要我把这个页面总结成要点吗？', '总结当前网页的核心内容。'),
    B('translate', '翻译页面', 'translate', '需要我翻译屏幕上这段外文吗？', '把外文翻译成中文。'),
    B('material', '整理资料', 'collecting_material', '复制的资料要我帮你整理成笔记吗？', '整理成可保存的笔记。'),
  ]),

  // ---------------- 即时通讯 ----------------
  P('wechat', '微信', 'im', ['wechat.exe', 'weixin.exe'], [
    B('reply', '起草回复', 'message_reply', '需要我帮你起草一条回复吗？',
      '根据聊天上下文起草一条自然、得体的中文回复，直接输出回复内容，不加引号和说明。'),
    B('summary', '总结聊天', 'message_summary', '需要我把这段聊天总结成要点吗？',
      '总结聊天要点：对方诉求、已确认事项、待办与截止时间。'),
    B('polish', '润色措辞', 'doc_polish', '需要我帮你把这句话说得更得体吗？',
      '把草稿改写得更加礼貌与清晰，保持原意，直接输出改写后的文字。'),
  ]),
  P('wecom', '企业微信', 'im', ['wxwork.exe'], [
    B('reply', '起草回复', 'message_reply', '需要我帮你起草一条工作回复吗？',
      '起草一条专业、简洁的中文工作回复，直接输出回复内容。'),
    B('summary', '总结聊天', 'message_summary', '需要我把这段聊天总结成要点吗？',
      '总结聊天要点：诉求、已确认事项、待办与截止时间。'),
    B('notice', '写通知', 'word_writing', '需要我帮你写一版通知/汇报文案吗？',
      '写一版可直接发送的工作通知：背景 → 要求 → 截止时间 → 联系人。'),
  ]),
  P('qq', 'QQ', 'im', ['qq.exe', 'qqnt.exe'], [
    B('reply', '起草回复', 'message_reply', '需要我帮你起草一条回复吗？', '根据聊天上下文起草一条自然的中文回复。'),
    B('summary', '总结聊天', 'message_summary', '需要我把这段聊天总结成要点吗？', '总结聊天要点与待办。'),
    B('polish', '润色措辞', 'doc_polish', '需要我帮你把这句话说得更得体吗？', '改写得更礼貌清晰。'),
  ]),
  P('tim', 'TIM', 'im', ['tim.exe'], [
    B('reply', '起草回复', 'message_reply', '需要我帮你起草一条回复吗？', '起草一条自然的中文回复。'),
    B('summary', '总结聊天', 'message_summary', '需要我把这段聊天总结成要点吗？', '总结聊天要点与待办。'),
    B('polish', '润色措辞', 'doc_polish', '需要我帮你把这句话说得更得体吗？', '改写得更礼貌清晰。'),
  ]),
  P('dingtalk', '钉钉', 'im', ['dingtalk.exe'], [
    B('reply', '起草回复', 'message_reply', '需要我帮你起草一条工作回复吗？', '起草一条专业简洁的中文工作回复。'),
    B('summary', '总结群消息', 'message_summary', '需要我把这段群聊总结成要点吗？', '总结群聊要点：决策、待办、负责人、截止时间。'),
    B('notice', '写通知', 'word_writing', '需要我帮你写一版通知文案吗？', '写可直接发送的工作通知。'),
  ]),
  P('feishu', '飞书', 'im', ['lark.exe', 'feishu.exe'], [
    B('reply', '起草回复', 'message_reply', '需要我帮你起草一条工作回复吗？', '起草一条专业简洁的中文工作回复。'),
    B('summary', '总结文档/聊天', 'message_summary', '需要我把这段内容总结成要点吗？', '总结要点：决策、待办、负责人、截止时间。'),
    B('draft', '写文档', 'word_writing', '需要我帮你起草这份文档吗？', '写出可直接使用的中文正文。'),
  ]),
  P('telegram', 'Telegram', 'im', ['telegram.exe'], [
    B('reply', '起草回复', 'message_reply', '需要我帮你起草一条回复吗？', '起草一条自然的中文回复。'),
    B('translate', '翻译消息', 'translate', '需要我翻译这条外文消息吗？', '把外文消息翻译成中文。'),
    B('summary', '总结聊天', 'message_summary', '需要我把这段聊天总结成要点吗？', '总结聊天要点与待办。'),
  ]),
  P('discord', 'Discord', 'im', ['discord.exe'], [
    B('reply', '起草回复', 'message_reply', '需要我帮你起草一条回复吗？', '起草一条自然的中文回复。'),
    B('translate', '翻译消息', 'translate', '需要我翻译这条外文消息吗？', '把外文消息翻译成中文。'),
    B('summary', '总结频道', 'message_summary', '需要我把这段讨论总结成要点吗？', '总结讨论要点与结论。'),
  ]),
  P('outlook', 'Outlook', 'im', ['outlook.exe'], [
    B('reply', '起草邮件回复', 'message_reply', '需要我帮你起草一封邮件回复吗？',
      '起草一封结构完整的中文邮件回复：称呼 → 答复要点 → 下一步 → 落款。'),
    B('draft', '写新邮件', 'word_writing', '需要我帮你写这封邮件吗？',
      '写一封可直接发送的中文邮件：主题 → 正文 → 明确诉求 → 落款。'),
    B('summary', '总结邮件', 'message_summary', '需要我把这封邮件总结成要点吗？', '提炼诉求、待办与截止时间。'),
  ]),
  P('foxmail', 'Foxmail', 'im', ['foxmail.exe'], [
    B('reply', '起草邮件回复', 'message_reply', '需要我帮你起草一封邮件回复吗？', '起草结构完整的中文邮件回复。'),
    B('draft', '写新邮件', 'word_writing', '需要我帮你写这封邮件吗？', '写一封可直接发送的中文邮件。'),
    B('summary', '总结邮件', 'message_summary', '需要我把这封邮件总结成要点吗？', '提炼诉求、待办与截止时间。'),
  ]),
  P('thunderbird', 'Thunderbird', 'im', ['thunderbird.exe'], [
    B('reply', '起草邮件回复', 'message_reply', '需要我帮你起草一封邮件回复吗？', '起草结构完整的中文邮件回复。'),
    B('draft', '写新邮件', 'word_writing', '需要我帮你写这封邮件吗？', '写一封可直接发送的中文邮件。'),
    B('summary', '总结邮件', 'message_summary', '需要我把这封邮件总结成要点吗？', '提炼诉求、待办与截止时间。'),
  ]),

  // ---------------- 开发 ----------------
  P('vscode', 'VS Code', 'dev', ['code.exe'], [
    B('debug', '排错', 'code_debug', '卡在报错上了？把报错贴给我，我帮你查。',
      '根据报错信息定位根因，给出最小修改方案与修改后的代码。'),
    B('code', '写代码', 'code_write', '需要我帮你写这段代码吗？',
      '根据上下文写出代码，只输出代码块，语言与项目保持一致。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？',
      '审查这段代码：潜在 bug、边界条件、性能与可读性问题，按严重程度排序给出修改建议。'),
  ]),
  P('cursor', 'Cursor', 'dev', ['cursor.exe'], [
    B('code', '写代码', 'code_write', '需要我帮你写这段代码吗？', '根据上下文写出代码，只输出代码块。'),
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '定位根因并给出修改后的代码。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？', '按严重程度列出问题与修改建议。'),
  ]),
  P('trae', 'Trae', 'dev', ['trae.exe'], [
    B('code', '写代码', 'code_write', '需要我帮你写这段代码吗？', '根据上下文写出代码，只输出代码块。'),
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '定位根因并给出修改后的代码。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？', '按严重程度列出问题与修改建议。'),
  ]),
  P('visualstudio', 'Visual Studio', 'dev', ['devenv.exe'], [
    B('debug', '排错', 'code_debug', '卡在编译/运行报错上了？我帮你查。', '根据报错定位根因并给出修改方案。'),
    B('code', '写代码', 'code_write', '需要我帮你写这段代码吗？', '按项目语言写出代码，只输出代码块。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？', '按严重程度列出问题与建议。'),
  ]),
  P('idea', 'IntelliJ IDEA', 'dev', ['idea64.exe', 'idea.exe'], [
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '根据报错定位根因并给出修改方案。'),
    B('code', '写代码', 'code_write', '需要我帮你写这段 Java 代码吗？', '写出 Java 代码，只输出代码块。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？', '按严重程度列出问题与建议。'),
  ]),
  P('pycharm', 'PyCharm', 'dev', ['pycharm64.exe', 'pycharm.exe'], [
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '根据 traceback 定位根因并给出修改方案。'),
    B('code', '写代码', 'code_write', '需要我帮你写这段 Python 吗？', '写出 Python 代码，只输出代码块。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？', '按严重程度列出问题与建议。'),
  ]),
  P('webstorm', 'WebStorm', 'dev', ['webstorm64.exe'], [
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '定位根因并给出修改方案。'),
    B('code', '写代码', 'code_write', '需要我帮你写这段前端代码吗？', '写出 JS/TS 代码，只输出代码块。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？', '按严重程度列出问题与建议。'),
  ]),
  P('androidstudio', 'Android Studio', 'dev', ['studio64.exe'], [
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '根据报错定位根因并给出修改方案。'),
    B('code', '写代码', 'code_write', '需要我帮你写这段 Kotlin/Java 吗？', '写出代码，只输出代码块。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？', '按严重程度列出问题与建议。'),
  ]),
  P('eclipse', 'Eclipse', 'dev', ['eclipse.exe'], [
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '定位根因并给出修改方案。'),
    B('code', '写代码', 'code_write', '需要我帮你写这段代码吗？', '写出代码，只输出代码块。'),
    B('review', '代码审查', 'code_review', '需要我 review 一下这段代码吗？', '按严重程度列出问题与建议。'),
  ]),
  P('sublime', 'Sublime Text', 'dev', ['sublime_text.exe'], [
    B('code', '写代码', 'code_write', '需要我帮你写这段代码吗？', '写出代码，只输出代码块。'),
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '定位根因并给出修改方案。'),
    B('polish', '整理文本', 'doc_polish', '需要我帮你整理这段文本吗？', '整理文本并输出。'),
  ]),
  P('vim', 'gVim', 'dev', ['gvim.exe', 'vim.exe'], [
    B('code', '写代码', 'code_write', '需要我帮你写这段代码吗？', '写出代码，只输出代码块。'),
    B('debug', '排错', 'code_debug', '卡在报错上了？我帮你查。', '定位根因并给出修改方案。'),
    B('explain', '解释命令', 'code_explain', '这个 vim 操作看不懂？我给你讲一遍。', '解释命令含义与用法。'),
  ]),
  P('postman', 'Postman', 'dev', ['postman.exe'], [
    B('api', '查接口文档', 'api_lookup', '需要我帮你查这个接口/API 的用法吗？',
      '说明这个接口的用途、请求参数、返回结构与常见错误码。'),
    B('debug', '排查请求', 'code_debug', '请求报错了？我帮你查。', '根据状态码与响应定位原因并给出修正。'),
    B('code', '生成请求代码', 'code_write', '需要我把这个请求转成代码吗？', '输出可直接使用的请求代码（curl/JS/Python）。'),
  ]),
  P('navicat', 'Navicat', 'dev', ['navicat.exe'], [
    B('sql', '写 SQL', 'code_write', '需要我帮你写这条 SQL 吗？',
      '输出可直接执行的 SQL，并说明索引与性能注意事项。'),
    B('debug', '排查 SQL 报错', 'code_debug', 'SQL 报错了？我帮你查。', '根据报错定位原因并给出修正后的 SQL。'),
    B('explain', '解释查询', 'code_explain', '这条 SQL 看不懂？我给你讲一遍。', '解释 SQL 执行逻辑与结果含义。'),
  ]),
  P('dbeaver', 'DBeaver', 'dev', ['dbeaver.exe'], [
    B('sql', '写 SQL', 'code_write', '需要我帮你写这条 SQL 吗？', '输出可直接执行的 SQL。'),
    B('debug', '排查 SQL 报错', 'code_debug', 'SQL 报错了？我帮你查。', '定位原因并给出修正后的 SQL。'),
    B('explain', '解释查询', 'code_explain', '这条 SQL 看不懂？我给你讲一遍。', '解释 SQL 执行逻辑。'),
  ]),
  P('xshell', 'Xshell', 'dev', ['xshell.exe'], [
    B('cmd', '写命令', 'code_write', '需要我帮你写这条命令吗？', '输出可直接执行的 Shell 命令并说明风险。'),
    B('debug', '排查报错', 'code_debug', '命令报错了？我帮你查。', '根据报错定位原因并给出修正。'),
    B('explain', '解释输出', 'code_explain', '这段输出看不懂？我给你讲一遍。', '解释输出含义。'),
  ]),
  P('putty', 'PuTTY', 'dev', ['putty.exe'], [
    B('cmd', '写命令', 'code_write', '需要我帮你写这条命令吗？', '输出可直接执行的 Shell 命令并说明风险。'),
    B('debug', '排查报错', 'code_debug', '命令报错了？我帮你查。', '定位原因并给出修正。'),
    B('explain', '解释输出', 'code_explain', '这段输出看不懂？我给你讲一遍。', '解释输出含义。'),
  ]),
  P('windowsterminal', 'Windows Terminal', 'dev', ['windowsterminal.exe', 'windowsterminal'], [
    B('cmd', '写命令', 'code_write', '需要我帮你写这条命令吗？', '输出命令并说明风险。'),
    B('debug', '排查报错', 'code_debug', '命令报错了？我帮你查。', '定位原因并给出修正。'),
    B('explain', '解释输出', 'code_explain', '这段输出看不懂？我给你讲一遍。', '解释输出含义。'),
  ]),
  P('powershell', 'PowerShell', 'dev', ['powershell.exe', 'pwsh.exe'], [
    B('cmd', '写命令', 'code_write', '需要我帮你写这条命令吗？', '输出 PowerShell 命令并说明风险。'),
    B('debug', '排查报错', 'code_debug', '命令报错了？我帮你查。', '定位原因并给出修正。'),
    B('explain', '解释输出', 'code_explain', '这段输出看不懂？我给你讲一遍。', '解释输出含义。'),
  ]),
  P('gitbash', 'Git Bash', 'dev', ['mintty.exe', 'bash.exe'], [
    B('cmd', '写 git 命令', 'code_write', '需要我帮你写这条 git 命令吗？', '输出命令并说明风险。'),
    B('debug', '排查 git 报错', 'code_debug', 'git 报错了？我帮你查。', '定位原因并给出修正。'),
    B('explain', '解释输出', 'code_explain', '这段输出看不懂？我给你讲一遍。', '解释输出含义。'),
  ]),
  P('docker', 'Docker Desktop', 'dev', ['docker desktop.exe', 'dockerdesktop.exe'], [
    B('cmd', '写命令', 'code_write', '需要我帮你写这条 docker 命令吗？', '输出命令并说明风险。'),
    B('debug', '排查容器问题', 'code_debug', '容器起不来/报错了？我帮你查。', '根据日志定位原因并给出修正。'),
    B('explain', '解释日志', 'code_explain', '这段日志看不懂？我给你讲一遍。', '解释日志含义。'),
  ]),
  P('vmware', 'VMware', 'dev', ['vmware.exe', 'vmplayer.exe'], [
    B('debug', '排查虚拟机问题', 'code_debug', '虚拟机出问题了？我帮你查。', '根据报错定位原因并给出修正步骤。'),
    B('cmd', '写配置', 'code_write', '需要我帮你写这份配置吗？', '输出配置项并说明作用。'),
    B('explain', '解释报错', 'code_explain', '这段报错看不懂？我给你讲一遍。', '解释报错含义。'),
  ]),
  P('virtualbox', 'VirtualBox', 'dev', ['virtualbox.exe', 'virtualboxvm.exe'], [
    B('debug', '排查虚拟机问题', 'code_debug', '虚拟机出问题了？我帮你查。', '定位原因并给出修正步骤。'),
    B('cmd', '写配置', 'code_write', '需要我帮你写这份配置吗？', '输出配置项并说明作用。'),
    B('explain', '解释报错', 'code_explain', '这段报错看不懂？我给你讲一遍。', '解释报错含义。'),
  ]),
  P('filezilla', 'FileZilla', 'dev', ['filezilla.exe'], [
    B('debug', '排查传输失败', 'code_debug', '传输出错了？我帮你查。', '根据报错定位原因并给出修正。'),
    B('organize', '整理文件', 'file_organize', '需要我给你一套上传/归档方案吗？', '给出目录结构与传输顺序建议。'),
    B('explain', '解释报错', 'code_explain', '这段报错看不懂？我给你讲一遍。', '解释报错含义。'),
  ]),
  P('winscp', 'WinSCP', 'dev', ['winscp.exe'], [
    B('debug', '排查传输失败', 'code_debug', '传输出错了？我帮你查。', '定位原因并给出修正。'),
    B('organize', '整理文件', 'file_organize', '需要我给你一套同步方案吗？', '给出目录结构与同步策略。'),
    B('explain', '解释报错', 'code_explain', '这段报错看不懂？我给你讲一遍。', '解释报错含义。'),
  ]),
  P('wireshark', 'Wireshark', 'dev', ['wireshark.exe'], [
    B('explain', '解释抓包', 'code_explain', '这段流量看不懂？我给你讲一遍。', '解释关键报文与协议交互。'),
    B('debug', '排查网络问题', 'code_debug', '网络不通？我帮你查。', '根据抓包结果定位原因。'),
    B('cmd', '写过滤表达式', 'code_write', '需要我帮你写过滤表达式吗？', '输出过滤表达式并解释。'),
  ]),
  P('fiddler', 'Fiddler', 'dev', ['fiddler.exe'], [
    B('debug', '排查请求', 'code_debug', '请求异常？我帮你查。', '根据会话定位原因并给出修正。'),
    B('explain', '解释会话', 'code_explain', '这段会话看不懂？我给你讲一遍。', '解释请求/响应含义。'),
    B('cmd', '写规则', 'code_write', '需要我帮你写这条规则吗？', '输出规则脚本并说明作用。'),
  ]),

  // ---------------- 设计 / 媒体 ----------------
  P('photoshop', 'Photoshop', 'design', ['photoshop.exe'], [
    B('idea', '设计思路', 'design_idea', '需要我给你几个设计方向吗？',
      '给出 3 个具体可执行的设计方向：风格、配色、构图、字体建议。'),
    B('caption', '配图文案', 'design_caption', '需要我帮你写配图文案吗？',
      '写 3 版配图文案：标题 + 副标题，短而有力。'),
    B('steps', '操作步骤', 'code_explain', '需要我告诉你这个效果怎么做吗？',
      '给出 Photoshop 实现该效果的具体操作步骤。'),
  ]),
  P('illustrator', 'Illustrator', 'design', ['illustrator.exe'], [
    B('idea', '设计思路', 'design_idea', '需要我给你几个设计方向吗？', '给出风格、配色、构图建议。'),
    B('caption', '配图文案', 'design_caption', '需要我帮你写配图文案吗？', '写 3 版文案。'),
    B('steps', '操作步骤', 'code_explain', '需要我告诉你这个效果怎么做吗？', '给出 AI 实现步骤。'),
  ]),
  P('premiere', 'Premiere Pro', 'design', ['adobe premiere pro.exe', 'premiere.exe'], [
    B('steps', '剪辑思路', 'media_edit', '需要我给你一套剪辑思路吗？',
      '给出这条片的剪辑结构：开头钩子 → 分段 → 节奏点 → 收尾。'),
    B('script', '写脚本', 'media_script', '需要我帮你写脚本吗？', '输出分镜脚本：画面 + 旁白 + 时长。'),
    B('caption', '写标题', 'design_caption', '需要我帮你想几个视频标题吗？', '给出 8 个备选标题。'),
  ]),
  P('aftereffects', 'After Effects', 'design', ['afterfx.exe'], [
    B('steps', '做效果', 'media_edit', '需要我告诉你这个效果怎么做吗？', '给出 AE 实现步骤与关键参数。'),
    B('script', '写脚本', 'media_script', '需要我帮你写动效脚本吗？', '输出表达式或脚本并解释。'),
    B('idea', '创意方向', 'design_idea', '需要我给你几个动效创意吗？', '给出 3 个动效方向。'),
  ]),
  P('jianying', '剪映', 'design', ['jianyingpro.exe'], [
    B('steps', '剪辑思路', 'media_edit', '需要我给你一套剪辑思路吗？', '给出剪辑结构与节奏建议。'),
    B('script', '写口播稿', 'media_script', '需要我帮你写口播稿吗？', '写出可直接念的口播稿，按秒标注。'),
    B('caption', '写标题字幕', 'design_caption', '需要我帮你想标题和字幕吗？', '给出 8 个标题 + 字幕断句建议。'),
  ]),
  P('davinci', 'DaVinci Resolve', 'design', ['resolve.exe'], [
    B('steps', '调色思路', 'media_edit', '需要我给你一套调色思路吗？', '给出调色方向：曝光、对比、色温、风格化。'),
    B('script', '写脚本', 'media_script', '需要我帮你写脚本吗？', '输出分镜脚本。'),
    B('steps2', '剪辑结构', 'media_edit', '需要我给你一套剪辑结构吗？', '给出结构与节奏建议。'),
  ]),
  P('audition', 'Audition', 'design', ['audition.exe'], [
    B('steps', '处理思路', 'media_edit', '需要我给你一套音频处理思路吗？', '给出降噪、均衡、压缩的具体顺序与参数。'),
    B('script', '写配音稿', 'media_script', '需要我帮你写配音稿吗？', '写出配音稿并按秒标注。'),
    B('debug', '排查问题', 'code_debug', '音频有杂音/爆音？我帮你查。', '定位原因并给出处理步骤。'),
  ]),
  P('blender', 'Blender', 'design', ['blender.exe'], [
    B('steps', '建模思路', 'media_edit', '需要我告诉你这个模型怎么做吗？', '给出建模步骤与关键修改器。'),
    B('idea', '创意方向', 'design_idea', '需要我给你几个造型方向吗？', '给出 3 个造型/材质方向。'),
    B('debug', '排查渲染问题', 'code_debug', '渲染出错/太慢？我帮你查。', '定位原因并给出优化参数。'),
  ]),
  P('autocad', 'AutoCAD', 'design', ['acad.exe'], [
    B('steps', '绘图步骤', 'media_edit', '需要我告诉你这张图怎么画吗？', '给出绘图步骤与命令序列。'),
    B('review', '检查图纸', 'doc_review', '需要我帮你检查这张图有没有遗漏吗？', '列出可能缺失的尺寸、标注与图层问题。'),
    B('explain', '解释命令', 'code_explain', '这个命令看不懂？我给你讲一遍。', '解释命令与参数。'),
  ]),
  P('sketchup', 'SketchUp', 'design', ['sketchup.exe'], [
    B('steps', '建模思路', 'media_edit', '需要我告诉你这个模型怎么建吗？', '给出建模步骤。'),
    B('idea', '设计方向', 'design_idea', '需要我给你几个空间布局方向吗？', '给出 3 个布局方向。'),
    B('explain', '解释操作', 'code_explain', '这个操作看不懂？我给你讲一遍。', '解释操作含义。'),
  ]),
  P('solidworks', 'SolidWorks', 'design', ['sldworks.exe'], [
    B('steps', '建模思路', 'media_edit', '需要我告诉你这个零件怎么建吗？', '给出建模步骤与约束顺序。'),
    B('review', '检查模型', 'doc_review', '需要我帮你检查这个装配体吗？', '列出可能的干涉与约束缺失。'),
    B('explain', '解释报错', 'code_explain', '这个报错看不懂？我给你讲一遍。', '解释报错含义。'),
  ]),
  P('figma', 'Figma', 'design', ['figma.exe'], [
    B('idea', '设计思路', 'design_idea', '需要我给你几个设计方向吗？', '给出风格、配色、布局建议。'),
    B('caption', '配图文案', 'design_caption', '需要我帮你写界面文案吗？', '写出界面文案，简洁一致。'),
    B('review', '检查一致性', 'doc_review', '需要我帮你检查界面一致性吗？', '列出间距、字号、颜色不一致的地方。'),
  ]),
  P('axure', 'Axure RP', 'design', ['axure.exe'], [
    B('outline', '梳理原型结构', 'doc_outline', '需要我帮你梳理这个原型的结构吗？', '给出页面结构与跳转关系。'),
    B('idea', '交互方案', 'design_idea', '需要我给你几个交互方案吗？', '给出 3 个交互方案与取舍。'),
    B('caption', '界面文案', 'design_caption', '需要我帮你写界面文案吗？', '写出界面文案。'),
  ]),
  P('lightroom', 'Lightroom', 'design', ['lightroom.exe'], [
    B('steps', '调色思路', 'media_edit', '需要我给你一套调色思路吗？', '给出调色方向与参数。'),
    B('idea', '风格方向', 'design_idea', '需要我给你几个后期风格吗？', '给出 3 个风格方向与参数。'),
    B('organize', '整理照片', 'file_organize', '需要我给你一套照片归档方案吗？', '给出目录结构与命名规则。'),
  ]),
  P('coreldraw', 'CorelDRAW', 'design', ['coreldraw.exe'], [
    B('idea', '设计思路', 'design_idea', '需要我给你几个设计方向吗？', '给出风格与构图建议。'),
    B('caption', '配图文案', 'design_caption', '需要我帮你写配图文案吗？', '写 3 版文案。'),
    B('steps', '操作步骤', 'code_explain', '需要我告诉你这个效果怎么做吗？', '给出操作步骤。'),
  ]),
  P('obs', 'OBS Studio', 'design', ['obs64.exe', 'obs32.exe'], [
    B('steps', '推流设置', 'media_edit', '需要我帮你检查推流设置吗？', '给出码率、分辨率、编码器的推荐参数。'),
    B('script', '写直播稿', 'media_script', '需要我帮你写直播话术吗？', '写出开场 + 转场 + 促单话术。'),
    B('debug', '排查问题', 'code_debug', '卡顿/黑屏？我帮你查。', '定位原因并给出修正步骤。'),
  ]),
  P('formatfactory', '格式工厂', 'design', ['formatfactory.exe'], [
    B('steps', '转换设置', 'media_edit', '需要我告诉你怎么转最合适吗？', '给出格式、码率与分辨率建议。'),
    B('debug', '排查失败', 'code_debug', '转换失败了？我帮你查。', '定位原因并给出修正。'),
    B('organize', '整理文件', 'file_organize', '需要我给你一套输出整理方案吗？', '给出目录结构与命名规则。'),
  ]),

  // ---------------- 系统 / 工具 ----------------
  P('explorer', '资源管理器', 'tool', ['explorer.exe'], [
    B('organize', '整理文件', 'file_organize', '需要我给你一套归档整理方案吗？',
      '给出目录结构、命名规则与清理顺序，说明哪些能动哪些不能动。'),
    B('review', '检查命名', 'doc_review', '需要我帮你检查文件命名是否规范吗？', '列出命名不规范的文件与建议改法。'),
    B('summary', '总结目录', 'doc_summary', '需要我帮你梳理这个目录里都有什么吗？', '按类型归纳目录内容。'),
  ]),
  P('everything', 'Everything', 'tool', ['everything.exe'], [
    B('cmd', '写搜索语法', 'code_write', '需要我帮你写搜索表达式吗？', '输出 Everything 搜索语法并解释。'),
    B('organize', '整理文件', 'file_organize', '需要我给你一套清理方案吗？', '给出清理顺序与风险提示。'),
    B('explain', '解释结果', 'code_explain', '搜索结果看不懂？我给你讲一遍。', '解释结果含义。'),
  ]),
  P('winrar', 'WinRAR', 'tool', ['winrar.exe'], [
    B('cmd', '写命令', 'code_write', '需要我帮你写这条压缩命令吗？', '输出命令行并解释参数。'),
    B('organize', '整理归档', 'file_organize', '需要我给你一套归档方案吗？', '给出分卷与命名建议。'),
    B('debug', '排查解压失败', 'code_debug', '解压失败了？我帮你查。', '定位原因并给出修正。'),
  ]),
  P('bandizip', 'Bandizip', 'tool', ['bandizip.exe'], [
    B('cmd', '写命令', 'code_write', '需要我帮你写这条压缩命令吗？', '输出命令行并解释参数。'),
    B('organize', '整理归档', 'file_organize', '需要我给你一套归档方案吗？', '给出分卷与命名建议。'),
    B('debug', '排查解压失败', 'code_debug', '解压失败了？我帮你查。', '定位原因并给出修正。'),
  ]),
  P('potplayer', 'PotPlayer', 'tool', ['potplayermini64.exe', 'potplayer.exe'], [
    B('summary', '总结视频内容', 'doc_summary', '需要我把这段视频内容总结成要点吗？', '总结画面内容要点。'),
    B('translate', '翻译字幕', 'translate', '需要我翻译屏幕上这段字幕吗？', '把字幕翻译成中文。'),
    B('note', '做笔记', 'learning_note', '需要我把这段视频整理成笔记吗？', '整理成结构化笔记。'),
  ]),
  P('vlc', 'VLC', 'tool', ['vlc.exe'], [
    B('summary', '总结视频内容', 'doc_summary', '需要我把这段视频内容总结成要点吗？', '总结画面内容要点。'),
    B('translate', '翻译字幕', 'translate', '需要我翻译屏幕上这段字幕吗？', '把字幕翻译成中文。'),
    B('debug', '排查播放问题', 'code_debug', '播放卡顿/没声音？我帮你查。', '定位原因并给出修正。'),
  ]),
  P('qqmusic', 'QQ 音乐', 'tool', ['qqmusic.exe'], [
    B('caption', '写文案', 'design_caption', '需要我帮这首曲子写一段推荐文案吗？', '写出一段有感染力的推荐文案。'),
    B('organize', '整理歌单', 'file_organize', '需要我给你一套歌单整理方案吗？', '给出分类与命名建议。'),
    B('summary', '总结歌词', 'doc_summary', '需要我帮你解读这段歌词吗？', '解读歌词含义与情绪。'),
  ]),
  P('neteasemusic', '网易云音乐', 'tool', ['cloudmusic.exe'], [
    B('caption', '写文案', 'design_caption', '需要我帮这首曲子写一段推荐文案吗？', '写出一段推荐文案。'),
    B('organize', '整理歌单', 'file_organize', '需要我给你一套歌单整理方案吗？', '给出分类与命名建议。'),
    B('summary', '总结歌词', 'doc_summary', '需要我帮你解读这段歌词吗？', '解读歌词含义。'),
  ]),
  P('spotify', 'Spotify', 'tool', ['spotify.exe'], [
    B('caption', '写文案', 'design_caption', '需要我写一段乐评文案吗？', '写出一段乐评。'),
    B('translate', '翻译歌词', 'translate', '需要我翻译这段歌词吗？', '把歌词翻译成中文。'),
    B('organize', '整理歌单', 'file_organize', '需要我给你一套歌单整理方案吗？', '给出分类建议。'),
  ]),
  P('xunlei', '迅雷', 'tool', ['thunder.exe', 'xunlei.exe'], [
    B('organize', '整理下载', 'file_organize', '需要我给你一套下载归档方案吗？', '给出目录结构与清理顺序。'),
    B('debug', '排查下载问题', 'code_debug', '速度慢/任务失败？我帮你查。', '定位原因并给出修正。'),
    B('review', '检查任务', 'doc_review', '需要我帮你看看哪些任务该清理吗？', '给出清理建议与风险提示。'),
  ]),
  P('baidunetdisk', '百度网盘', 'tool', ['baidunetdisk.exe'], [
    B('organize', '整理网盘', 'file_organize', '需要我给你一套网盘整理方案吗？', '给出目录结构与命名规则。'),
    B('debug', '排查同步问题', 'code_debug', '同步失败/限速？我帮你查。', '定位原因并给出修正。'),
    B('summary', '梳理内容', 'doc_summary', '需要我帮你梳理网盘里都有什么吗？', '按类型归纳内容。'),
  ]),
  P('aliyundrive', '阿里云盘', 'tool', ['aDrive.exe', 'aliyundrive.exe'], [
    B('organize', '整理网盘', 'file_organize', '需要我给你一套网盘整理方案吗？', '给出目录结构与命名规则。'),
    B('debug', '排查同步问题', 'code_debug', '同步失败？我帮你查。', '定位原因并给出修正。'),
    B('summary', '梳理内容', 'doc_summary', '需要我帮你梳理网盘里都有什么吗？', '按类型归纳内容。'),
  ]),
  P('onedrive', 'OneDrive', 'tool', ['onedrive.exe'], [
    B('organize', '整理同步目录', 'file_organize', '需要我给你一套同步整理方案吗？', '给出目录结构与冲突处理建议。'),
    B('debug', '排查同步问题', 'code_debug', '同步冲突/失败？我帮你查。', '定位原因并给出修正。'),
    B('review', '检查空间', 'doc_review', '需要我帮你看看哪些文件该清理吗？', '给出清理建议与风险提示。'),
  ]),
  P('todesk', 'ToDesk', 'tool', ['todesk.exe'], [
    B('debug', '排查连接问题', 'code_debug', '连不上/卡顿？我帮你查。', '定位原因并给出修正步骤。'),
    B('review', '安全建议', 'doc_review', '需要我给你一套远程安全建议吗？', '给出权限与密码安全建议。'),
    B('explain', '解释报错', 'code_explain', '这段报错看不懂？我给你讲一遍。', '解释报错含义。'),
  ]),
  P('sunlogin', '向日葵', 'tool', ['sunloginclient.exe'], [
    B('debug', '排查连接问题', 'code_debug', '连不上/卡顿？我帮你查。', '定位原因并给出修正步骤。'),
    B('review', '安全建议', 'doc_review', '需要我给你一套远程安全建议吗？', '给出安全建议。'),
    B('explain', '解释报错', 'code_explain', '这段报错看不懂？我给你讲一遍。', '解释报错含义。'),
  ]),
  P('teamviewer', 'TeamViewer', 'tool', ['teamviewer.exe'], [
    B('debug', '排查连接问题', 'code_debug', '连不上/卡顿？我帮你查。', '定位原因并给出修正步骤。'),
    B('review', '安全建议', 'doc_review', '需要我给你一套远程安全建议吗？', '给出安全建议。'),
    B('explain', '解释报错', 'code_explain', '这段报错看不懂？我给你讲一遍。', '解释报错含义。'),
  ]),
  P('snipaste', 'Snipaste', 'tool', ['snipaste.exe'], [
    B('explain', '解释截图内容', 'code_explain', '这张截图里的内容需要我解释吗？', '解释截图内容。'),
    B('translate', '翻译截图', 'translate', '需要我翻译截图里的文字吗？', '把截图文字翻译成中文。'),
    B('note', '整理成笔记', 'learning_note', '需要我把截图内容整理成笔记吗？', '整理成结构化笔记。'),
  ]),
  P('taskmgr', '任务管理器', 'tool', ['taskmgr.exe'], [
    B('debug', '排查高占用', 'code_debug', '哪个进程在吃资源？我帮你查。',
      '根据进程列表指出高占用进程、是否可结束、以及如何根治。'),
    B('explain', '解释指标', 'code_explain', '这些性能指标看不懂？我给你讲一遍。', '解释 CPU/内存/磁盘指标含义。'),
    B('review', '优化建议', 'doc_review', '需要我给你一套性能优化建议吗？', '给出启动项与服务优化建议。'),
  ]),
  P('cmd', '命令提示符', 'tool', ['cmd.exe'], [
    B('cmd', '写命令', 'code_write', '需要我帮你写这条命令吗？', '输出命令并说明风险。'),
    B('debug', '排查报错', 'code_debug', '命令报错了？我帮你查。', '定位原因并给出修正。'),
    B('explain', '解释输出', 'code_explain', '这段输出看不懂？我给你讲一遍。', '解释输出含义。'),
  ]),

  // ---------------- AI / 学习 ----------------
  P('chatgpt', 'ChatGPT', 'ai', ['chatgpt.exe'], [
    B('prompt', '优化提示词', 'code_write', '需要我帮你把这段提示词写得更有效吗？',
      '把用户的意图改写成结构化提示词：角色 → 任务 → 约束 → 输出格式。'),
    B('summary', '总结回答', 'doc_summary', '需要我把这个回答总结成要点吗？', '提炼关键结论。'),
    B('translate', '翻译', 'translate', '需要我翻译这段内容吗？', '翻译成中文。'),
  ]),
  P('claude', 'Claude', 'ai', ['claude.exe'], [
    B('prompt', '优化提示词', 'code_write', '需要我帮你把这段提示词写得更有效吗？', '改写成结构化提示词。'),
    B('summary', '总结回答', 'doc_summary', '需要我把这个回答总结成要点吗？', '提炼关键结论。'),
    B('translate', '翻译', 'translate', '需要我翻译这段内容吗？', '翻译成中文。'),
  ]),
  P('doubao', '豆包', 'ai', ['doubao.exe'], [
    B('prompt', '优化提示词', 'code_write', '需要我帮你把这段提示词写得更有效吗？', '改写成结构化提示词。'),
    B('summary', '总结回答', 'doc_summary', '需要我把这个回答总结成要点吗？', '提炼关键结论。'),
    B('translate', '翻译', 'translate', '需要我翻译这段内容吗？', '翻译成中文。'),
  ]),
  P('deepseek', 'DeepSeek', 'ai', ['deepseek.exe'], [
    B('prompt', '优化提示词', 'code_write', '需要我帮你把这段提示词写得更有效吗？', '改写成结构化提示词。'),
    B('summary', '总结回答', 'doc_summary', '需要我把这个回答总结成要点吗？', '提炼关键结论。'),
    B('translate', '翻译', 'translate', '需要我翻译这段内容吗？', '翻译成中文。'),
  ]),
  P('kimi', 'Kimi', 'ai', ['kimi.exe'], [
    B('prompt', '优化提示词', 'code_write', '需要我帮你把这段提示词写得更有效吗？', '改写成结构化提示词。'),
    B('summary', '总结长文', 'doc_summary', '需要我把这篇长文总结成要点吗？', '提炼关键结论。'),
    B('translate', '翻译', 'translate', '需要我翻译这段内容吗？', '翻译成中文。'),
  ]),
  P('yuanbao', '腾讯元宝', 'ai', ['yuanbao.exe'], [
    B('prompt', '优化提示词', 'code_write', '需要我帮你把这段提示词写得更有效吗？', '改写成结构化提示词。'),
    B('summary', '总结回答', 'doc_summary', '需要我把这个回答总结成要点吗？', '提炼关键结论。'),
    B('translate', '翻译', 'translate', '需要我翻译这段内容吗？', '翻译成中文。'),
  ]),
  P('anki', 'Anki', 'ai', ['anki.exe'], [
    B('note', '生成卡片', 'learning_note', '需要我帮你生成记忆卡片吗？',
      '生成 Anki 卡片：正面问题 + 背面答案，每张只考一个点。'),
    B('summary', '总结要点', 'doc_summary', '需要我把这个知识点总结成要点吗？', '提炼关键结论。'),
    B('explain', '解释概念', 'code_explain', '这个概念没懂？我给你讲一遍。', '用通俗语言解释概念。'),
  ]),
  P('baidufanyi', '百度翻译', 'ai', ['baidufanyi.exe'], [
    B('translate', '翻译', 'translate', '需要我翻译这段内容吗？', '翻译成中文，保持段落结构。'),
    B('polish', '润色译文', 'doc_polish', '需要我把译文改得更通顺吗？', '润色译文使其符合中文表达习惯。'),
    B('explain', '解释词句', 'code_explain', '这句外文看不懂？我给你讲一遍。', '解释语法与含义。'),
  ]),
  P('deepl', 'DeepL', 'ai', ['deepl.exe'], [
    B('translate', '翻译', 'translate', '需要我翻译这段内容吗？', '翻译成中文。'),
    B('polish', '润色译文', 'doc_polish', '需要我把译文改得更通顺吗？', '润色译文。'),
    B('explain', '解释词句', 'code_explain', '这句外文看不懂？我给你讲一遍。', '解释含义。'),
  ]),
  P('youdao', '有道词典', 'ai', ['youdao.exe', 'youdaodict.exe'], [
    B('dict', '解释这个词', 'dict_lookup', '需要我解释这个词吗？', '给出释义、例句与常见搭配。'),
    B('translate', '翻译句子', 'translate', '需要我翻译这个句子吗？', '翻译成中文。'),
    B('note', '整理生词', 'learning_note', '需要我把这些生词整理成单词本吗？', '整理成表格：单词 / 释义 / 例句。'),
  ]),

  // ---------------- 游戏 ----------------
  P('steam', 'Steam', 'game', ['steam.exe', 'steamwebhelper'], GAME_BEHAVIORS),
  P('wegame', 'WeGame', 'game', ['wegame.exe'], GAME_BEHAVIORS),
  P('epic', 'Epic Games', 'game', ['epicgameslauncher.exe'], GAME_BEHAVIORS),
  P('genshin', '原神', 'game', ['yuanshen.exe', 'genshinimpact.exe'], GAME_BEHAVIORS),
  P('starrail', '崩坏：星穹铁道', 'game', ['starrail.exe', 'hkrpg.exe'], GAME_BEHAVIORS),
  P('wuthering', '鸣潮', 'game', ['wuwa.exe', 'wutheringwaves.exe'], GAME_BEHAVIORS),
  P('lol', '英雄联盟', 'game', ['leagueclient.exe', 'league of legends.exe'], GAME_BEHAVIORS),
  P('valorant', '无畏契约', 'game', ['valorant.exe', 'valorant-win64-shipping.exe'], GAME_BEHAVIORS),
  P('naraka', '永劫无间', 'game', ['naraka.exe', 'naraka_bladepoint.exe'], GAME_BEHAVIORS),
  P('delta', '三角洲行动', 'game', ['deltaforce.exe', 'deltaforceclient.exe'], GAME_BEHAVIORS),
  P('cs2', 'CS2', 'game', ['cs2.exe'], GAME_BEHAVIORS),
  P('dota2', 'Dota 2', 'game', ['dota2.exe'], GAME_BEHAVIORS),
  P('pubg', '绝地求生', 'game', ['tslgame.exe', 'pubg.exe'], GAME_BEHAVIORS),
  P('wow', '魔兽世界', 'game', ['wow.exe', 'wowclassic.exe'], GAME_BEHAVIORS),
  P('ff14', '最终幻想14', 'game', ['ffxiv.exe', 'ffxiv_dx11.exe'], GAME_BEHAVIORS),
  P('minecraft', '我的世界', 'game', ['minecraft.exe', 'minecraftlauncher.exe'], GAME_BEHAVIORS),
  P('gta5', 'GTA5', 'game', ['gta5.exe', 'gtav.exe'], GAME_BEHAVIORS),
  P('eldenring', '艾尔登法环', 'game', ['eldenring.exe', 'start_protected_game.exe'], GAME_BEHAVIORS),
  P('monsterhunter', '怪物猎人', 'game', ['monsterhunterworld.exe', 'monsterhunterrise.exe'], GAME_BEHAVIORS),
  P('civ6', '文明6', 'game', ['civilizationvi.exe'], GAME_BEHAVIORS),
  P('hearthstone', '炉石传说', 'game', ['hearthstone.exe'], GAME_BEHAVIORS),
  P('eggparty', '蛋仔派对', 'game', ['eggparty.exe', 'danzaiparty.exe'], GAME_BEHAVIORS),
  P('roblox', 'Roblox', 'game', ['robloxplayerbeta.exe', 'roblox.exe'], GAME_BEHAVIORS),
];

/** 游戏类兜底：只靠窗口类名识别的常见引擎窗口。 */
const GAME_FALLBACK = P('game-generic', '游戏', 'game', [], GAME_BEHAVIORS, [
  'unitywndclass', 'unrealwindow', 'sdl_app', 'valve001', 'cocos2dxwin32', 'cryengine', 'gamemaker',
]);

/** exe 归一化：去路径、去扩展名、小写。 */
function normalizeExe(exeName) {
  const raw = String(exeName || '').trim().toLowerCase();
  if (!raw) return '';
  const base = raw.split(/[\\/]/).pop() || '';
  return base.replace(/\.exe$/, '');
}

/** 建立 exe → profile 的精确索引。 */
function buildExeIndex(profiles) {
  const map = new Map();
  for (const p of profiles) {
    for (const e of p.exe) {
      const key = normalizeExe(e);
      if (!key) continue;
      // 先出现的优先（表内顺序即优先级）
      if (!map.has(key)) map.set(key, p);
    }
  }
  return map;
}

const EXE_INDEX = buildExeIndex(APP_PROFILES);

/**
 * 查找应用画像。
 * 匹配优先级：exe 精确 → exe 包含（取最长命中，片段 ≥4 字符）→ 窗口类名 → 游戏引擎类名兜底。
 *
 * @param {{exeName?:string,windowClass?:string,title?:string}} wi
 * @returns {{profile:object, match:string}|null}
 */
function lookupApp(wi) {
  const wi0 = wi || {};
  const exe = normalizeExe(wi0.exeName);
  if (exe) {
    const exact = EXE_INDEX.get(exe);
    if (exact) return { profile: exact, match: 'exe' };
    // 包含匹配：只对 ≥4 字符的片段生效，且取最长命中，避免 qq 吃 qqbrowser
    let best = null;
    let bestLen = 0;
    for (const p of APP_PROFILES) {
      for (const e of p.exe) {
        const key = normalizeExe(e);
        if (key.length < 4) continue;
        if (!exe.includes(key)) continue;
        // 长度差过大（如 chromehelper 命中 chrome）仍然接受，但短命中让位于长命中
        if (key.length > bestLen) { bestLen = key.length; best = p; }
      }
    }
    if (best) return { profile: best, match: 'exe-partial' };
  }
  const wc = String(wi0.windowClass || '').trim().toLowerCase();
  if (wc) {
    for (const p of APP_PROFILES) {
      if (p.winClass && p.winClass.some((c) => c && wc.includes(c))) return { profile: p, match: 'winclass' };
    }
    if (GAME_FALLBACK.winClass.some((c) => wc.includes(c))) return { profile: GAME_FALLBACK, match: 'game-engine' };
  }
  return null;
}

/**
 * 取一个画像的行为列表（数组副本）。游戏类恒为攻略/过程/任务三件套。
 */
function behaviorsOf(profile) {
  if (!profile || !Array.isArray(profile.behaviors)) return [];
  return profile.behaviors.map((b) => Object.assign({}, b));
}

/** 按 id 取单个行为。 */
function behaviorById(profile, behaviorId) {
  if (!profile || !Array.isArray(profile.behaviors)) return null;
  const b = profile.behaviors.find((x) => x.id === behaviorId);
  return b ? Object.assign({}, b) : null;
}

/** 是否游戏类。 */
function isGame(profile) {
  return Boolean(profile && profile.category === 'game');
}

/** 类别中文名（面板展示用）。 */
const CATEGORY_LABEL = {
  office: '办公文档',
  browser: '浏览器',
  im: '通讯邮件',
  dev: '开发工具',
  design: '设计媒体',
  tool: '系统工具',
  ai: 'AI 学习',
  game: '游戏',
};

module.exports = {
  INTENT_META,
  APP_PROFILES,
  GAME_BEHAVIORS,
  GAME_FALLBACK,
  CATEGORY_LABEL,
  lookupApp,
  behaviorsOf,
  behaviorById,
  isGame,
  normalizeExe,
};
