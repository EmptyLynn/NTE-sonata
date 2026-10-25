/* ============================================================================
 * 演奏模式调度 worker —— 独立线程，事件循环保持存活
 *
 *  · 自调度 setTimeout 链（步进 ≤25ms，按绝对锚点校正）：worker 的消息
 *    （pause/resume/stop）可即时处理——注意不能用同步 Atomics 循环占死线程，
 *    否则消息永远进不来；
 *  · 和弦内部 ≤40ms 的修饰键时序用 Atomics.wait 短等待（仅阻塞本 worker，
 *    主进程与界面完全不受影响）。
 * ==========================================================================*/
const { parentPort } = require('worker_threads');
const ffi = require('./perf-ffi.js');

const _gate = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) { Atomics.wait(_gate, 0, 0, ms); }
function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }

const S = {
  running: false, paused: false, stop: false,
  sid: 0,
  chords: [], idx: 0,
  anchorMs: 0, offsetMs: 0,
  hwnd: 0, mode: 'bg', holdMs: 8,
  lastProgress: 0, fgWarned: false,
  timer: null,
};

function post(msg) { try { parentPort.postMessage(msg); } catch { /* 主进程退出中 */ } }

function startPlay(p) {
  S.sid = p.sid || 0;
  S.chords = p.chords || [];
  S.timeline = p.timeline || null;
  S.hwnd = Number(p.hwnd);
  S.mode = p.mode === 'fg' ? 'fg' : 'bg';
  S.holdMs = Math.max(2, Math.min(120, p.holdMs | 0 || 35));
  S.offsetMs = Math.max(0, p.offset || 0) * 1000;
  S.idx = 0;
  S.stop = false; S.paused = false; S.running = true;
  S.lastProgress = 0; S.fgWarned = false;
  while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
  S.anchorMs = nowMs() - S.offsetMs;
  if (S.mode === 'fg') {
    /* 仅做一次无害尝试；是否就位由用户点击游戏保证（弹窗引导 + 失焦自停兜底） */
    ffi.forceForeground(S.hwnd);
  }
  post({ type: 'started', sid: S.sid, chordCount: S.chords.length, startIdx: S.idx });
  if (S.timer) clearTimeout(S.timer);
  S.timer = setTimeout(scheduleNext, 0);
}

function scheduleNext() {
  if (S.stop || S.idx >= S.chords.length) return finish();
  if (S.paused) { S.timer = setTimeout(scheduleNext, 15); return; }
  const chord = S.chords[S.idx];
  const delay = (S.anchorMs + chord.t) - nowMs();
  if (delay > 2.5) {
    S.timer = setTimeout(scheduleNext, Math.min(delay - 1.5, 25));
    return;
  }
  /* 前台模式安全检查：游戏窗口失去焦点立即停止（真实按键会打进别的窗口） */
  if (S.mode === 'fg' && Number(ffi.F.GetForegroundWindow()) !== S.hwnd) {
    S.running = false;
    finish();
    post({ type: 'warn', msg: '前台模式：游戏窗口失去焦点，已自动停止演奏' });
    return;
  }
  try {
    ffi.executeChord(S.hwnd, chord.keys, chord.holdMs ?? S.holdMs, S.mode, sleep);
  } catch (err) {
    S.running = false;
    finish();
    post({ type: 'warn', msg: '和弦发送异常：' + (err.message || err) });
    return;
  }
  S.idx++;
  /* executeChord 若异常：报告并安全收尾，保住 worker（后续仍可演奏） */
  post({ type: 'note', sid: S.sid, idx: S.idx - 1, pitches: chord.pitches, holdMs: chord.holdMs ?? S.holdMs });
  const now = nowMs();
  if (now - S.lastProgress > 100) {
    S.lastProgress = now;
    post({ type: 'progress', sid: S.sid, t: (now - S.anchorMs) / 1000, idx: S.idx, total: S.chords.length });
  }
  if (S.idx >= S.chords.length) return finish();
  S.timer = setTimeout(scheduleNext, 0);
}

function finish() {
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  const finished = !S.stop && S.idx >= S.chords.length;
  S.running = false; S.paused = false;
  post({ type: 'ended', sid: S.sid, finished, played: S.idx });
}

parentPort.on('message', (m) => {
  if (!m || !m.type) return;
  if (m.type === 'play') {
    /* 永不拒绝：若仍在运行/暂停（如渲染层状态脱节），先静默收尾再启动 */
    if (S.running) {
      S.stop = true;
      S.running = false;
      if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    }
    startPlay(m);
  } else if (m.type === 'pause') {
    if (!S.running || S.paused) { post({ type: 'paused', t: S.offsetMs / 1000, already: true }); return; }
    S.paused = true;
    S.offsetMs = Math.max(0, nowMs() - S.anchorMs);
    post({ type: 'paused', t: S.offsetMs / 1000 });
  } else if (m.type === 'resume') {
    if (!S.running || !S.paused) return;
    S.paused = false;
    while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
    S.anchorMs = nowMs() - S.offsetMs;
    post({ type: 'resumed', t: S.offsetMs / 1000 });
  } else if (m.type === 'stop') {
    S.stop = true;
    S.running = false;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; finish(); }
  } else if (m.type === 'seek') {
    /* 进度跳转 = 原地重定基：会话不中断（播放中无缝跳、暂停中改锚点），
     * 跳过新位置之前的和弦，立即回报一次进度供界面同步 */
    if (S.stop) return;
    if (m.sid != null) S.sid = m.sid;
    S.offsetMs = Math.max(0, m.offsetMs || 0);
    while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
    S.anchorMs = nowMs() - S.offsetMs;
    S.lastProgress = 0;
    post({ type: 'progress', sid: S.sid, t: S.offsetMs / 1000, idx: S.idx, total: S.chords.length });
  } else if (m.type === 'rebase') {
    /* 热重定基：丝滑变速用——不停顿地替换剩余调度（如速度变更后的新时刻表） */
    if (!S.running || S.stop) return;
    S.chords = m.chords || S.chords;
    S.offsetMs = Math.max(0, m.offsetMs || 0);
    while (S.idx < S.chords.length && S.chords[S.idx].t < S.offsetMs) S.idx++;
    S.anchorMs = nowMs() - S.offsetMs;
    post({ type: 'rebased', t: S.offsetMs / 1000 });
  }
});
