/* ============================================================================
 * 演奏模式 —— 主进程入口
 *
 *  · 播放调度跑在独立 worker 线程（perf-worker.js）：精确时序不阻塞主进程，
 *    界面零卡顿；worker 消息转发给渲染层（perf-note/progress/ended/warn）；
 *  · 窗口枚举 / 测试按键 / 诊断 在主进程直接执行（FFI 公共层 perf-ffi.js）。
 * ==========================================================================*/
const path = require('path');
const { Worker } = require('worker_threads');
const { app } = require('electron');
const ffi = require('./perf-ffi.js');

let worker = null;
let getWin = null;
let sessionCounter = 0; /* 演奏会话自增 id：worker 全部回传事件盖章，渲染层据此丢弃旧会话事件 */
/* 请求-应答：pause/resume 需要等待 worker 回传权威状态 */
let pendingPause = null;
let pendingResume = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'perf-worker.js'));
  worker.on('message', (m) => {
    if (!m || !m.type) return;
    if (m.type === 'paused') {
      if (pendingPause) {
        pendingPause({ ok: true, state: m.already && m.t === 0 ? 'stopped' : 'paused', t: m.t });
        pendingPause = null;
      }
      return;
    }
    if (m.type === 'resumed') {
      if (pendingResume) { pendingResume({ ok: m.ok !== false, error: m.error, t: m.t }); pendingResume = null; }
      return;
    }
    const win = getWin && getWin();
    if (!win) return;
    if (m.type === 'note') {
      win.webContents.send('perf-note', { idx: m.idx, pitches: m.pitches, holdMs: m.holdMs, durMs: m.durMs, sid: m.sid });
    } else if (m.type === 'progress') {
      win.webContents.send('perf-progress', { t: m.t, idx: m.idx, total: m.total, sid: m.sid });
    } else if (m.type === 'ended') {
      win.webContents.send('perf-ended', { finished: m.finished, played: m.played, sid: m.sid });
    } else if (m.type === 'warn') {
      win.webContents.send('perf-warn', { msg: m.msg });
    } else if (m.type === 'started') {
      win.webContents.send('perf-started', m);
    } else if (m.type === 'error') {
      win.webContents.send('perf-warn', { msg: m.msg });
    }
  });
  const onDead = (why) => {
    console.error('[perf] worker 退出:', why);
    worker = null;
    /* 通知渲染层彻底复位（防状态机卡死在 playing） */
    const win = getWin && getWin();
    if (win) win.webContents.send('perf-ended', { finished: false, played: 0, crashed: true });
  };
  worker.on('error', (err) => onDead('异常 ' + err.message));
  worker.on('exit', (code) => { if (worker) onDead('code ' + code); });
  return worker;
}

