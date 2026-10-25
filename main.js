/* ============================================================================
 * 异环钢琴模拟器 —— Electron 主进程
 *
 * 职责：
 *   1. 创建窗口；注册 app:// 特权协议（standard + supportFetchAPI），
 *      渲染进程用普通 fetch()/decodeAudioData 加载本地音频，避开 file:// CORS。
 *      - 开发态：app://root/* → 项目根目录
 *      - 打包态：renderer 等代码读 app.asar 内（fs 对 asar 透明），
 *                assets 读安装目录 resources/assets（由 package.json 的
 *                build.extraResources 复制，见 README「打包」一节）
 *   2. 全局热键：F8 播放/暂停、F9 停止（窗口失焦也可用）。
 *   3. IPC：选择 .mid 文件对话框 + 二进制读取（中文路径安全，不经 URL 编码）。
 * ==========================================================================*/
const { app, BrowserWindow, globalShortcut, ipcMain, dialog, protocol, screen } = require('electron');
const path = require('path');
const fs = require('fs');
/* 演奏模式引擎（koffi FFI）。加载失败时优雅降级为不可用，不影响练习模式。 */
let perf;
try {
  perf = require('./perf-main.js');
} catch (err) {
  perf = { available: false, init() { }, stopIfRunning() { } };
  console.warn('[perf] 演奏模式引擎加载失败：', err.message);
}

const isDev = !app.isPackaged;

/* 测试隔离档案：绕开共享 userData 的单实例锁（YIHUAN_TEST_PROFILE=1 时启用） */
if (process.env.YIHUAN_TEST_PROFILE) {
  app.setPath('userData', require('node:os').tmpdir() + '\\yihuan-test-profile');
}

/* 必须在 app ready 之前注册特权协议 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* app://root/<相对路径> → 实际文件路径
 * 打包态：renderer/** 在 asar 里（files 配置），assets/** 在 resourcesPath（extraResources） */
function resolveAppPath(url) {
  const rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
  const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, ''); // 防目录穿越
  if (safeRel.startsWith('assets') || safeRel.startsWith('demo')) {
    const base = isDev ? __dirname : process.resourcesPath;
    return path.join(base, safeRel);
  }
  return path.join(__dirname, safeRel); // asar 内文件 fs 可直接读
}

function createWindow() {
  /* 自测模式：隐藏窗口 + 禁用后台节流（防止人为交互污染与定时器降频） */
  const testMode = process.argv.includes('--selftest') || process.argv.includes('--perftest');
  /* 目标 1320×1180，按主屏工作区收缩；内容高度自适应（fit-window-height）兜底 */
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: Math.min(1320, area.width - 24),
    height: Math.min(1180, area.height - 40),
    minWidth: 1024,
    minHeight: 760,
    title: '异环钢琴模拟器',
    backgroundColor: '#eef0f4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: !testMode,
    },
  });
  if (testMode) {
    /* 自测窗口移到屏幕外：不节流、能收消息，且不会被人为点击干扰 */
    win.once('ready-to-show', () => win.setPosition(-3000, 0));
  }
  /* 彻底移除菜单栏：Alt 键无菜单可弹（此前 Alt 误触会让 File/Edit 菜单栏
   * 闪现，且随后 Ctrl+字母被当作菜单快捷键误触），从根上消灭此类问题 */
  win.setMenu(null);

  /* 冒烟自检：electron . --selftest [--midipath=<绝对路径>]
   * 演奏模式闭环自检：electron . --perftest
   * 渲染层自检结果经 console 输出（配合 --enable-logging 捕获）。 */
  const url = new URL('app://root/renderer/index.html');
  if (process.argv.includes('--selftest')) {
    url.searchParams.set('selftest', '1');
    const midiArg = process.argv.find((a) => a.startsWith('--midipath='));
    if (midiArg) url.searchParams.set('midipath', midiArg.slice('--midipath='.length));
  }
  if (process.argv.includes('--perftest')) {
    url.searchParams.set('perftest', '1');
  }
  if (process.env.YIHUAN_AUTOPLAY && /teachtest|risertest|teachshot|mincheck/.test(process.env.YIHUAN_AUTOPLAY)) {
    /* 自测类 URL：标题完成后自动退出（防测试实例残留占锁） */
    win.webContents.on('page-title-updated', (_e, title) => {
      if (String(title).endsWith('-done')) setTimeout(() => app.quit(), 1200);
    });
  }
  if (process.env.YIHUAN_AUTOPLAY) { /* 测试：注入 URL 查询串 */
    for (const [k, v] of new URLSearchParams(process.env.YIHUAN_AUTOPLAY)) url.searchParams.set(k, v);
    /* 窗口状态轮询：区分 最小化/最大化/还原 */
    setInterval(() => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) {
        const b = w.getBounds();
        console.log(`[wstate] min=${w.isMinimized()} max=${w.isMaximized()} fs=${w.isFullScreen()} vis=${w.isVisible()} bounds=${b.x},${b.y},${b.width}x${b.height}`);
      }
    }, 500);
  }
  win.loadURL(url.toString());
  if (isDev && process.env.OPEN_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  /* 自检模式：渲染层把标题置为 *-done 后自动退出（避免测试实例残留占用单实例锁） */
  if (process.argv.includes('--selftest') || process.argv.includes('--perftest')) {
    win.webContents.on('page-title-updated', (_e, title) => {
      if (String(title).endsWith('-done')) setTimeout(() => app.quit(), 1500);
    });
  }
  return win;
}

