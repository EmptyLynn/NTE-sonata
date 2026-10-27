const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 950, show: true, webPreferences: {} });
  await win.loadFile('renderer/index.html');
  console.log('LOADED');
  await new Promise(r => setTimeout(r, 2500));
  console.log('SURVIVED-2.5s');
  app.quit();
}).catch(e => { console.log('ERR ' + e.message); app.quit(); });
