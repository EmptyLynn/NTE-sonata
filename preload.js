/* 预加载脚本：以受控方式向渲染层暴露主进程能力（contextIsolation 安全桥） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yihuan', {
  isElectron: true,
  pickMidiFile: () => ipcRenderer.invoke('pick-midi'),
  readMidiFile: (filePath) => ipcRenderer.invoke('read-midi', filePath),
  listInstruments: () => ipcRenderer.invoke('list-instruments'),
  onGlobalHotkey: (cb) => ipcRenderer.on('global-hotkey', (_e, key) => cb(key)),
  /* 曲库 */
  libraryList: () => ipcRenderer.invoke('library-list'),
  libraryAdd: (srcPath, title, meta, categories) => ipcRenderer.invoke('library-add', { srcPath, title, meta, categories }),
  libraryAddData: (data, title, meta, categories) => ipcRenderer.invoke('library-add-data', { data, title, meta, categories }),
  libraryUpdate: (id, title, categories) => ipcRenderer.invoke('library-update', { id, title, categories }),
  libraryRemove: (id) => ipcRenderer.invoke('library-remove', { id }),
  /* 演奏模式（游戏内自动弹奏） */
  perfListWindows: () => ipcRenderer.invoke('perf-list-windows'),
  perfDiagnose: (hwnd) => ipcRenderer.invoke('perf-diagnose', { hwnd }),
  perfTest: (hwnd, mode) => ipcRenderer.invoke('perf-test', { hwnd, mode }),
  perfPlay: (payload) => ipcRenderer.invoke('perf-play', payload),
  perfPause: () => ipcRenderer.invoke('perf-pause'),
  perfResume: () => ipcRenderer.invoke('perf-resume'),
  perfStop: () => ipcRenderer.invoke('perf-stop'),
  perfRebase: (chords, offset) => ipcRenderer.invoke('perf-rebase', { chords, offset }),
  perfSeek: (offset, sid) => ipcRenderer.invoke('perf-seek', { offset, sid }),
  perfSelfHwnd: () => ipcRenderer.invoke('perf-self-hwnd'),
  fitWindowHeight: (h) => ipcRenderer.invoke('fit-window-height', h),
  saveText: (defaultName, content) => ipcRenderer.invoke('save-text', { defaultName, content }),
  capturePage: (path) => ipcRenderer.invoke('capture-page', { path }),
  writeData: (path, data) => ipcRenderer.invoke('write-data', { path, data }),
  perfElevated: () => ipcRenderer.invoke('perf-elevated'),
  perfRelaunchAdmin: () => ipcRenderer.invoke('perf-relaunch-admin'),
  onPerfEvent: (cb) => {
    ipcRenderer.on('perf-note', (_e, d) => cb('note', d));
    ipcRenderer.on('perf-progress', (_e, d) => cb('progress', d));
    ipcRenderer.on('perf-ended', (_e, d) => cb('ended', d));
    ipcRenderer.on('perf-warn', (_e, d) => cb('warn', d));
    ipcRenderer.on('perf-started', (_e, d) => cb('started', d));
  },
});