/* 单实例锁：提权重启的新实例带 --wait-lock，等旧实例退出释放锁（最多 20s）；
 * 普通二次启动保持立即退出。 */
async function mainWithLock() {
  let gotLock = app.requestSingleInstanceLock();
  if (!gotLock && process.argv.includes('--wait-lock')) {
    console.log('[lock] 等待旧实例退出（最多 20s）…');
    const born = Date.now();
    while (!(gotLock = app.requestSingleInstanceLock()) && Date.now() - born < 20000) {
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('[lock] 等待结束，gotLock=' + gotLock);
  }
  if (!gotLock) {
    app.quit();
    return;
  }
  runApp();
}
mainWithLock();

function runApp() {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle('app', async (request) => {
      try {
        const filePath = resolveAppPath(request.url);
        const data = fs.readFileSync(filePath); // fs 对 asar 内路径透明
        return new Response(data, {
          headers: { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' },
        });
      } catch (err) {
        console.error('[app://] 404', request.url, err.message);
        return new Response('not found', { status: 404 });
      }
    });

    createWindow();

    /* ---- 演奏模式（Win32 按键注入 + 高精度调度）---- */
    perf.init(ipcMain, () => BrowserWindow.getAllWindows()[0]);
    ipcMain.handle('perf-self-hwnd', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return 0;
      const buf = win.getNativeWindowHandle(); // Buffer，小端 HWND（x64 为 8 字节）
      return Number(buf.readBigUInt64LE(0));
    });

    /* 内容高度自适应：渲染层量出页面实际高度后请求调整窗口。
     * · 最大化/全屏时跳过（对最大化窗口调尺寸会触发系统"还原"，看起来像被最小化）；
     * · 防抖：目标与当前差 ≤6px 不调整（页面是 height:100% 布局，内容高度会跟随
     *   窗口——无条件 +4 会造成每次调用长高一点的死循环）。 */
    ipcMain.handle('fit-window-height', (_e, contentHeight) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || !Number.isFinite(contentHeight)) return { ok: false };
      if (win.isMaximized() || win.isFullScreen()) return { ok: true, skipped: 'maximized' };
      const area = screen.getPrimaryDisplay().workArea;
      const desired = Math.max(720, Math.min(Math.ceil(contentHeight), area.height - 44));
      const [contentW, contentH] = win.getContentSize();
      if (Math.abs(desired - contentH) <= 6) return { ok: true, skipped: 'stable' };
      try {
        win.setContentSize(contentW, desired);
        return { ok: true, target: desired };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    /* ---- 全局热键（失焦可用）。注册失败不致命，渲染层有窗口内兜底 ---- */
    const send = (key) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('global-hotkey', key);
    };
    for (const [accel, key] of [['F8', 'F8'], ['F9', 'F9']]) {
      const ok = globalShortcut.register(accel, () => send(key));
      if (!ok) console.warn(`[hotkey] ${accel} 注册失败（可能被其他程序占用），将退化为窗口内热键`);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => { perf.stopIfRunning(); globalShortcut.unregisterAll(); });
  app.on('window-all-closed', () => app.quit());
}

/* ------------------------------- IPC ------------------------------- */

ipcMain.handle('pick-midi', async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const res = await dialog.showOpenDialog(win, {
    title: '选择 MIDI 文件',
    filters: [
      { name: 'MIDI 文件', extensions: ['mid', 'midi', 'rmi'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return { path: res.filePaths[0], name: path.basename(res.filePaths[0]) };
});

ipcMain.handle('read-midi', (_e, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return { ok: true, data: buf }; // Buffer 经结构化克隆 → 渲染层 Uint8Array
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* 渲染层启动时获取可用音色列表（扫描 assets/audio 下各音色子目录的 manifest.json） */
ipcMain.handle('list-instruments', () => {
  const base = isDev ? path.join(__dirname, 'assets', 'audio')
                     : path.join(process.resourcesPath, 'assets', 'audio');
  const out = [];
  try {
    for (const dir of fs.readdirSync(base)) {
      const full = path.join(base, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      let name = dir;
      try {
        name = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8')).name || dir;
      } catch { /* 无 manifest 用目录名 */ }
      const count = fs.readdirSync(full).filter((f) => f.endsWith('.mp3')).length;
      if (count > 0) out.push({ id: dir, name, samples: count });
    }
  } catch (err) {
    console.error('[instruments] 扫描失败', err.message);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
});

/* 自测：写 dataURL（canvas 截图）到文件 */
ipcMain.handle('write-data', (_e, { path: p, data }) => {
  try {
    const b64 = String(data).replace(/^data:[^;]+;base64,/, '');
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* 自测截图：capturePage 存 PNG */
ipcMain.handle('capture-page', async (_e, { path: p }) => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const img = await win.webContents.capturePage();
    fs.writeFileSync(p, img.toPNG());
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* 导出文本文件（键盘谱等）：系统保存对话框 + 写文件 */
ipcMain.handle('save-text', async (_e, { defaultName, content }) => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const res = await dialog.showSaveDialog(win, {
      title: '导出键盘谱',
      defaultPath: defaultName,
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* ---------------- 曲库（收藏夹） ----------------
 * 导入的 MIDI 复制一份到 userData/library/，源文件删除/移动不影响曲库。
 * library.json 为索引：{entries:[{id,title,fileName,path,addedAt,categories,meta}]}。 */
const libDir = () => path.join(app.getPath('userData'), 'library');
const libIndexFile = () => path.join(libDir(), 'library.json');

function libReadIndex() {
  try {
    return JSON.parse(fs.readFileSync(libIndexFile(), 'utf8')) || { entries: [] };
  } catch {
    return { entries: [] };
  }
}
function libWriteIndex(idx) {
  fs.mkdirSync(libDir(), { recursive: true });
  fs.writeFileSync(libIndexFile(), JSON.stringify(idx, null, 2));
}

ipcMain.handle('library-list', () => ({ ok: true, entries: libReadIndex().entries }));

ipcMain.handle('library-add', (_e, { srcPath, title, meta, categories }) => {
  try {
    fs.mkdirSync(libDir(), { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const safe = String(title || 'untitled').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const dest = path.join(libDir(), `${id}_${safe}.mid`);
    fs.copyFileSync(srcPath, dest); // 复制源文件进曲库
    const entry = {
      id, title: title || '未命名',
      fileName: path.basename(dest), path: dest,
      addedAt: Date.now(), categories: Array.isArray(categories) ? categories : [],
      meta: meta || {},
    };
    const idx = libReadIndex();
    idx.entries.unshift(entry);
    libWriteIndex(idx);
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* 按字节入库（内置曲目种子用；渲染层 fetch assets/builtin 后传入） */
ipcMain.handle('library-add-data', (_e, { data, title, meta, categories }) => {
  try {
    fs.mkdirSync(libDir(), { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const safe = String(title || 'untitled').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const dest = path.join(libDir(), `${id}_${safe}.mid`);
    fs.writeFileSync(dest, Buffer.from(data));
    const entry = {
      id, title: title || '未命名',
      fileName: path.basename(dest), path: dest,
      addedAt: Date.now(), categories: Array.isArray(categories) ? categories : [],
      meta: meta || {},
    };
    const idx = libReadIndex();
    idx.entries.unshift(entry);
    libWriteIndex(idx);
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('library-update', (_e, { id, title, categories }) => {
  try {
    const idx = libReadIndex();
    const entry = idx.entries.find((en) => en.id === id);
    if (!entry) return { ok: false, error: '条目不存在' };
    if (typeof title === 'string' && title.trim()) entry.title = title.trim().slice(0, 80);
    if (Array.isArray(categories)) entry.categories = categories.filter((c) => typeof c === 'string' && c.length <= 12).slice(0, 3);
    libWriteIndex(idx);
    return { ok: true, entries: idx.entries };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('library-remove', (_e, { id }) => {
  try {
    const idx = libReadIndex();
    const entry = idx.entries.find((en) => en.id === id);
    if (entry && entry.path) {
      try { fs.unlinkSync(entry.path); } catch { /* 文件可能已不存在 */ }
    }
    idx.entries = idx.entries.filter((en) => en.id !== id);
    libWriteIndex(idx);
    return { ok: true, entries: idx.entries };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
