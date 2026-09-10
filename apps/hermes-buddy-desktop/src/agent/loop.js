'use strict';

const { describeBrainError } = require('./brain');

const DEFAULT_MAX_TURNS = 24;
// 同一个工具调用连续重复这么多次，基本可以断定模型在打转，及时止损。
const REPEAT_LIMIT = 3;

/**
 * 本地 ReAct 循环：模型出决策，工具在 Windows 上执行，结果回灌给模型。
 *
 * 关键点：整条链路里模型只拿到"文本"，拿不到任何 Node 对象，
 * 也永远不会知道工作区之外的路径长什么样。
 */
class AgentLoop {
  constructor({ brain, tools, workspace, logger, maxTurns = DEFAULT_MAX_TURNS }) {
    if (!brain) throw new Error('缺少 brain');
    if (!tools) throw new Error('缺少 tools');
    this.brain = brain;
    this.tools = tools;
    this.workspace = workspace;
    this.logger = logger || { info() {}, warn() {}, error() {}, debug() {} };
    this.maxTurns = maxTurns;
  }

  /**
   * @param {object} options
   * @param {string} options.systemPrompt
   * @param {Array} options.history 之前的对话（OpenAI 消息格式）
   * @param {string} options.userMessage
   * @param {AbortSignal} [options.signal]
   * @param {(event:object)=>void} [options.onEvent]
   * @param {(request:object)=>Promise<boolean>} [options.onConfirm]
   * @returns {Promise<{ text: string, turns: number, toolCalls: Array, stopped?: string }>}
   */
  async run({ systemPrompt, history = [], userMessage, signal, onEvent, onConfirm, stream = true }) {
    const emit = (event) => { if (typeof onEvent === 'function') onEvent(event); };
    const messages = [
      { role: 'system', content: String(systemPrompt || '') },
      ...history.filter((item) => item && item.role !== 'system'),
      { role: 'user', content: String(userMessage || '') }
    ];

    const toolSchemas = this.tools.schemas();
    const trace = [];
    let finalText = '';
    let turns = 0;
    let stopped = null;

    if (signal && signal.aborted) {
      emit({ type: 'error', message: '已停止' });
      return { text: '', turns: 0, toolCalls: trace, stopped: 'aborted' };
    }

    while (turns < this.maxTurns) {
      turns += 1;
      emit({ type: 'status', text: '思考中…', turn: turns });

      let result;
      try {
        result = await this.brain.complete({
          messages,
          tools: toolSchemas,
          signal,
          stream,
          onText: (chunk) => emit({ type: 'text', text: chunk })
        });
      } catch (error) {
        const message = describeBrainError(error);
        this.logger.warn('loop-brain-failed', { code: error.code, error: error.message });
        emit({ type: 'error', message });
        throw error;
      }

      if (result.content) {
        finalText = result.content;
        emit({ type: 'text', text: result.content, final: true });
      }

      const calls = result.toolCalls || [];
      if (!calls.length) {
        // 没有工具调用 = 这一轮就是答复。
        emit({ type: 'done', text: finalText, turns });
        return { text: finalText, turns, toolCalls: trace, stopped };
      }

      // 把模型的工具意图原样记进上下文，否则下一轮它不知道自己做了什么。
      messages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) }
        }))
      });

      for (const call of calls) {
        if (signal && signal.aborted) {
          emit({ type: 'done', text: finalText, turns, interrupted: true });
          return { text: finalText, turns, toolCalls: trace, stopped: 'aborted' };
        }

        const started = Date.now();
        emit({ type: 'tool_start', id: call.id, name: call.name, args: call.arguments });

        const outcome = await this.tools.invoke(call.name, call.arguments, {
          signal,
          onConfirm: (request) => (typeof onConfirm === 'function'
            ? onConfirm({ ...request, tool: call.name, id: call.id })
            : Promise.resolve(false))
        });

        const durationMs = Date.now() - started;
        const record = { id: call.id, name: call.name, args: call.arguments, ok: outcome.ok, durationMs, text: outcome.text };
        trace.push(record);
        emit({ type: 'tool_result', ...record });

        if (outcome.blocked) {
          // 告诉模型这条路被规则挡住了，让它换方案而不是继续撞墙。
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `被安全规则拦截，未执行：${outcome.text}。请改用其它方式完成任务，或向用户说明无法执行。`
          });
          continue;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text || '（无输出）' });
      }

      const repeat = detectRepeat(trace);
      if (repeat) {
        stopped = 'repeated';
        this.logger.warn('loop-repeat-detected', { name: repeat });
        emit({ type: 'notice', message: `检测到重复调用「${repeat}」多次，已停止自动执行` });
        break;
      }
    }

    if (!stopped && turns >= this.maxTurns) {
      stopped = 'max_turns';
      emit({ type: 'notice', message: `已达到单轮最大步数（${this.maxTurns}），停止自动执行` });
    }

    // 被打断/撞墙时，让模型不带工具地收个尾：否则用户只看到一串工具调用，没有结论。
    if (stopped && stopped !== 'aborted') {
      messages.push({
        role: 'user',
        content: '请停止继续调用工具，用文字总结：你做了什么、当前进展到哪一步、还缺什么信息或需要用户做什么决定。'
      });
      try {
        const wrapUp = await this.brain.complete({
          messages,
          tools: [],
          signal,
          stream,
          onText: (chunk) => emit({ type: 'text', text: chunk })
        });
        if (wrapUp.content) finalText = `${finalText}\n\n${wrapUp.content}`.trim();
      } catch (error) {
        // 收尾失败不算致命，已经有工具产出可以交代。
        this.logger.warn('loop-wrapup-failed', { error: error.message });
      }
    }

    emit({ type: 'done', text: finalText, turns, stopped });
    return { text: finalText, turns, toolCalls: trace, stopped };
  }
}

/** 找出连续重复的工具调用签名，只关心"名字 + 参数"完全一样的情况。 */
function detectRepeat(trace) {
  if (trace.length < REPEAT_LIMIT) return null;
  const tail = trace.slice(-REPEAT_LIMIT);
  const signature = JSON.stringify({ name: tail[0].name, args: tail[0].args });
  if (tail.every((item) => JSON.stringify({ name: item.name, args: item.args }) === signature)) return tail[0].name;
  return null;
}

module.exports = { AgentLoop, detectRepeat, DEFAULT_MAX_TURNS, REPEAT_LIMIT };
