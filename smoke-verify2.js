const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = 'D:\\tmpbuild\\smoke-results.json';
const results = {};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 950, show: true, webPreferences: {} });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 700));
  await win.webContents.executeJavaScript("(function(){ try { localStorage.setItem('yihuan.tour.done.v1', JSON.stringify({ practice: 1 })); if (window.Tour) Tour.done = { practice: 1 }; } catch (e) {} return 1; })()");
  await new Promise(r => setTimeout(r, 1100));
  results.loaded = true;

  // ── A. 模糊：练习 vs 演奏 截图 + fitScale 状态 ──
  var s1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'm-practice.png'), s1.toPNG());
  await win.webContents.executeJavaScript("(function(){ Perf.setActive(true); return 1; })()");
  await new Promise(r => setTimeout(r, 900));
  var s2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'm-perf.png'), s2.toPNG());
  results.fitScale = await win.webContents.executeJavaScript("(function(){ var app = document.getElementById('app'); var cv = document.getElementById('viz'); return { transform: app.style.transform || 'none', canvasCssW: cv.style.width, canvasBackingW: cv.width, vizRectW: Math.round(document.getElementById('viz-wrap').getBoundingClientRect().width) }; })()");
  // 退出演奏（回练习）
  await win.webContents.executeJavaScript("(function(){ Perf.setActive(false); return 1; })()");
  await new Promise(r => setTimeout(r, 500));

  // ── B. 钢琴演奏短按：chords 不含 durs + worker 事件 durMs ──
  const midiB64 = fs.readFileSync(path.join(__dirname, '测试用midi', '朋友的酒.mid')).toString('base64');
  await win.webContents.executeJavaScript(`(async function(){
    var bin = atob('${midiB64}');
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    UI.loadSong(buf.buffer, 'test');
    await new Promise(function(r){ setTimeout(r, 200); });
  })()`);
  results.pianoChordsHaveDurs = await win.webContents.executeJavaScript("(function(){ UI.switchInstrumentType('piano'); Perf.rebuild(); return Perf.chords.some(function(c){ return Array.isArray(c.durs); }); })()");
  results.pianoFirstChord = await win.webContents.executeJavaScript("JSON.stringify(Perf.chords[0] && Object.keys(Perf.chords[0]))");
  results.guitarChordsHaveDurs = await win.webContents.executeJavaScript("(function(){ UI.switchInstrumentType('guitar'); Perf.rebuild(); var r = Perf.chords.some(function(c){ return Array.isArray(c.durs) && c.durs.length; }); UI.switchInstrumentType('piano'); return r; })()");

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  app.quit();
}).catch(e => {
  fs.writeFileSync(OUT, JSON.stringify({ fatal: e.message }));
  app.quit();
});
