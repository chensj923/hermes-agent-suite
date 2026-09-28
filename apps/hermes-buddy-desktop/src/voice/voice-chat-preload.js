// v4.12.23：语音对话小窗 preload —— 只暴露会话事件订阅与关闭
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vc', {
  onSession: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('buddy:voice:session', (_e, evt) => { try { cb(evt); } catch (_) {} });
  },
  // 朗读音频（内联 data URL 的 WAV）直接在小窗里播
  onPlay: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('buddy:voice:play', (_e, payload) => { try { cb(payload); } catch (_) {} });
  },
  hide: () => { ipcRenderer.send('buddy:voice-chat:hide'); },
});
