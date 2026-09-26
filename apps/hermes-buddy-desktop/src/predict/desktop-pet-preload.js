'use strict';

/**
 * 桌宠窗口 preload：只暴露只读事件通道，无 Node 能力、无远端访问。
 * v4.5：不再用 -webkit-app-region: drag（会吞鼠标事件导致菜单弹不出），
 * 拖动/点击全部手动判定后经 IPC 交给主进程：
 *   - pet:click      点击（左/右键）→ 主进程弹菜单
 *   - pet:drag-move  拖动（相对窗口初始位置的偏移）→ 主进程 setPosition
 *   - pet:hover      鼠标是否悬停在角色上 → 主进程切换点击穿透
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petApi', {
  click: () => ipcRenderer.send('pet:click'),
  context: () => ipcRenderer.send('pet:context'),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  dragMove: (dx, dy) => ipcRenderer.send('pet:drag-move', Math.round(dx), Math.round(dy)),
  // v4.12.5b：拖动聚合埋点（松手时一次性上报）
  dragTrace: (data) => ipcRenderer.send('pet:drag-trace', data),
  // v4.7：渲染层错误上报（只写日志，便于排查）；暂停动画（省电）
  error: (msg) => ipcRenderer.send('pet:error', String(msg || '')),
  onPaused: (handler) => ipcRenderer.on('pet:paused', (_e, v) => { try { handler(v); } catch (_) {} }),
  onSpeak: (handler) => ipcRenderer.on('pet:speak', (_e, text) => { try { handler(text); } catch (_) {} }),
  onWave: (handler) => ipcRenderer.on('pet:wave', (_e) => { try { handler(); } catch (_) {} }),
});
