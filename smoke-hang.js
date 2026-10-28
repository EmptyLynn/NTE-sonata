const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = 'D:\JOY\异环钢琴模拟器Zcode\hang-out.txt';
const lines = [];
const t0 = Date.now();
const ts = () => '+' + (Date.now() - t0) + 'ms';
app.whenReady().then(async () => {
  lines.push(ts() + ' app ready');
  const win = new BrowserWindow({ width: 1400, height: 950, show: true, webPreferences: {} });
  win.webContents.on('console-message', (_e, level, message) => {
    lines.push(ts() + ' [console] ' + message.slice(0, 160));
  });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  lines.push(ts() + ' loaded');
  await new Promise(r => setTimeout(r, 6000));
  // 探测挂起点：音色下拉、瀑布流画布、IPC 状态
  const probe = await win.webContents.executeJavaScript(`(async function(){
    var out = {};
    out.instSelText = (document.getElementById('inst-sel') || {}).textContent || 'missing';
    out.vizW = (function(){ var c = document.getElementById('viz'); return c ? c.width : -1; })();
    out.zoom = document.getElementById('app').style.zoom || 'none';
    // IPC 探针：主进程还响应吗？
    var ipcOk = 'pending';
    try { ipcOk = await Promise.race([ window.yihuan.listInstruments().then(function(r){ return 'ipc-ok ' + (r || []).length + ' 音色'; }), new Promise(function(r){ setTimeout(function(){ r('IPC-TIMEOUT'); }, 3000); }) ]); } catch (e) { ipcOk = 'IPC-ERR ' + e.message; }
    out.ipc = ipcOk;
    return out;
  })()`);
  lines.push('PROBE ' + JSON.stringify(probe));
  fs.writeFileSync(OUT, lines.join('\n'));
  app.quit();
}).catch(e => { lines.push('FATAL ' + e.message); fs.writeFileSync(OUT, lines.join('\n')); app.quit(); });