module.exports = {
  available: true,

  init(ipcMain, winGetter) {
    getWin = winGetter;

    ipcMain.handle('perf-list-windows', () => {
      try {
        const windows = ffi.listWindows().filter((w) => w.title && w.title !== 'Program Manager');
        return { ok: true, windows, auto: ffi.findGameWindow() };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    /* 诊断：目标窗口状态 / 类名 / PostMessage 投递结果 / 建议 */
    ipcMain.handle('perf-diagnose', (_e, { hwnd }) => {
      try { return { ok: true, report: ffi.diagnose(hwnd) }; }
      catch (err) { return { ok: false, error: String(err.message || err) }; }
    });

    /* 测试和弦（短阻塞，直接在主进程执行） */
    ipcMain.handle('perf-test', (_e, { hwnd, mode }) => {
      try {
        if (!Number(hwnd) || !ffi.F.IsWindow(Number(hwnd))) {
          return { ok: false, error: '目标窗口无效' };
        }
        if (mode === 'fg') ffi.forceForeground(Number(hwnd));
        ffi.executeChord(Number(hwnd), ['z', 'c', 'v'], 12, mode || 'bg',
          (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    ipcMain.handle('perf-play', (_e, payload) => {
      try {
        const { chords, hwnd, mode, holdMs, offset } = payload;
        if (!chords || !chords.length) return { ok: false, error: '没有可演奏的音符' };
        if (!Number(hwnd) || !ffi.F.IsWindow(Number(hwnd))) {
          return { ok: false, error: '目标窗口无效（游戏关闭了？）' };
        }
        ensureWorker();
        const sid = Number(payload.sid) || ++sessionCounter;
        return new Promise((resolve) => {
          /* 等 worker 的 started 确认（500ms 超时兜底） */
          const onStarted = (m) => {
            if (m && m.type === 'started' && m.sid === sid) {
              worker.off('message', onStarted);
              clearTimeout(to);
              resolve({ ok: true, chordCount: m.chordCount, startIdx: m.startIdx, sid });
            }
          };
          const to = setTimeout(() => {
            worker.off('message', onStarted);
            resolve({ ok: false, error: '演奏引擎未响应' });
          }, 500);
          worker.on('message', onStarted);
          worker.postMessage({ type: 'play', chords, hwnd: Number(hwnd), mode, holdMs, offset, sid });
        });
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    ipcMain.handle('perf-pause', () => {
      if (!worker) return { ok: true, state: 'stopped' };
      return new Promise((resolve) => {
        pendingPause = (r) => { pendingPause = null; resolve(r); };
        setTimeout(() => {
          if (pendingPause) { pendingPause = null; resolve({ ok: true, state: 'stopped' }); }
        }, 500);
        worker.postMessage({ type: 'pause' });
      });
    });

    ipcMain.handle('perf-resume', () => {
      if (!worker) return { ok: false, error: '引擎未运行' };
      return new Promise((resolve) => {
        pendingResume = (r) => { pendingResume = null; resolve(r); };
        setTimeout(() => {
          if (pendingResume) { pendingResume = null; resolve({ ok: false, error: '恢复超时' }); }
        }, 500);
        worker.postMessage({ type: 'resume' });
      });
    });

    /* 权限状态 + 以管理员重启（UIPI：游戏以管理员运行时必须同样提权） */
    ipcMain.handle('perf-elevated', () => ffi.isElevated());
    ipcMain.handle('perf-relaunch-admin', () => {
      try {
        const exe = process.execPath;
        /* --wait-lock：新实例等待本实例退出释放单实例锁后再启动（否则会静默秒退） */
        const args = app.isPackaged ? '--wait-lock' : '"." --wait-lock';
        const dir = app.isPackaged ? path.dirname(exe) : process.cwd();
        /* ShellExecuteW('runas') 直调：触发 UAC 提权重启（PowerShell 方案在部分环境静默失败） */
        const ok = ffi.runAsAdmin(exe, args, dir);
        if (!ok) return { ok: false, error: '提权启动失败（UAC 被取消或系统拒绝）' };
        setTimeout(() => app.quit(), 1000);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    ipcMain.handle('perf-stop', () => {
      if (worker) worker.postMessage({ type: 'stop' });
      return { ok: true };
    });

    /* 进度跳转：重定基命令透传（携带渲染层纪元 id，worker 盖章回传） */
    ipcMain.handle('perf-seek', (_e, payload) => {
      if (!worker) return { ok: true };
      worker.postMessage({ type: 'seek', offsetMs: (payload.offset || 0) * 1000, sid: payload.sid });
      return { ok: true };
    });

    /* 热重定基：演奏中变速——替换剩余调度，不断音 */
    ipcMain.handle('perf-rebase', (_e, payload) => {
      if (!worker) return { ok: false, error: '引擎未运行' };
      return new Promise((resolve) => {
        let done = false;
        const onMsg = (m) => {
          if (m && m.type === 'rebased') {
            worker.off('message', onMsg);
            done = true;
            resolve({ ok: true, t: m.t });
          }
        };
        worker.on('message', onMsg);
        setTimeout(() => {
          if (!done) { worker.off('message', onMsg); resolve({ ok: false, error: '重定基超时' }); }
        }, 400);
        worker.postMessage({
          type: 'rebase',
          chords: payload.chords,
          offsetMs: (payload.offset || 0) * 1000,
        });
      });
    });
  },

  stopIfRunning() {
    if (worker) {
      worker.postMessage({ type: 'stop' });
    }
  },
};
