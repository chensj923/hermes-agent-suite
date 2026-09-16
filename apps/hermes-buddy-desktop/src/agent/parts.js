'use strict';

/**
 * 多模态 parts 归一化。
 *
 * 渲染层/主进程组装的是「高层 parts」：
 *   { type: 'text',  text }                        纯文本
 *   { type: 'image', mime, data }                 图片（data = base64，不上传原始文件）
 *   { type: 'file',  name, mime, text }           文本文件（已读出的内容，内联给模型）
 *   { type: 'file',  name, mime, note }           二进制文件（无法读取，仅附说明）
 *   { type: 'audio', name, mime, transcript }     语音（本地 Whisper 转写后的文字）
 *   { type: 'video', name, mime, transcript, frames:[{mime,data}] }
 *                                                视频（本地抽音轨转写 + 关键帧图片）
 *
 * 注意：语音/视频在到达本模块之前，已由 media-preprocess 在 Win 端本地
 * 预处理成 text（转写）+ image（关键帧），所以最终只有 text / image / file
 * 三类需要归一成 OpenAI 的 content parts。原始音视频**不会**离开本机。
 *
 * 输出是 OpenAI 多模态消息的 content 数组，直连模式直接进 loop，
 * 通道模式原样发到服务端（服务端 run_task 直接 append）。
 */

/** 把单个图片 part 转成 data URL（优先用现成的 url，否则用 data base64）。 */
function imageUrl(part) {
  if (part.url) return String(part.url);
  if (part.data) return `data:${part.mime || 'image/png'};base64,${part.data}`;
  return null;
}

/**
 * 把高层 parts 归一成 OpenAI content 数组。
 * 返回 null 表示没有有效内容（调用方应回退到纯文本）。
 */
function partsToContent(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  const content = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'text': {
        const t = String(part.text == null ? '' : part.text).trim();
        if (t) content.push({ type: 'text', text: t });
        break;
      }
      case 'image': {
        const url = imageUrl(part);
        if (url) content.push({ type: 'image_url', image_url: { url } });
        break;
      }
      case 'file': {
        const name = part.name || '未命名文件';
        if (typeof part.text === 'string' && part.text.length) {
          // 文本文件：把内容直接内联，模型才能读到。
          content.push({ type: 'text', text: `【文件 ${name}】\n${part.text}` });
        } else {
          const note = part.note
            || `（文件 ${name}${part.mime ? '，类型 ' + part.mime : ''}：当前版本无法直接读取内容，仅附文件名供参考）`;
          content.push({ type: 'text', text: note });
        }
        break;
      }
      case 'audio': {
        // 本地转写后的语音：作为文本块送给模型（注明来源）。
        const t = String(part.transcript || part.text || '').trim();
        if (t) content.push({ type: 'text', text: `【语音 ${part.name || ''} 转写】\n${t}` });
        break;
      }
      case 'video': {
        // 本地抽音轨转写：作为文本块；关键帧作为图片。
        const t = String(part.transcript || part.text || '').trim();
        if (t) content.push({ type: 'text', text: `【视频 ${part.name || ''} 转写】\n${t}` });
        const frames = Array.isArray(part.frames) ? part.frames : [];
        for (const f of frames) {
          const url = imageUrl(f);
          if (url) content.push({ type: 'image_url', image_url: { url } });
        }
        break;
      }
      default:
        break;
    }
  }
  return content.length ? content : null;
}

/** 把文本兜底成 content 数组（无 parts 时的旧路径）。 */
function textToContent(text) {
  const t = String(text == null ? '' : text);
  return [{ type: 'text', text: t }];
}

/** 从 content 数组里抽出纯文本（用于本地历史/记忆的摘要，不丢图片信息但只留文字）。 */
function contentToPlainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

module.exports = { partsToContent, textToContent, contentToPlainText, imageUrl };
