'use strict';

/**
 * 语音采集窗 preload：只暴露采集命令通道与结果回传，无 Node/文件能力。
 * 采集窗是一个常驻隐藏的 file:// 窗口，专门在可靠上下文里跑 getUserMedia + MediaRecorder，
 * 避免桌宠那种透明置顶 overlay 窗口在权限/媒体上下文上的不确定性。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vc', {
  // 主进程 → 采集窗：start / stop / probe
  onCommand: (handler) => ipcRenderer.on('vc:cmd', (_e, p) => { try { handler(p || {}); } catch (_) {} }),
  // 采集窗 → 主进程
  reportState: (s) => ipcRenderer.send('vc:state', s),
  reportError: (e) => ipcRenderer.send('vc:error', e),
  reportCaptured: (payload) => ipcRenderer.send('vc:captured', payload),
});
