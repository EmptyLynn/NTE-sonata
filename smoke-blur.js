const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 950, show: true, webPreferences: {} });
  await win.loadFile(path.join(__dirname, 'renderer/index.html'));
  await new Promise(r => setTimeout(r, 700));
  await win.webContents.executeJavaScript("(function(){ try { localStorage.setItem('yihuan.tour.done.v1', JSON.stringify({ practice: 1 })); if (window.Tour) Tour.done = { practice: 1 }; } catch (e) {} return 1; })()");
  await new Promise(r => setTimeout(r, 1100));
  // 练习模式截图
  var s1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'blur-practice.png'), s1.toPNG());
  // 切演奏模式（面板展开 + fitWindowHeight 重排）
  await win.webContents.executeJavaScript("(function(){ Perf.setActive(true); return 'perf'; })()");
  await new Promise(r => setTimeout(r, 900));
  var s2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'blur-perf.png'), s2.toPNG());
  // 量化：文字渲染锐度无法直接测，但可以测布局指标 + transform 状态
  const m = await win.webContents.executeJavaScript("(function(){ var app = document.getElementById('app'); var pp = document.getElementById('perf-panel'); return { transform: app.style.transform || 'none', perfPanelVisible: pp && !pp.classList.contains('hidden'), winSize: window.innerWidth + 'x' + window.innerHeight, dpr: window.devicePixelRatio }; })()");
  fs.writeFileSync(path.join(__dirname, 'blur-info.txt'), JSON.stringify(m));
  app.quit();
}).catch(e => { console.log('ERR ' + e.message); app.quit(); });
